import {
    Quality,
    Output,
    NullTarget,
    BufferTarget,
    CanvasSource,
    AudioSampleSource,
    EncodedVideoPacketSource,
    EncodedAudioPacketSource,
    getFirstEncodableAudioCodec,
    type VideoCodec,
    type AudioCodec,
    type QualityLevel,
    type EncodedPacket,
    type PacketType
} from 'mediabunny';
import { CONTAINERS, type ContainerName } from './containers';
import {
    acquireAudioTap,
    autoTapSupported,
    describeAudioReady,
    resumeTappedAudio,
    waitForAudioTap,
    type AudioTap
} from './audio';
import { attachAudioTap, type AudioFeed } from './audio-feed';
import { VideoClock } from './video-clock';
import {
    canvasFitOptions,
    createLogger,
    dedupeErrors,
    downloadBlob,
    errorMessage,
    findEncodableVideoCodec,
    generateOutputFilename,
    onVisibilityChange,
    toEven,
    toQuality,
    webCodecsSupported
} from './utils';
import {
    DEFAULT_AUDIO_QUALITY,
    DEFAULT_BUFFER_SECONDS,
    DEFAULT_CONTAINER,
    DEFAULT_FPS,
    DEFAULT_KEYFRAME_INTERVAL,
    DEFAULT_VIDEO_QUALITY,
    MAX_GOP_TRIM_STEPS,
    type ConfigOverrides,
    type MediaCaptureConfig
} from './constants';

// Decimal megabytes, as used for the `targetMB` budget
const BYTES_PER_MEGABYTE = 1e6;

// Aiming under targetMB so normal size variance doesn't trigger the trim cap
const TARGET_AIM = 0.95;
// Prune runs at most once per heartbeat. Retention keeps one heartbeat of slack
// so a late prune can't cut into the export window.
const HEARTBEAT_MS = 1000;
// EMA smoothing for the targetMB size correction: alpha and clamp range.
const EMA_ALPHA = 0.3;
const SIZE_CORRECTION_MIN = 0.5;
const SIZE_CORRECTION_MAX = 2;
// Floor so an impossible targetMB still encodes something instead of 0 bps.
const MIN_VIDEO_BPS = 1000;
const MIN_BITRATE_SAMPLES = 2;

/** A raw encoded packet held in the rolling buffer, stamped on the recording timeline. */
interface BufferedPacket {
    pkt: EncodedPacket;
    timestamp: number;
}

interface BufferedVideoPacket extends BufferedPacket {
    type: PacketType;
    /** The encoder config that produced this packet. It carries the SPS, so a
     * remux must use the config of the packets it writes, not a stale one from
     * an earlier pipeline generation. */
    decoderConfig: VideoDecoderConfig | null;
}

export interface ReplayerConfig extends MediaCaptureConfig {
    targetMB?: number;
    bufferSeconds?: number;
    keyframeInterval?: number;
}

/** The subset of {@link ReplayerConfig} that `configure()` accepts. */
export type ReplayerConfigOverrides = ConfigOverrides<ReplayerConfig>;

/**
 * Continuously captures a canvas into a rolling buffer of encoded packets.
 * Call `saveLastSeconds()` at any point to mux the last N seconds into a file.
 *
 * @example
 * const replayer = new Replayer(canvas, { audioNode: masterGain, bufferSeconds: 20 });
 * await replayer.start();
 * await replayer.saveLastSeconds();
 */
export class Replayer {
    static get isSupported(): boolean {
        return webCodecsSupported();
    }

    canvas: HTMLCanvasElement;
    fps: number;
    container: ContainerName;
    videoQuality: Quality;
    audioQuality: Quality;
    audioNode: boolean | AudioNode | null;
    targetMB: number | undefined;
    bitrateMode: 'constant' | 'variable';
    bufferSeconds: number;
    keyframeInterval: number;
    name: string;
    onLog: ((message: string) => void) | null;
    debug: boolean;

    private readonly _log: (message: string, level?: 'error') => void;

