import {
    Output,
    StreamTarget,
    BufferTarget,
    MediaStreamVideoTrackSource,
    MediaStreamAudioTrackSource,
    getFirstEncodableVideoCodec,
    getFirstEncodableAudioCodec,
    type OutputFormat,
    type VideoCodec,
    type Quality,
    type QualityLevel,
    type EncodedPacket
} from 'mediabunny';
import { CONTAINERS, type ContainerName } from './containers';
import {
    downloadBlob,
    onVisibilityChange,
    tapAudioNode,
    type AudioTap,
    generateOutputFilename,
    createLogger,
    toQuality
} from './utils';

/**
 * - `'auto'` — use filesystem if supported, silently fall back to memory
 * - `'filesystem'` — always use filesystem, throws if unsupported
 * - `'memory'` — always buffer in memory and trigger a download on stop
 */
export type SaveMode = 'auto' | 'filesystem' | 'memory';

export interface RecorderConfig {
    fps?: number;
    /** Output container format. */
    container?: ContainerName;
    /**
     * A target bitrate in bits/sec (positive integer), a qualitative level
     * ("very-low"|"low"|"medium"|"high"|"very-high"), or a mediabunny `Quality` instance.
     */
    videoQuality?: number | QualityLevel | Quality;
    /** Same shape as `videoQuality`. */
    audioQuality?: number | QualityLevel | Quality;
    saveMode?: SaveMode;
    /**
     * The node to tap for audio (e.g. a master gain/bus node). Omit to record
     * video only. Its own context (`node.context`) is used for capture.
     */
    audioNode?: AudioNode;
    /** Filename template, supports `YYYY`/`MM`/`DD`/`HH`/`mm`/`ss`, falls back to a timestamped name. */
    name?: string;
    /** Called with internal diagnostic messages. */
    onLog?: (message: string) => void;
    /** If true and `onLog` isn't provided, logs to console.debug. */
    debug?: boolean;
}

export type RecorderConfigOverrides = Partial<
    Pick<
        RecorderConfig,
        'fps' | 'container' | 'videoQuality' | 'audioQuality' | 'saveMode' | 'audioNode'
    >
