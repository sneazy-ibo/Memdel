import {
    Output,
    StreamTarget,
    BufferTarget,
    CanvasSource,
    MediaStreamAudioTrackSource,
    Quality,
    getEncodableVideoCodecs,
    getEncodableAudioCodecs
} from 'mediabunny';
import { CONTAINERS } from './containers.js';
import { downloadBlob, onHiddenDebounced, tapAudioNode, generateFilename } from './utils.js';

/**
 * @typedef {import('mediabunny').QualityLevel} QualityLevel
 * @typedef {import('mediabunny').EncodedPacket} EncodedPacket
 */

/**
 * Numbers are treated as bitrates in bits/sec, strings are quality levels.
 * @param {number|QualityLevel|Quality} value
 * @returns {Quality}
 */
function toQuality(value) {
    if (value instanceof Quality) return value;
    if (typeof value === 'number') return new Quality({ bitrate: value });
    return new Quality(value);
}

/**
 * @typedef {'auto' | 'filesystem' | 'download'} SaveMode
 *
 * - `'auto'`       — use filesystem if supported, silently fall back to download
 * - `'filesystem'` — always use filesystem, throws if unsupported
 * - `'download'`   — always buffer in memory and trigger a download on stop
 *
 * @typedef {Object} RecorderConfig
 * @property {number}   [fps=60]
 * @property {'mp4' | 'mov' | 'webm' | 'mkv'} [container="mp4"] - Output container format.
 * @property {number|QualityLevel|Quality} [videoQuality="high"] - A target bitrate in bits/sec
 *   (positive integer), a qualitative level ("very-low"|"low"|"medium"|"high"|"very-high"), or
 *   a mediabunny `Quality` instance.
 * @property {number|QualityLevel|Quality} [audioQuality="very-high"] - Same shape as `videoQuality`.
 * @property {SaveMode} [saveMode="auto"]
 * @property {AudioNode} [audioNode] - The node to tap for audio (e.g. a master gain/bus node).
 *   Omit to record video only. Its own context (`node.context`) is used for capture.
 * @property {string} [name=""] - Filename template. See the `name` property below.
 * @property {(message: string) => void} [onLog] - Called with internal diagnostic messages.
 * @property {boolean} [debug=false] - If true and `onLog` isn't provided, logs to console.debug.
 */
export class Recorder {
    /** @returns {boolean} Whether the File System Access API is available. */
    static get filesystemSupported() {
        return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
    }

    /** @returns {boolean} Whether this browser supports the APIs Recorder needs at all. */
    static get isSupported() {
        return (
            typeof window !== 'undefined' &&
            'VideoEncoder' in window &&
            typeof HTMLCanvasElement.prototype.captureStream === 'function'
        );
    }

    /**
     * @param {HTMLCanvasElement} gameCanvas
     * @param {RecorderConfig} [options]
     */
    constructor(gameCanvas, options = {}) {
        this.gameCanvas = gameCanvas;

        // --- Config ---
        this.fps = options.fps ?? 60;
        /** @type {'mp4' | 'mov' | 'webm' | 'mkv'} */
        this.container = options.container ?? 'mp4';
        this.videoQuality = toQuality(options.videoQuality ?? 'high');
        this.audioQuality = toQuality(options.audioQuality ?? 'very-high');
        /** @type {SaveMode} */
        this.saveMode = options.saveMode ?? 'auto';
        this.name = options.name ?? '';

        this.audioNode = options.audioNode ?? null;

        this.onLog = options.onLog ?? null;
        this.debug = options.debug ?? false;

        // --- Callbacks ---
        /** @type {(() => void) | null} */
        this.onStart = null;
        /** @type {((packet: EncodedPacket, meta: EncodedVideoChunkMetadata | undefined) => void) | null} */
        this.onVideoPacket = null;
        /** @type {((packet: EncodedPacket, meta: EncodedAudioChunkMetadata | undefined) => void) | null} */
        this.onAudioPacket = null;
        /** @type {((result: { duration: number, size: number }) => void) | null} */
        this.onStop = null;
        /** @type {(() => void) | null} */
        this.onPause = null;
        /** @type {(() => void) | null} */
        this.onResume = null;

        // --- Recording state ---
        this._active = false;
        this._paused = false;
        this._startTime = 0;
        this._frameTimer = 0;
        this._lastFrameTime = 0;
        this._pausedAccum = 0;
        this._pauseStartedAt = 0;
        this._liveBytes = 0;
        /** @type {StreamTarget | BufferTarget | null} */
        this._target = null;
        /** @type {FileSystemFileHandle | null} */
        this._fileHandle = null;
        this._directoryHandle = null;
        this._stopVisibilityWatch = null;

        // Evenly rounded encode size, CanvasSource letterboxes into this box itself.
        this._encodeWidth = 0;
        this._encodeHeight = 0;

        // --- Mediabunny pipeline ---
        this._output = null;
        this._outputFormat = null;
        this._videoSource = null;
        this._audioSource = null;
        this._audioTap = null;

        this.videoDecoderConfig = null;
        this.audioDecoderConfig = null;
    }