    // --- Callbacks ---
    onStart: (() => void) | null = null;
    onStop: (() => void) | null = null;
    onPause: (() => void) | null = null;
    onResume: (() => void) | null = null;
    onExport: ((result: { duration: number; size: number }) => void) | null = null;

    // --- Recording state ---
    private _active = false;
    private _paused = false;
    private _autoPaused = false;
    private _lastPruneTime = 0;
    private _stopVisibilityWatch: (() => void) | null = null;

    private _encodeWidth = 0;
    private _encodeHeight = 0;

    private _videoCodec: VideoCodec | null = null;
    private _videoLatencyMode: 'realtime' | 'quality' = 'quality';
    private _audioCodec: AudioCodec | null = null;

    private _audioDecoderConfig: AudioDecoderConfig | null = null;

    // --- Rolling buffers ---
    private _videoChunks: BufferedVideoPacket[] = [];
    private _audioChunks: BufferedPacket[] = [];
    private _bufferBytes = 0;

    private _resolvedVideoQuality: Quality;
    private _resolvedAudioQuality: Quality;
    private _requestedVideoBitrate: number | null = null;
    private _sizeCorrection = 1;

    // --- Live capture pipeline ---
    private _holdingOutput: Output | null = null;
    private _frameClock: VideoClock | null = null;
    private _audioSource: AudioSampleSource | null = null;
    private _audioTap: AudioTap | null = null;
    private _audioFeed: AudioFeed | null = null;
    private _audioTapWatch = 0;
    // Serializes rebuilds so concurrent callers can't tear down each other's pipeline.
    private _reinitLock: Promise<void> = Promise.resolve();
    // Pipeline token. Stale encode callbacks drop themselves.
    private _pipelineGen = 0;
    // Raw `videoQuality` input, kept so `bitrateMode` can be (re)applied to
    // quality levels when the encoder is configured.
    private _videoQualityInput: number | QualityLevel | Quality;

    constructor(canvas: HTMLCanvasElement, options: ReplayerConfig = {}) {
        this.canvas = canvas;

        // --- Config ---
        this.fps = options.fps ?? DEFAULT_FPS;
        this.container = options.container ?? DEFAULT_CONTAINER;
        this.videoQuality = toQuality(options.videoQuality ?? DEFAULT_VIDEO_QUALITY);
        this._videoQualityInput = options.videoQuality ?? DEFAULT_VIDEO_QUALITY;
        this.audioQuality = toQuality(options.audioQuality ?? DEFAULT_AUDIO_QUALITY);
        this.audioNode = options.audioNode ?? null;
        this.bufferSeconds = options.bufferSeconds ?? DEFAULT_BUFFER_SECONDS;
        this.keyframeInterval = options.keyframeInterval ?? DEFAULT_KEYFRAME_INTERVAL;
        this.name = options.name ?? '';
        this.targetMB = options.targetMB;
        this.bitrateMode = options.bitrateMode ?? 'constant';

        this.onLog = options.onLog ?? null;
        this.debug = options.debug ?? false;

        this._log = createLogger(this.onLog, this.debug);

        this._resolvedVideoQuality = this.videoQuality;
        this._resolvedAudioQuality = this.audioQuality;
    }

    get recording(): boolean {
        return this._active;
    }

    get paused(): boolean {
        return this._paused;
    }

    /** Whether the buffer holds footage that `saveLastSeconds()` could export. */
    get exportable(): boolean {
        return this._videoChunks.length > 0 && this._videoChunks[0].decoderConfig !== null;
    }

    /** Total byte count of raw encoded packets in the rolling buffer. */
    get bufferBytes(): number {
        return this._bufferBytes;
    }

    /** Duration of the footage currently in the rolling buffer, in seconds. */
    get bufferedSeconds(): number {
        const video = this._videoChunks;
        return video.length ? video.at(-1)!.timestamp - video[0].timestamp : 0;
    }

