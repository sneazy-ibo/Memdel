import {
    Output,
    StreamTarget,
    BufferTarget,
    CanvasSource,
    AudioSampleSource,
    getFirstEncodableAudioCodec,
    type OutputFormat,
    type VideoCodec,
    type Quality,
    type QualityLevel
} from 'mediabunny';
import { CONTAINERS, type ContainerName } from './containers';
import { acquireAudioTap, describeAudioReady, resumeTappedAudio, type AudioTap } from './audio';
import { attachAudioTap, type AudioFeed } from './audio-feed';
import { VideoClock } from './video-clock';
import {
    canvasFitOptions,
    createLogger,
    dedupeErrors,
    downloadBlob,
    findEncodableVideoCodec,
    generateOutputFilename,
    onVisibilityChange,
    toEven,
    toQuality,
    webCodecsSupported
} from './utils';
import {
    DEFAULT_AUDIO_QUALITY,
    DEFAULT_CONTAINER,
    DEFAULT_FPS,
    DEFAULT_VIDEO_QUALITY,
    type ConfigOverrides,
    type MediaCaptureConfig
} from './constants';

/**
 * - `'auto'`: use filesystem if supported, silently fall back to memory
 * - `'filesystem'`: always use filesystem, throws if unsupported
 * - `'memory'`: always buffer in memory and trigger a download on stop
 */
export type SaveMode = 'auto' | 'filesystem' | 'memory';

// 2 MB keeps syscall overhead negligible while limiting what an abrupt tab death loses.
const STREAM_CHUNK_BYTES = 2_000_000;

export interface RecorderConfig extends MediaCaptureConfig {
    saveMode?: SaveMode;
}

export type RecorderConfigOverrides = ConfigOverrides<RecorderConfig>;

/**
 * Records a canvas (and optionally an `AudioNode`) to a file, either streaming
 * straight to disk or buffering and downloading on stop.
 *
 * @example
 * const recorder = new Recorder(canvas, { audioNode: masterGain });
 * await recorder.start();
 * await recorder.stop();
 */
export class Recorder {
    /** Whether the File System Access API is available. */
    static get filesystemSupported(): boolean {
        return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
    }

    static get isSupported(): boolean {
        return webCodecsSupported();
    }

    canvas: HTMLCanvasElement;
    fps: number;
    container: ContainerName;
    videoQuality: Quality;
    audioQuality: Quality;
    bitrateMode: 'constant' | 'variable';
    saveMode: SaveMode;
    name: string;
    audioNode: boolean | AudioNode | null;
    onLog: ((message: string) => void) | null;
    debug: boolean;

    private readonly _log: (message: string, level?: 'error') => void;

    // --- Callbacks ---
    onStart: (() => void) | null = null;
    onStop: ((result: { duration: number; size: number }) => void) | null = null;
    onPause: (() => void) | null = null;
    onResume: (() => void) | null = null;

    // --- Recording state ---
    private _active = false;
    private _paused = false;
    private _liveBytes = 0;

    // --- Mediabunny pipeline ---
    private _target: StreamTarget | BufferTarget | null = null;
    private _fileHandle: FileSystemFileHandle | null = null;
    private _directoryHandle: FileSystemDirectoryHandle | null = null;
    private _stopVisibilityWatch: (() => void) | null = null;

    // Encoder output size, kept even. The video source letterboxes the canvas into it.
    private _encodeWidth = 0;
    private _encodeHeight = 0;
    // Raw `videoQuality` input, kept so `bitrateMode` can be (re)applied to
    // quality levels.
    private _videoQualityInput: number | QualityLevel | Quality;

    private _output: Output | null = null;
    private _videoSource: CanvasSource | null = null;
    private _frameClock: VideoClock | null = null;
    private _audioSource: AudioSampleSource | null = null;
    private _audioTap: AudioTap | null = null;
    private _audioFeed: AudioFeed | null = null;

    constructor(canvas: HTMLCanvasElement, options: RecorderConfig = {}) {
        this.canvas = canvas;

        // --- Config ---
        this.fps = options.fps ?? DEFAULT_FPS;
        this.container = options.container ?? DEFAULT_CONTAINER;
        this.bitrateMode = options.bitrateMode ?? 'variable';
        this.videoQuality = toQuality(
            options.videoQuality ?? DEFAULT_VIDEO_QUALITY,
            this.bitrateMode
        );
        this._videoQualityInput = options.videoQuality ?? DEFAULT_VIDEO_QUALITY;
        this.audioQuality = toQuality(options.audioQuality ?? DEFAULT_AUDIO_QUALITY);
        this.saveMode = options.saveMode ?? 'auto';
        this.name = options.name ?? '';

        this.audioNode = options.audioNode ?? null;

        this.onLog = options.onLog ?? null;
        this.debug = options.debug ?? false;

        this._log = createLogger(this.onLog, this.debug);
    }