>;

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

    /** Whether this browser supports the APIs Recorder needs at all. */
    static get isSupported(): boolean {
        return (
            typeof window !== 'undefined' &&
            'VideoEncoder' in window &&
            typeof HTMLCanvasElement.prototype.captureStream === 'function'
        );
    }

    canvas: HTMLCanvasElement;
    fps: number;
    container: ContainerName;
    videoQuality: Quality;
    audioQuality: Quality;
    saveMode: SaveMode;
    name: string;
    audioNode: AudioNode | null;
    onLog: ((message: string) => void) | null;
    debug: boolean;

    _log: (message: string, level?: 'error') => void;

    // --- Callbacks ---
    onStart: (() => void) | null = null;
    onVideoPacket:
        ((packet: EncodedPacket, meta: EncodedVideoChunkMetadata | undefined) => void) | null =
        null;
    onAudioPacket:
        ((packet: EncodedPacket, meta: EncodedAudioChunkMetadata | undefined) => void) | null =
        null;
    onStop: ((result: { duration: number; size: number }) => void) | null = null;
    onPause: (() => void) | null = null;
    onResume: (() => void) | null = null;

    // --- Recording state ---
    private _active = false;
    private _paused = false;
    private _startTime = 0;
    private _pausedAccum = 0;
    private _pauseStartedAt = 0;
    private _liveBytes = 0;

    // --- Mediabunny pipeline ---
    private _target: StreamTarget | BufferTarget | null = null;
    private _fileHandle: FileSystemFileHandle | null = null;
    private _directoryHandle: FileSystemDirectoryHandle | null = null;
    private _stopVisibilityWatch: (() => void) | null = null;

    // Evenly rounded encode size, the video source letterboxes into this box
    private _encodeWidth = 0;
    private _encodeHeight = 0;

    private _output: Output | null = null;
    private _outputFormat: OutputFormat | null = null;
    private _captureStream: MediaStream | null = null;
    private _videoSource: MediaStreamVideoTrackSource | null = null;
    private _audioSource: MediaStreamAudioTrackSource | null = null;
    private _audioTap: AudioTap | null = null;

    videoDecoderConfig: {
        codec: string;
        codedWidth: number;
        codedHeight: number;
    } | null = null;
    audioDecoderConfig: {
        codec: string;
        sampleRate: number;
        numberOfChannels: number;
    } | null = null;

    constructor(canvas: HTMLCanvasElement, options: RecorderConfig = {}) {
        this.canvas = canvas;

        // --- Config ---
        this.fps = options.fps ?? 60;
        this.container = options.container ?? 'mp4';
        this.videoQuality = toQuality(options.videoQuality ?? 'high');
        this.audioQuality = toQuality(options.audioQuality ?? 'very-high');
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
        const { fps, container, videoQuality, audioQuality, saveMode, audioNode } = overrides;
        if (this._active) throw new Error('Cannot configure while recording.');
        if (fps !== undefined) this.fps = fps;
        if (container !== undefined) {
            if (!CONTAINERS[container]) throw new Error(`Unsupported container "${container}".`);
            this.container = container;
        }
        if (videoQuality !== undefined) this.videoQuality = toQuality(videoQuality);
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
        this._pauseStartedAt = performance.now();
        this._videoSource?.pause();
        this._audioSource?.pause();
        this._log('Recording paused');
        this.onPause?.();
    }

    resume(): void {
        if (!this._active) throw new Error('Not recording.');
        if (!this._paused) return;
        this._pausedAccum += performance.now() - this._pauseStartedAt;
        this._videoSource?.resume();
        this._audioSource?.resume();
        this._paused = false;
        this._log('Recording resumed');
        this.onResume?.();
    }

    async start(): Promise<void> {
        if (this._active) throw new Error('Already recording.');

        // Dimensions have to be even, with & ~1 the odd bits are cleared
        this._encodeWidth = this.canvas.width & ~1;
        this._encodeHeight = this.canvas.height & ~1;
        this._liveBytes = 0;
        this._fileHandle = null;
        this._paused = false;
        this._pausedAccum = 0;

        const useFilesystem =
            this.saveMode === 'filesystem' ||
            (this.saveMode === 'auto' && this._directoryHandle != null);
        const containerDef = CONTAINERS[this.container];
        if (!containerDef) throw new Error(`Unsupported container "${this.container}".`);
        const outputFormat = new containerDef.Format(
            useFilesystem ? containerDef.streaming : containerDef.buffer
        );
        this._outputFormat = outputFormat;
        this._target = useFilesystem
            ? new StreamTarget(await this._openFileWritable(), {
                  chunked: true,
                  chunkSize: 2_000_000
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

        // Debounced to avoid false positives when the tab is briefly hidden (e.g. opening DevTools)
        this._stopVisibilityWatch = onVisibilityChange({ onHidden: () => this.stop() }, 750);

        this._active = true;
        this._startTime = performance.now();

        this.onStart?.();

        this._log(
            `Recording started - codec: ${codec}, fps: ${this.fps}, resolution: ${this._encodeWidth}x${this._encodeHeight}`
        );
    }

    /**
     * @returns `duration` in seconds, `size` in bytes
     */
    async stop(): Promise<{ duration: number; size: number }> {
        if (!this._active) throw new Error('Not recording.');
        this._active = false;
        this._paused = false;
        this._stopVisibilityWatch?.();
        this._stopVisibilityWatch = null;

        this._videoSource?.close();
        this._audioSource?.close();
        if (this._output) await this._output.finalize();
        this._captureStream?.getVideoTracks().forEach((t) => t.stop());
        this._captureStream = null;

        // Disconnect after finalize to make sure the last packets land before disconnecting
        this._disconnectAudio();

        const duration = performance.now() - this._startTime - this._pausedAccum;

        let size: number;
        if (this._fileHandle) {
            const file = await this._fileHandle.getFile();
            size = file.size;
        } else {
            const buffer = this._target instanceof BufferTarget ? this._target.buffer : null;
            const blob = new Blob([buffer ?? new ArrayBuffer(0)], {
                type: this._outputFormat?.mimeType
            });
            size = blob.size;
            downloadBlob(blob, generateOutputFilename(this.name, this.container));
        }

        const result = { duration, size };
        this.onStop?.(result);
        return result;
    }

    /** Selects the best video codec and sets up the capture stream video source. */
    private async _initVideo(outputFormat: OutputFormat): Promise<VideoCodec> {
        const bestVideoCodec = await getFirstEncodableVideoCodec(
            outputFormat.getSupportedVideoCodecs(),
            {
                width: this._encodeWidth,
                height: this._encodeHeight,
                quality: this.videoQuality
            }
        );
        if (!bestVideoCodec) throw new Error('No supported video codec found.');

        this._captureStream = this.canvas.captureStream(this.fps);
        const [videoTrack] = this._captureStream.getVideoTracks();

        this._videoSource = new MediaStreamVideoTrackSource(videoTrack, {
            codec: bestVideoCodec,
            quality: this.videoQuality,
            contentHint: 'motion',
            // Letterbox into the initial resolution prevents stretching on resize
            sizeChangeBehavior: 'contain',
            transform: {
                width: this._encodeWidth,
                height: this._encodeHeight,
                fit: 'contain'
            },
            onEncodedPacket: (pkt, meta) => {
                this.onVideoPacket?.(pkt, meta);
            }
        });
        this._output!.addVideoTrack(this._videoSource, { frameRate: this.fps });

        this._videoSource.errorPromise.catch((err) => {
            this._log(`Video source error: ${err?.message ?? err}`, 'error');
        });

        this.videoDecoderConfig = {
            codec: bestVideoCodec,
            codedWidth: this._encodeWidth,
            codedHeight: this._encodeHeight
        };
        return bestVideoCodec;
    }

    /** Selects the best audio codec and taps the provided audio node. */
    private async _initAudio(outputFormat: OutputFormat): Promise<void> {
        if (!this.audioNode) return;

        const bestAudioCodec = await getFirstEncodableAudioCodec(
            outputFormat.getSupportedAudioCodecs()
        );
        if (!bestAudioCodec) return;

        this._audioTap = tapAudioNode(this.audioNode);
        if (!this._audioTap) return;

        this._audioSource = new MediaStreamAudioTrackSource(this._audioTap.track, {
            codec: bestAudioCodec,
            quality: this.audioQuality,
            onEncodedPacket: (pkt, meta) => {
                this.onAudioPacket?.(pkt, meta);
            }
        });
        this._output!.addAudioTrack(this._audioSource);

        this._audioSource.errorPromise.catch((err) => {
            this._log(`Audio source error: ${err?.message ?? err}`, 'error');
        });

        const { sampleRate } = this._audioTap.ctx;
        const { channelCount } = this._audioTap;
        this.audioDecoderConfig = {
            codec: bestAudioCodec,
            sampleRate,
            numberOfChannels: channelCount
        };

        this._log(
            `Audio ready (codec: ${bestAudioCodec}, sampleRate: ${sampleRate}, channels: ${channelCount})`
        );
    }

    /** Opens a writable stream for a new file in the selected recording directory. */
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
    }
}