    /**
     * Encoded packet byte size an export of `seconds` would produce right now,
     * including the targetMB cap an export would apply.
     */
    estimateExportBytes(seconds: number = this.bufferSeconds): number | null {
        const clip = this._selectExportWindow(seconds);
        if (!clip) return null;
        const { exportVideo, exportAudio } = clip;
        const audioBytes = this._sumBytes(exportAudio);
        let videoBytes = this._sumBytes(exportVideo);
        if (!this._targetMBActive()) return Math.round(videoBytes + audioBytes);

        // An export over the budget trims GOP at the front. Walk them off the same
        // way so the estimate matches the muxed result instead of the raw window.
        const lastTs = exportVideo.at(-1)!.timestamp;
        const span = lastTs - exportVideo[0].timestamp || 1;
        let start = 0;
        let size = videoBytes + audioBytes;
        while (size > this.targetMB! * BYTES_PER_MEGABYTE) {
            const next = exportVideo.findIndex((c, i) => i > start && c.type === 'key');
            if (next < 0) break;
            for (let i = start; i < next; i++) videoBytes -= exportVideo[i].pkt.byteLength;
            start = next;
            size = videoBytes + audioBytes * ((lastTs - exportVideo[start].timestamp) / span);
        }
        return Math.round(size);
    }

    /**
     * Update settings, including while recording. Any change that affects the
     * capture rebuilds the pipeline, while buffered footage is only cleared
     * when video encoding semantics have changed.
     */
    async configure(overrides: ReplayerConfigOverrides = {}): Promise<void> {
        const {
            fps,
            container,
            videoQuality,
            audioQuality,
            targetMB,
            bitrateMode,
            bufferSeconds,
            keyframeInterval,
            audioNode
        } = overrides;

        if (container !== undefined && !CONTAINERS[container])
            throw new Error(`Unsupported container "${container}".`);

        const prevBitrateMode = this.bitrateMode;
        const prevAudioNode = this.audioNode;
        if (fps !== undefined) this.fps = fps;
        if (bufferSeconds !== undefined) this.bufferSeconds = bufferSeconds;
        if (keyframeInterval !== undefined) this.keyframeInterval = keyframeInterval;
        if (container !== undefined) this.container = container;
        if (targetMB !== undefined) this.targetMB = targetMB;
        if (bitrateMode !== undefined) this.bitrateMode = bitrateMode;
        if (videoQuality !== undefined) {
            this.videoQuality = toQuality(videoQuality);
            this._videoQualityInput = videoQuality;
        }
        if (audioQuality !== undefined) this.audioQuality = toQuality(audioQuality);
        if (audioNode !== undefined) this.audioNode = audioNode;

        const targetMBActive = this._targetMBActive();
        const qualityChange = videoQuality !== undefined || audioQuality !== undefined;
        // Changes that invalidate buffered packets demand a reset. Everything
        // else rebuilds capture while keeping the footage.
        const encoderChanged =
            (qualityChange && !targetMBActive) ||
            container !== undefined ||
            targetMB !== undefined ||
            (targetMBActive && bufferSeconds !== undefined);
        const rebuild =
            encoderChanged ||
            fps !== undefined ||
            (bitrateMode !== undefined && bitrateMode !== prevBitrateMode) ||
            (audioNode !== undefined && audioNode !== prevAudioNode);

        if (rebuild && this._active) await this._reinitSources(encoderChanged);
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
        // A context parked while hidden must be woken, or the window captures no audio.
        void resumeTappedAudio();
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

        const { videoCodec, videoLatencyMode, audioCodec } = await this._selectCodecs();
        this._videoCodec = videoCodec;
        this._videoLatencyMode = videoLatencyMode;
        this._audioCodec = audioCodec;

        this._videoChunks = [];
        this._audioChunks = [];
        this._bufferBytes = 0;
        this._audioDecoderConfig = null;

        await this._initSources();

        this._active = true;
        this._paused = false;
        this._autoPaused = false;

        // Automatically pause while hidden, debounced so brief hides (e.g. DevTools) are ignored
        if (!this._stopVisibilityWatch) {
            this._stopVisibilityWatch = onVisibilityChange({
                onHidden: () => {
                    if (this._active && !this._paused) {
                        this._autoPaused = true;
                        this.pause();
                    }
                },
                onShow: () => {
                    void resumeTappedAudio();
                    if (this._autoPaused) {
                        this._autoPaused = false;
                        this.resume();
                    }
                }
            });
        }

        this.onStart?.();

        this._log(
            `Recording started - video: ${videoCodec} | audio: ${audioCodec ?? 'none'} | ${this.fps}fps | resolution: ${this._encodeWidth}x${this._encodeHeight}`
        );
    }