    get recording(): boolean {
        return this._active;
    }

    get paused(): boolean {
        return this._paused;
    }

    /** Elapsed recording time excluding pauses, in milliseconds. 0 when idle. */
    get elapsedMs(): number {
        return this._frameClock?.elapsedMs ?? 0;
    }

    /**
     * Live byte count written to the output so far, tracked via the target's
     * `write` event. Includes container overhead and works in both buffer and
     * filesystem mode. Resets on each `start()`.
     */
    get bytesWritten(): number {
        return this._liveBytes;
    }

    /**
     * The name of the currently selected recording directory, or null if none.
     * Note: browsers expose only the folder name, not the full path.
     */
    get directoryName(): string | null {
        return this._directoryHandle?.name ?? null;
    }

    /** Update config between recordings (throws while recording). */
    configure(overrides: RecorderConfigOverrides = {}): void {
        const { fps, container, videoQuality, audioQuality, bitrateMode, saveMode, audioNode } =
            overrides;
        if (this._active) throw new Error('Cannot configure while recording.');
        if (fps !== undefined) this.fps = fps;
        if (container !== undefined) {
            if (!CONTAINERS[container]) throw new Error(`Unsupported container "${container}".`);
            this.container = container;
        }
        if (videoQuality !== undefined) {
            this._videoQualityInput = videoQuality;
            this.videoQuality = toQuality(videoQuality, this.bitrateMode);
        }
        if (bitrateMode !== undefined) {
            this.bitrateMode = bitrateMode;
            this.videoQuality = toQuality(this._videoQualityInput, bitrateMode);
        }
        if (audioQuality !== undefined) this.audioQuality = toQuality(audioQuality);
        if (saveMode !== undefined) this.saveMode = saveMode;
        if (audioNode !== undefined) this.audioNode = audioNode;
    }

    /**
     * Prompts the user to pick a recordings directory. Only needs to be
     * called once because the handle persists for the page's lifetime.
     */
    async setRecordingDirectory(): Promise<FileSystemDirectoryHandle> {
        if (!Recorder.filesystemSupported)
            throw new Error('File System Access API is not supported in this browser.');
        this._directoryHandle = await window.showDirectoryPicker({
            mode: 'readwrite'
        });
        return this._directoryHandle;
    }

    clearRecordingDirectory(): void {
        this._directoryHandle = null;
    }

    pause(): void {
        if (!this._active) throw new Error('Not recording.');
        if (this._paused) return;
        this._paused = true;
        this._frameClock?.pause();
        this._audioFeed?.notifyPause(true);
        this._log('Recording paused');
        this.onPause?.();
    }

    resume(): void {
        if (!this._active) throw new Error('Not recording.');
        if (!this._paused) return;
        this._frameClock?.resume();
        this._paused = false;
        this._audioFeed?.notifyPause(false);
        this._log('Recording resumed');
        this.onResume?.();
    }

    async start(): Promise<void> {
        if (this._active) throw new Error('Already recording.');
        // Best effort: wake a context parked by autoplay while still in the caller's gesture.
        void resumeTappedAudio();

        this._encodeWidth = toEven(this.canvas.width);
        this._encodeHeight = toEven(this.canvas.height);
        this._liveBytes = 0;
        this._fileHandle = null;
        this._paused = false;

        const useFilesystem =
            this.saveMode === 'filesystem' ||
            (this.saveMode === 'auto' && this._directoryHandle != null);
        const containerDef = CONTAINERS[this.container];
        if (!containerDef) throw new Error(`Unsupported container "${this.container}".`);
        const outputFormat = new containerDef.Format(
            useFilesystem ? containerDef.streaming : containerDef.buffer
        );
        this._target = useFilesystem
            ? new StreamTarget(await this._openFileWritable(), {
                  chunked: true,
                  chunkSize: STREAM_CHUNK_BYTES
              })
            : new BufferTarget();
        this._output = new Output({
            format: outputFormat,
            target: this._target
        });
        this._target.on('write', ({ end }) => {
            this._liveBytes = Math.max(this._liveBytes, end);
        });

        const [codec] = await Promise.all([
            this._initVideo(outputFormat),
            this._initAudio(outputFormat)
        ]);

        await this._output!.start();

        this._frameClock!.start();

        // Feed only after the output started. add() before that is rejected
        if (this._audioTap && this._audioSource) {
            this._audioFeed = attachAudioTap(
                this._audioTap,
                this._audioSource,
                () => this._paused,
                (message) => this._log(message, 'error'),
                this._frameClock!.originMs
            );
        }

        // Debounced to avoid false positives when the tab is briefly hidden (e.g. opening DevTools)
        this._stopVisibilityWatch = onVisibilityChange({
            onHidden: () => {
                if (this._active) void this.stop().catch(() => {});
            }
        });

        this._active = true;

        this.onStart?.();

        this._log(
            `Recording started - codec: ${codec}, fps: ${this.fps}, resolution: ${this._encodeWidth}x${this._encodeHeight}`
        );
    }