    /** @returns {boolean} */
    get recording() {
        return this._active;
    }

    /** @returns {boolean} */
    get paused() {
        return this._paused;
    }

    /**
     * Live byte count of encoded data so far, `null` in filesystem mode
     * (data streams straight to disk). Final file is slightly larger due to
     * container overhead.
     * @returns {number|null}
     */
    get bytesWritten() {
        if (this._fileHandle) return null;
        return this._liveBytes;
    }

    /**
     * The name of the currently selected recording directory, or null if none.
     * Note: browsers expose only the folder name, not the full path.
     * @returns {string|null}
     */
    get directoryName() {
        return this._directoryHandle?.name ?? null;
    }

    /**
     * @typedef {Pick<RecorderConfig, 'fps' | 'container' | 'videoQuality' | 'audioQuality' | 'saveMode' | 'audioNode'>} RecorderConfigOverrides
     *
     * @param {RecorderConfigOverrides} [config]
     */
    configure({ fps, container, videoQuality, audioQuality, saveMode, audioNode } = {}) {
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
     * @returns {Promise<FileSystemDirectoryHandle>}
     */
    async setRecordingDirectory() {
        if (!Recorder.filesystemSupported)
            throw new Error('File System Access API is not supported in this browser.');
        this._directoryHandle = await window.showDirectoryPicker({
            mode: 'readwrite'
        });
        return this._directoryHandle;
    }

    pause() {
        if (!this._active) throw new Error('Not recording.');
        if (this._paused) return;
        this._paused = true;
        this._pauseStartedAt = performance.now();
        this._audioSource?.pause();
        this._log('Recording paused');
        this.onPause?.();
    }

    /**
     * Resumes a paused recording, offsetting timestamps by the pause gap so
     * there's no hole in the output.
     */
    resume() {
        if (!this._active) throw new Error('Not recording.');
        if (!this._paused) return;
        const pausedFor = performance.now() - this._pauseStartedAt;
        this._pausedAccum += pausedFor;
        this._frameTimer += pausedFor;
        this._lastFrameTime += pausedFor;
        this._audioSource?.resume();
        this._paused = false;
        this._log('Recording resumed');
        this.onResume?.();
    }

    async start() {
        if (this._active) throw new Error('Already recording.');

        // Dimensions have to be even, with & ~1 the odd bits are cleared
        this._encodeWidth = this.gameCanvas.width & ~1;
        this._encodeHeight = this.gameCanvas.height & ~1;
        this._liveBytes = 0;
        this._fileHandle = null;
        this._paused = false;
        this._pausedAccum = 0;

        // Filesystem mode streams through a WritableStream and needs an
        // append only container layout however buffer mode can use the compact one.
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

        await Promise.all([this._initVideo(outputFormat), this._initAudio(outputFormat)]);

        await this._output.start();

        // Debounced to avoid false positives when the tab is briefly hidden (e.g. opening DevTools)
        this._stopVisibilityWatch = onHiddenDebounced(() => this.stop(), 750);

        this._active = true;
        this._startTime = performance.now();
        this._frameTimer = this._startTime;
        this._lastFrameTime = this._startTime;
        this._frameLoop();

        this.onStart?.();

        this._log(
            `Recording started — codec: ${this.videoDecoderConfig.codec}, fps: ${this.fps}, resolution: ${this._encodeWidth}x${this._encodeHeight}`
        );
    }

    /**
     * @returns {Promise<{ duration: number, size: number }>}
     *   `duration` in seconds, `size` in bytes
     */
    async stop() {
        if (!this._active) throw new Error('Not recording.');
        this._active = false; // halt frame loop before async teardown
        this._paused = false;
        this._stopVisibilityWatch?.();
        this._stopVisibilityWatch = null;

        if (this._videoSource) this._videoSource.close();
        if (this._audioSource) this._audioSource.close();
        if (this._output) await this._output.finalize();

        // Disconnect after finalize to make sure the last packets land before disconnecting
        this._disconnectAudio();

        const duration = performance.now() - this._startTime - this._pausedAccum;

        let size;
        if (this._fileHandle) {
            const file = await this._fileHandle.getFile();
            size = file.size;
        } else {
            const blob = new Blob([/** @type {BufferTarget} */ (this._target).buffer], {
                type: this._outputFormat.mimeType
            });
            size = blob.size;
            downloadBlob(blob, this._generateFilename());
        }

        const result = { duration, size };
        this.onStop?.(result);
        return result;
    }

    /**
     * Resolves the output filename, falling back to a timestamped default when `name` is blank.
     * @returns {string}
     */
    _generateFilename() {
        const ext = this._outputFormat.fileExtension.replace(/^\./, '');
        return generateFilename(this.name, 'recording-YYYY-MM-DD_HH-mm-ss', ext);
    }

    /** @param {string} message */
    _log(message) {
        if (this.onLog) this.onLog(message);
        else if (this.debug) console.debug('[memdel]', message);
    }

    /**
     * Selects the best video codec, sets up the CanvasSource and videoDecoderConfig.
     * @param {import('mediabunny').OutputFormat} outputFormat
     */
    async _initVideo(outputFormat) {
        const availableVideoCodecs = await getEncodableVideoCodecs(
            outputFormat.getSupportedVideoCodecs(),
            {
                width: this._encodeWidth,
                height: this._encodeHeight,
                quality: this.videoQuality
            }
        );
        this._log(`Available video codecs: ${availableVideoCodecs.join(', ') || 'none'}`);

        const bestVideoCodec = availableVideoCodecs[0] ?? null;
        if (!bestVideoCodec) throw new Error('No supported video codec found.');

        this._videoSource = new CanvasSource(this.gameCanvas, {
            codec: bestVideoCodec,
            quality: this.videoQuality,
            latencyMode: 'realtime',
            contentHint: 'motion',
            // Stay in original box size (letterboxing)
            sizeChangeBehavior: 'contain',
            transform: {
                width: this._encodeWidth,
                height: this._encodeHeight
            },
            onEncodedPacket: (pkt, meta) => {
                this._liveBytes += pkt.byteLength;
                this.onVideoPacket?.(pkt, meta);
            }
        });
        this._output.addVideoTrack(this._videoSource, { frameRate: this.fps });

        this.videoDecoderConfig = {
            codec: bestVideoCodec,
            codedWidth: this._encodeWidth,
            codedHeight: this._encodeHeight
        };
    }

    /**
     * Selects the best audio codec and taps the caller-supplied audio node
     * @param {import('mediabunny').OutputFormat} outputFormat
     */
    async _initAudio(outputFormat) {
        if (!this.audioNode) return;

        const availableAudioCodecs = await getEncodableAudioCodecs(
            outputFormat.getSupportedAudioCodecs()
        );
        this._log(`Available audio codecs: ${availableAudioCodecs.join(', ') || 'none'}`);

        const bestAudioCodec = availableAudioCodecs[0] ?? null;
        if (!bestAudioCodec) return;

        this._audioTap = tapAudioNode(this.audioNode);
        const audioTrack = this._audioTap.track;
        if (!audioTrack) return;

        this._audioSource = new MediaStreamAudioTrackSource(audioTrack, {
            codec: bestAudioCodec,
            quality: this.audioQuality,
            onEncodedPacket: (pkt, meta) => {
                this._liveBytes += pkt.byteLength;
                this.onAudioPacket?.(pkt, meta);
            }
        });
        this._output.addAudioTrack(this._audioSource);

        this._audioSource.errorPromise.catch((err) => {
            throw new Error(`Audio source error: ${err?.message ?? err}`);
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
    /**
     * Opens a writable stream for a new file in the selected recording directory.
     * @returns {Promise<FileSystemWritableFileStream>}
     */
    async _openFileWritable() {
        if (!this._directoryHandle)
            throw new Error('No recording directory set. Call setRecordingDirectory() first.');

        const handle = await this._directoryHandle.getFileHandle(this._generateFilename(), {
            create: true
        });
        this._fileHandle = handle;
        return handle.createWritable();
    }

    _disconnectAudio() {
        this._audioTap?.disconnect();
        this._audioTap = null;
    }

    async _frameLoop() {
        if (!this._active) return;
        if (this._paused) {
            requestAnimationFrame(() => this._frameLoop());
            return;
        }
        const now = performance.now();
        if (now - this._frameTimer >= 1000 / this.fps) {
            this._frameTimer += 1000 / this.fps;
            await this._captureFrame();
        }
        requestAnimationFrame(() => this._frameLoop());
    }

    async _captureFrame() {
        const now = performance.now();
        const durationSec = (now - this._lastFrameTime) / 1000;
        const timestampSec = (now - this._startTime - this._pausedAccum) / 1000;
        this._lastFrameTime = now;
        await this._videoSource.add(timestampSec, durationSec);
    }
}