    /**
     * Stop buffering and clear the buffer. Call `saveLastSeconds()` beforehand
     * if you want to keep the current footage.
     */
    async stop(): Promise<void> {
        if (!this._active) throw new Error('Not recording.');
        this._active = false;
        this._paused = false;
        this._autoPaused = false;
        this._stopVisibilityWatch?.();
        this._stopVisibilityWatch = null;

        // Let any running rebuild settle (it aborts on `!this._active`), so it
        // can't build a fresh pipeline underneath the teardown below.
        await this._reinitLock;
        await this._teardownSources();

        this._videoChunks = [];
        this._audioChunks = [];
        this._bufferBytes = 0;
        this._audioDecoderConfig = null;
        this._videoCodec = null;
        this._audioCodec = null;

        this._log('Recording stopped');
        this.onStop?.();
    }

    /**
     * Mux the last `seconds` of buffered footage into a file and optionally download it.
     * @param options Set `download: false` to get the blob without triggering a download.
     * @returns The muxed clip, or `null` when nothing is exportable yet.
     */
    async saveLastSeconds(
        seconds: number = this.bufferSeconds,
        { download = true }: { download?: boolean } = {}
    ): Promise<Blob | null> {
        void resumeTappedAudio();
        if (!this.exportable) {
            this._log('saveLastSeconds: insufficient data to export');
            return null;
        }

        const clip = this._selectExportWindow(seconds);
        if (!clip) {
            this._log('saveLastSeconds: no keyframe found in export window');
            return null;
        }
        let { exportVideo, exportAudio } = clip;

        const muxWindow = () => {
            const firstTs = Math.min(
                exportVideo[0].timestamp,
                exportAudio[0]?.timestamp ?? exportVideo[0].timestamp
            );
            return this._mux(exportVideo, exportAudio, firstTs);
        };
        const clipLen = () =>
            exportVideo.at(-1)!.timestamp - exportVideo[0].timestamp + this._frameDuration;
        const fullSeconds = clipLen();

        const targeting = this._targetMBActive();
        const targetBytes = targeting ? this.targetMB! * BYTES_PER_MEGABYTE : 0;

        let blob = await muxWindow();
        const fullBlobSize = blob.size;

        // When over budget: drop the oldest key frame groups and remux until it fits
        let droppedGOPs = 0;
        if (targeting) {
            let guard = 0;
            while (blob.size > targetBytes && guard++ < MAX_GOP_TRIM_STEPS) {
                const nextKey = exportVideo.findIndex((c, i) => i > 0 && c.type === 'key');
                if (nextKey < 0) break;
                exportVideo = exportVideo.slice(nextKey);
                exportAudio = exportAudio.filter((c) => c.timestamp >= exportVideo[0].timestamp);
                blob = await muxWindow();
                droppedGOPs++;
            }
            const droppedSeconds = fullSeconds - clipLen();
            if (this.debug && droppedSeconds > 0)
                this._log(
                    `Trimmed ${droppedGOPs} GOPs (${droppedSeconds.toFixed(1)}s) to fit ${this.targetMB} MB`
                );
        }

        const clipSeconds = clipLen();

        // If the full window muxed X% over the aim, the next request drops X%
        if (targeting && this._requestedVideoBitrate && fullBlobSize > 0) {
            const aimBytes = targetBytes * TARGET_AIM;
            const next = this._sizeCorrection * (aimBytes / fullBlobSize);
            this._sizeCorrection = this._smoothRatio(
                this._sizeCorrection,
                next,
                SIZE_CORRECTION_MIN,
                SIZE_CORRECTION_MAX
            );
        }

        if (download)
            downloadBlob(blob, generateOutputFilename(this.name, this.container, clipSeconds));

        let targetNote = '';
        if (targeting) {
            targetNote = ` (target ${this.targetMB} MB, ${Math.round((blob.size / targetBytes) * 100)}%`;
            if (droppedGOPs > 0)
                targetNote += `, full ${Math.round((fullBlobSize / targetBytes) * 100)}%`;
            targetNote += ')';
        }
        const result = { duration: clipSeconds, size: blob.size };
        const audioSpan = exportAudio.length
            ? exportAudio.at(-1)!.timestamp - exportAudio[0].timestamp
            : 0;
        if (this.debug) {
            const a = exportAudio;
            const feed = this._audioFeed
                ? `, ${this._audioFeed.describe()}, ctx ${this._audioTap?.ctx.state ?? 'none'}`
                : ', video only';
            this._log(
                `Export window - audio ${a.length}p ${
                    a.length
                        ? `${a[0].timestamp.toFixed(2)}..${a.at(-1)!.timestamp.toFixed(2)}`
                        : 'none'
                }, video ${exportVideo[0].timestamp.toFixed(2)}..${exportVideo.at(-1)!.timestamp.toFixed(2)}, buffer ${this.bufferedSeconds.toFixed(1)}s${feed}`
            );
        }
        this._log(
            `Export complete - ${(blob.size / BYTES_PER_MEGABYTE).toFixed(2)} MB (${clipSeconds.toFixed(1)}s video, ${audioSpan.toFixed(1)}s audio)${targetNote}`
        );
        this.onExport?.(result);

        return blob;
    }