    /**
     * @returns `duration` in milliseconds, `size` in bytes
     */
    async stop(): Promise<{ duration: number; size: number }> {
        if (!this._active) throw new Error('Not recording.');
        this._active = false;
        this._paused = false;
        this._stopVisibilityWatch?.();
        this._stopVisibilityWatch = null;

        // Stop feeding, then let the queued buffers land before finalizing
        const feed = this._audioFeed;
        this._audioFeed = null;
        feed?.detach();
        await feed?.drain();
        const duration = this._frameClock?.elapsedMs ?? 0;
        this._frameClock?.stop();
        this._frameClock = null;
        this._videoSource?.close();
        this._audioSource?.close();
        if (this._output) await this._output.finalize();

        // Disconnect after finalize so the last packets land first
        this._disconnectAudio();
        if (feed) this._log(`Audio feed: ${feed.describe()}`);

        let size: number;
        if (this._fileHandle) {
            const file = await this._fileHandle.getFile();
            size = file.size;
        } else {
            const buffer = this._target instanceof BufferTarget ? this._target.buffer : null;
            const blob = new Blob([buffer ?? new ArrayBuffer(0)], {
                type: this._output?.format.mimeType
            });
            size = blob.size;
            downloadBlob(blob, generateOutputFilename(this.name, this.container));
        }

        const result = { duration, size };
        this.onStop?.(result);
        return result;
    }

    private async _initVideo(outputFormat: OutputFormat): Promise<VideoCodec> {
        const choice = await findEncodableVideoCodec(outputFormat.getSupportedVideoCodecs(), {
            width: this._encodeWidth,
            height: this._encodeHeight,
            quality: this.videoQuality
        });
        if (!choice) throw new Error('No supported video codec found.');

        const videoSource = new CanvasSource(this.canvas, {
            codec: choice.codec,
            quality: this.videoQuality,
            latencyMode: choice.latencyMode,
            ...canvasFitOptions(this.canvas, this._encodeWidth, this._encodeHeight)
        });
        this._videoSource = videoSource;
        this._output!.addVideoTrack(videoSource, { frameRate: this.fps });

        // A broken encoder rethrows the same frame error every tick. Log it once.
        this._frameClock = new VideoClock({
            fps: this.fps,
            onFrame: (ts, duration) => videoSource.add(ts, duration),
            onError: dedupeErrors(this._log, 'Video frame error: ')
        });

        return choice.codec;
    }

    private async _initAudio(outputFormat: OutputFormat): Promise<void> {
        if (!this.audioNode) return;

        const bestAudioCodec = await getFirstEncodableAudioCodec(
            outputFormat.getSupportedAudioCodecs(),
            { quality: this.audioQuality }
        );
        if (!bestAudioCodec) return;

        this._audioTap = acquireAudioTap(this.audioNode, this._log);
        if (!this._audioTap) return;

        this._audioSource = new AudioSampleSource({
            codec: bestAudioCodec,
            quality: this.audioQuality
        });
        this._output!.addAudioTrack(this._audioSource);

        this._log(describeAudioReady(bestAudioCodec, this._audioTap));
    }

    private async _openFileWritable(): Promise<FileSystemWritableFileStream> {
        if (!this._directoryHandle)
            throw new Error('No recording directory set. Call setRecordingDirectory() first.');

        const handle = await this._directoryHandle.getFileHandle(
            generateOutputFilename(this.name, this.container),
            {
                create: true
            }
        );
        this._fileHandle = handle;
        return handle.createWritable();
    }

    private _disconnectAudio(): void {
        this._audioTap?.disconnect();
        this._audioTap = null;
        this._audioSource = null;
    }
}