    private _targetMBActive(): boolean {
        return typeof this.targetMB === 'number' && this.targetMB > 0;
    }

    private get _frameDuration(): number {
        return 1 / this.fps;
    }

    /** Footage time kept beyond the export window, so prune never touches it. */
    private get _retentionSeconds(): number {
        return this.bufferSeconds + this.keyframeInterval + HEARTBEAT_MS / 1000;
    }

    /**
     * The last `seconds` of the footage, starting on the keyframe at or before the window start.
     */
    private _selectExportWindow(seconds: number): {
        exportVideo: BufferedVideoPacket[];
        exportAudio: BufferedPacket[];
    } | null {
        const video = this._videoChunks;
        if (!video.length) return null;
        const lastTs = video.at(-1)!.timestamp;
        const windowStart = lastTs - Math.min(seconds, lastTs - video[0].timestamp);
        // Keyframe at or just before the window, forward fallback for the first GOP
        let start = -1;
        for (let i = video.length - 1; i >= 0; i--) {
            if (video[i].type === 'key' && video[i].timestamp <= windowStart) {
                start = i;
                break;
            }
        }
        if (start < 0)
            start = video.findIndex((c) => c.type === 'key' && c.timestamp >= windowStart);
        if (start < 0) return null;
        // Run to the newest packet: starting on the earlier keyframe makes the
        // clip a bit longer, but never drops the moment that triggered it.
        const exportVideo = video.slice(start);
        const exportAudio = this._audioChunks.filter(
            (c) =>
                c.timestamp >= exportVideo[0].timestamp &&
                c.timestamp <= exportVideo.at(-1)!.timestamp
        );
        return { exportVideo, exportAudio };
    }

    private _smoothRatio(current: number, measured: number, min: number, max: number): number {
        if (!Number.isFinite(measured) || measured <= 0) return current;
        return Math.min(max, Math.max(min, current + EMA_ALPHA * (measured - current)));
    }

    /** Observed audio bitrate in the buffer, `null` with too little data. */
    private _measuredAudioBitrate(): number | null {
        const chunks = this._audioChunks;
        if (chunks.length < MIN_BITRATE_SAMPLES) return null;
        const span = chunks.at(-1)!.timestamp - chunks[0].timestamp;
        if (span <= 0) return null;
        return (this._sumBytes(chunks) * 8) / span;
    }

    /**
     * Video quality sized so a full export window lands at `TARGET_AIM` of `targetMB`.
     */
    private _targetVideoQuality(audioBitrate: number): Quality {
        const targetBits = this.targetMB! * BYTES_PER_MEGABYTE * 8;
        const perSecondBits = targetBits / Math.max(this._frameDuration, this.bufferSeconds);
        const available = (perSecondBits - audioBitrate) * this._sizeCorrection;
        if (available < MIN_VIDEO_BPS) {
            this._log(
                `targetMB (${this.targetMB} MB) is too small for a ${this.bufferSeconds}s clip: ` +
                    `audio alone needs ~${Math.round(audioBitrate / 1000)} kbps of the ` +
                    `~${Math.round(perSecondBits / 1000)} kbps budget. Video pinned to ` +
                    `${MIN_VIDEO_BPS / 1000} kbps and the export will exceed the target.`
            );
        }
        const bitrate = Math.round(Math.max(MIN_VIDEO_BPS, available));
        this._requestedVideoBitrate = bitrate;
        return new Quality({ bitrate, bitrateMode: this.bitrateMode });
    }

    private _sumBytes(chunks: BufferedPacket[]): number {
        return chunks.reduce((sum, c) => sum + c.pkt.byteLength, 0);
    }

    private async _selectCodecs(): Promise<{
        videoCodec: VideoCodec;
        videoLatencyMode: 'realtime' | 'quality';
        audioCodec: AudioCodec | null;
    }> {
        const containerDef = CONTAINERS[this.container];
        if (!containerDef) throw new Error(`Unsupported container "${this.container}".`);
        const format = new containerDef.Format();

        const targeting = this._targetMBActive();
        this._resolvedAudioQuality = targeting ? toQuality('very-high') : this.audioQuality;

        const audioCodec = this.audioNode
            ? await getFirstEncodableAudioCodec(format.getSupportedAudioCodecs(), {
                  quality: this._resolvedAudioQuality
              })
            : null;

        if (targeting) {
            const audioBitrate = audioCodec ? (this._measuredAudioBitrate() ?? 0) : 0;
            this._resolvedVideoQuality = this._targetVideoQuality(audioBitrate);
        } else {
            this._requestedVideoBitrate = null;
            this._resolvedVideoQuality = toQuality(this._videoQualityInput, this.bitrateMode);
        }

        const choice = await findEncodableVideoCodec(format.getSupportedVideoCodecs(), {
            width: this._encodeWidth,
            height: this._encodeHeight,
            quality: this._resolvedVideoQuality
        });
        if (!choice) throw new Error('No supported video codec found.');

        return { videoCodec: choice.codec, videoLatencyMode: choice.latencyMode, audioCodec };
    }

    private async _initSources(
        videoTail: number | null = null,
        audioTail: number | null = null
    ): Promise<void> {
        const gen = ++this._pipelineGen;
        const containerDef = CONTAINERS[this.container];
        const output = new Output({
            format: new containerDef.Format(containerDef.streaming),
            target: new NullTarget()
        });
        this._holdingOutput = output;

        // Fresh sources stamp from 0. Packets are offset to continue the kept buffer.
        const videoOffset = videoTail ?? 0;
        const audioOffset = audioTail ?? 0;

        // Captured from this generation's first packet, then stamped on each of
        // its chunks so a remux uses a config matching the written packets.
        let genConfig: VideoDecoderConfig | null = null;
        // A broken encoder rethrows the same frame error every tick. Log it once.
        const logFrameError = dedupeErrors(this._log, 'Video frame error: ');

        const videoSource = new CanvasSource(this.canvas, {
            codec: this._videoCodec!,
            quality: this._resolvedVideoQuality,
            latencyMode: this._videoLatencyMode,
            keyFrameInterval: this.keyframeInterval,
            ...canvasFitOptions(this.canvas, this._encodeWidth, this._encodeHeight),
            onEncodedPacket: (pkt, meta) => {
                if (gen !== this._pipelineGen) return;
                if (meta?.decoderConfig && !genConfig) {
                    genConfig = meta.decoderConfig;
                }
                const ts = pkt.timestamp + videoOffset;
                this._videoChunks.push({
                    pkt,
                    timestamp: ts,
                    type: pkt.type,
                    decoderConfig: genConfig
                });
                this._bufferBytes += pkt.byteLength;
                this._pruneIfDue();
            }
        });
        output.addVideoTrack(videoSource, { frameRate: this.fps });

        const frameClock = new VideoClock({
            fps: this.fps,
            onFrame: (ts, duration) => videoSource.add(ts, duration),
            onError: (err) => {
                if (gen !== this._pipelineGen) return;
                logFrameError(err);
            }
        });
        this._frameClock = frameClock;

        if (this.audioNode && this._audioCodec) {
            this._audioTap = acquireAudioTap(this.audioNode, this._log);
            if (!this._audioTap) {
                if (this.audioNode === true && autoTapSupported()) this._watchAudioTap();
            } else {
                this._audioSource = new AudioSampleSource({
                    codec: this._audioCodec,
                    quality: this._resolvedAudioQuality,
                    onEncodedPacket: (pkt, meta) => {
                        if (gen !== this._pipelineGen) return;
                        if (meta?.decoderConfig && !this._audioDecoderConfig)
                            this._audioDecoderConfig = meta.decoderConfig;
                        const ts = pkt.timestamp + audioOffset;
                        this._audioChunks.push({ pkt, timestamp: ts });
                        this._bufferBytes += pkt.byteLength;
                    }
                });
                output.addAudioTrack(this._audioSource);
            }
        }

        await output.start();

        frameClock.start();
        // A rebuild must not resurrect the video clock while paused. The feed
        // already honors _paused.
        if (this._paused) frameClock.pause();

        // Feed only after the output started. add() before that is rejected
        if (this._audioTap && this._audioSource) {
            this._audioFeed = attachAudioTap(
                this._audioTap,
                this._audioSource,
                () => this._paused,
                (message) => this._log(message, 'error'),
                frameClock.originMs
            );
            // Keep the fresh feed's pause clock in step with the video clock.
            if (this._paused) this._audioFeed.notifyPause(true);
            this._log(describeAudioReady(this._audioCodec!, this._audioTap));
        }
    }

    private _watchAudioTap(): void {
        const watch = ++this._audioTapWatch;
        waitForAudioTap().then(() => {
            if (watch !== this._audioTapWatch) return;
            if (this._audioTap || !this.recording) return;
            this._log('Audio graph detected, rebuilding pipeline');
            this._reinitSources(false).catch((err) => {
                this._log(`Audio reinit failed: ${errorMessage(err)}`, 'error');
            });
        });
    }

    private async _teardownSources(): Promise<void> {
        const { _audioTap, _holdingOutput } = this;
        // Supersede the pipeline so its callbacks stop touching the buffer.
        this._pipelineGen++;
        this._frameClock?.stop();
        this._frameClock = null;
        this._audioSource = null;
        const feed = this._audioFeed;
        this._audioFeed = null;
        feed?.detach();
        await feed?.drain();
        // cancel() force closes and awaits every connected source.
        await _holdingOutput?.cancel();
        _audioTap?.disconnect();
        this._audioTapWatch++;
        this._audioTap = null;
        this._holdingOutput = null;
    }

    /**
     * Rebuild the capture pipeline, keeping buffered packets unless `resetBuffer`.
     * Rebuilds are serialized so concurrent callers (the audio tap and
     * `configure()`) can't tear down each other's freshly built pipeline.
     */
    private _reinitSources(resetBuffer: boolean): Promise<void> {
        const next = this._reinitLock.then(
            () => this._doReinitSources(resetBuffer),
            () => this._doReinitSources(resetBuffer)
        );
        // Keep the chain usable even if this rebuild rejects.
        this._reinitLock = next.catch(() => {});
        return next;
    }

    private async _doReinitSources(resetBuffer: boolean): Promise<void> {
        const { videoCodec, videoLatencyMode, audioCodec } = await this._selectCodecs();
        // stop() may have landed while we were choosing codecs. Don't resurrect it.
        if (!this._active) return;
        this._videoCodec = videoCodec;
        this._videoLatencyMode = videoLatencyMode;
        this._audioCodec = audioCodec;

        await this._teardownSources();
        if (resetBuffer) {
            this._audioDecoderConfig = null;
            this._videoChunks = [];
            this._audioChunks = [];
            this._bufferBytes = 0;
        }

        // Captured after teardown: the drained buffer's tails are the splice
        // point. Audio never splices in behind the video: if it fell silent
        // (suspended context), anchor it back to the video tail.
        const videoTail = resetBuffer ? null : (this._videoChunks.at(-1)?.timestamp ?? null);
        const audioTail = resetBuffer
            ? null
            : Math.max(this._audioChunks.at(-1)?.timestamp ?? 0, videoTail ?? 0);
        await this._initSources(videoTail, audioTail);

        this._log(
            `Pipeline reinitialized - video: ${videoCodec} | audio: ${audioCodec ?? 'none'}${resetBuffer ? ' (buffer reset)' : ''}`
        );
    }

    private _pruneIfDue(): void {
        const now = performance.now();
        if (now - this._lastPruneTime < HEARTBEAT_MS) return;
        this._lastPruneTime = now;

        // Retention follows footage time instead of wall clock
        const lastTs = this._videoChunks.at(-1)?.timestamp;
        if (lastTs === undefined) return;
        const cutoff = lastTs - this._retentionSeconds;
        this._videoChunks = this._pruneChunks(this._videoChunks, cutoff);
        this._audioChunks = this._pruneChunks(this._audioChunks, cutoff);
    }

    /** Drop the leading packets older than `cutoff`. Chunks are ordered by timestamp. */
    private _pruneChunks<T extends BufferedPacket>(chunks: T[], cutoff: number): T[] {
        let i = 0;
        while (i < chunks.length && chunks[i].timestamp < cutoff) {
            this._bufferBytes -= chunks[i].pkt.byteLength;
            i++;
        }
        return i ? chunks.slice(i) : chunks;
    }

    private async _addPacket(
        source: { add(packet: EncodedPacket, meta?: object): Promise<void> },
        chunk: BufferedPacket,
        firstTs: number,
        decoderConfig: VideoDecoderConfig | AudioDecoderConfig | null,
        isFirst: boolean
    ): Promise<void> {
        const normalized = chunk.pkt.clone({ timestamp: chunk.timestamp - firstTs });
        await source.add(normalized, isFirst ? { decoderConfig } : {});
    }

    private async _mux(
        videoChunks: BufferedVideoPacket[],
        audioChunks: BufferedPacket[],
        firstTs: number
    ): Promise<Blob> {
        const containerDef = CONTAINERS[this.container];
        const outputFormat = new containerDef.Format(containerDef.export);
        const output = new Output({ format: outputFormat, target: new BufferTarget() });

        const videoSource = new EncodedVideoPacketSource(this._videoCodec!);
        // A kept buffer can outlive its audio codec (audio disabled after
        // buffering), so drop those chunks instead of muxing through no source.
        audioChunks = this._audioCodec ? audioChunks : [];
        const audioSource =
            this._audioCodec && audioChunks.length
                ? new EncodedAudioPacketSource(this._audioCodec)
                : null;

        output.addVideoTrack(videoSource);
        if (audioSource) output.addAudioTrack(audioSource);
        await output.start();

        // Interleave by timestamp so the Output doesn't buffer one whole track.
        let vi = 0;
        let ai = 0;
        let videoConfigSent = false;
        let audioConfigSent = false;

        while (vi < videoChunks.length || ai < audioChunks.length) {
            const nextIsVideo =
                ai >= audioChunks.length ||
                (vi < videoChunks.length && videoChunks[vi].timestamp <= audioChunks[ai].timestamp);

            if (nextIsVideo) {
                await this._addPacket(
                    videoSource,
                    videoChunks[vi],
                    firstTs,
                    videoChunks[vi].decoderConfig,
                    !videoConfigSent
                );
                videoConfigSent = true;
                vi++;
            } else {
                await this._addPacket(
                    audioSource!,
                    audioChunks[ai],
                    firstTs,
                    this._audioDecoderConfig,
                    !audioConfigSent
                );
                audioConfigSent = true;
                ai++;
            }
        }

        videoSource.close();
        if (audioSource) audioSource.close();
        await output.finalize();

        return new Blob([(output.target as BufferTarget).buffer!], {
            type: outputFormat.mimeType
        });
    }
}
