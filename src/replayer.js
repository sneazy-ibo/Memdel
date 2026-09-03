import {
    Output,
    NullTarget,
    BufferTarget,
    CanvasSource,
    MediaStreamAudioTrackSource,
    EncodedVideoPacketSource,
    EncodedAudioPacketSource,
    getEncodableVideoCodecs,
    getEncodableAudioCodecs
} from 'mediabunny';
import { CONTAINERS } from './containers.js';
import {
    downloadBlob,
    tapAudioNode,
    generateOutputFilename,
    createLogger,
    onVisibilityChange,
    toQuality
} from './utils.js';

/**
 * @typedef {import('mediabunny').QualityLevel} QualityLevel
 * @typedef {import('mediabunny').Quality} Quality
 * @typedef {import('mediabunny').EncodedPacket} EncodedPacket
 * @typedef {import('mediabunny').PacketType} PacketType
 */

/**
 * A raw encoded packet held in the rolling buffer, timestamped on the
 * recording timeline.
 * @typedef {Object} BufferedPacket
 * @property {EncodedPacket} pkt
 * @property {number} timestamp
 */

/**
 * @typedef {BufferedPacket & { type: PacketType }} BufferedVideoPacket
 */

/**
 * @typedef {Object} ReplayerConfig
 * @property {number}   [fps=60]
 * @property {'mp4' | 'mov' | 'webm' | 'mkv'} [container="mp4"]
 * @property {number|QualityLevel|Quality} [videoQuality="high"]
 * @property {number|QualityLevel|Quality} [audioQuality="very-high"]
 * @property {AudioNode} [audioNode]
 * @property {number} [bufferSeconds=15]
 * @property {number} [keyframeInterval=2]
 * @property {string} [name=""]
 * @property {(message: string) => void} [onLog]
 * @property {boolean} [debug=false]
 */

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
    /** @returns {boolean} Whether the browser supports the required APIs. */
    static get isSupported() {
        return (
            typeof window !== 'undefined' &&
            'VideoEncoder' in window &&
            typeof HTMLCanvasElement.prototype.captureStream === 'function'
        );
    }

    /**
     * @param {HTMLCanvasElement} canvas
     * @param {ReplayerConfig} [options]
     */
    constructor(canvas, options = {}) {
        this.canvas = canvas;

        // --- Config ---
        this.fps = options.fps ?? 60;
        /** @type {'mp4' | 'mov' | 'webm' | 'mkv'} */
        this.container = options.container ?? 'mp4';
        this.videoQuality = toQuality(options.videoQuality ?? 'high');
        this.audioQuality = toQuality(options.audioQuality ?? 'very-high');
        this.audioNode = options.audioNode ?? null;
        this.bufferSeconds = options.bufferSeconds ?? 15;
        this.keyframeInterval = options.keyframeInterval ?? 2;
        this.name = options.name ?? '';

        this.onLog = options.onLog ?? null;
        this.debug = options.debug ?? false;

        this._log = createLogger(this.onLog, this.debug);

        // --- Callbacks ---
        /** @type {(() => void) | null} */
        this.onStart = null;
        /** @type {(() => void) | null} */
        this.onStop = null;
        /** @type {(() => void) | null} */
        this.onPause = null;
        /** @type {(() => void) | null} */
        this.onResume = null;
        /** @type {((result: { duration: number, size: number }) => void) | null} */
        this.onExport = null;
        /** @type {((packet: EncodedPacket, meta: EncodedVideoChunkMetadata | undefined) => void) | null} */
        this.onVideoPacket = null;
        /** @type {((packet: EncodedPacket, meta: EncodedAudioChunkMetadata | undefined) => void) | null} */
        this.onAudioPacket = null;

        // --- Recording state ---
        this._active = false;
        this._paused = false;
        this._autoPaused = false;
        this._startTime = 0;
        this._pausedAccum = 0;
        this._pauseStartedAt = 0;
        this._frameIndex = 0;
        this._lastPruneTime = 0;
        this._stopVisibilityWatch = null;

        this._encodeWidth = 0;
        this._encodeHeight = 0;

        /** @type {import('mediabunny').VideoCodec|null} */
        this._videoCodec = null;
        /** @type {import('mediabunny').AudioCodec|null} */
        this._audioCodec = null;

        /** @type {VideoDecoderConfig|null} */
        this.videoDecoderConfig = null;
        /** @type {AudioDecoderConfig|null} */
        this.audioDecoderConfig = null;

        // --- Rolling buffers ---
        /** @type {BufferedVideoPacket[]} */
        this._videoChunks = [];
        /** @type {BufferedPacket[]} */
        this._audioChunks = [];
        // // Audio uses the first packet as the sync offset for the video timeline.
        this._audioFirstTs = null;
        this._audioSyncBase = 0;

        // --- Live capture pipeline ---
        this._holdingOutput = null;
        this._videoSource = null;
        this._audioSource = null;
        this._audioTap = null;
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
     * Total byte count of raw encoded packets in the rolling buffer.
     * @returns {number}
     */
    get bufferBytes() {
        let total = 0;
        for (const c of this._videoChunks) total += c.pkt.byteLength;
        for (const c of this._audioChunks) total += c.pkt.byteLength;
        return total;
    }

    /**
     * Update settings, including while recording. Changing `videoQuality`,
     * `audioQuality`, `container`, or `audioNode` reinitializes the pipeline.
     * @typedef {Pick<ReplayerConfig, 'fps' | 'container' | 'videoQuality' | 'audioQuality' | 'bufferSeconds' | 'keyframeInterval' | 'audioNode'>} ReplayerConfigOverrides
     * @param {ReplayerConfigOverrides} [config]
     */
    async configure({
        fps,
        container,
        videoQuality,
        audioQuality,
        bufferSeconds,
        keyframeInterval,
        audioNode
    } = {}) {
        if (fps !== undefined) this.fps = fps;
        if (bufferSeconds !== undefined) this.bufferSeconds = bufferSeconds;
        if (keyframeInterval !== undefined) this.keyframeInterval = keyframeInterval;
        if (container !== undefined && !CONTAINERS[container]) {
            throw new Error(`Unsupported container "${container}".`);
        }

        const needsReinit =
            videoQuality !== undefined ||
            audioQuality !== undefined ||
            container !== undefined ||
            (audioNode !== undefined && audioNode !== this.audioNode);

        if (container !== undefined) this.container = container;
        if (videoQuality !== undefined) this.videoQuality = toQuality(videoQuality);
        if (audioQuality !== undefined) this.audioQuality = toQuality(audioQuality);
        if (audioNode !== undefined) this.audioNode = audioNode;

        if (needsReinit && this._active) await this._reinitSources();
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

    resume() {
        if (!this._active) throw new Error('Not recording.');
        if (!this._paused) return;
        this._pausedAccum += performance.now() - this._pauseStartedAt;
        this._audioSource?.resume();
        this._paused = false;
        this._log('Recording resumed');
        this.onResume?.();
    }

    /** Start filling the rolling buffer. */
    async start() {
        if (this._active) throw new Error('Already recording.');

        this._encodeWidth = this.canvas.width & ~1;
        this._encodeHeight = this.canvas.height & ~1;

        const { videoCodec, audioCodec } = await this._selectCodecs();
        this._videoCodec = videoCodec;
        this._audioCodec = audioCodec;

        this._videoChunks = [];
        this._audioChunks = [];
        this.videoDecoderConfig = null;
        this.audioDecoderConfig = null;

        await this._initSources();

        this._active = true;
        this._paused = false;
        this._autoPaused = false;
        this._pausedAccum = 0;
        this._frameIndex = 0;
        this._lastPruneTime = 0;
        this._startTime = performance.now();

        // Pause when in the background, resume when the tab is visible again.
        // Debounced so a brief hide (e.g. opening DevTools) doesn't pause.
        if (!this._stopVisibilityWatch) {
            this._stopVisibilityWatch = onVisibilityChange(
                {
                    onHidden: () => {
                        if (this._active && !this._paused) {
                            this._autoPaused = true;
                            this.pause();
                        }
                    },
                    onShow: () => {
                        if (this._autoPaused) {
                            this._autoPaused = false;
                            this.resume();
                        }
                    }
                },
                750
            );
        }

        this._captureLoop();
        this.onStart?.();

        this._log(
            `Recording started - video: ${videoCodec} | audio: ${audioCodec ?? 'none'} | ${this.fps}fps | resolution: ${this._encodeWidth}x${this._encodeHeight}`
        );
    }

    /**
     * Stop buffering and clear the buffer. Call `saveLastSeconds()` beforehand
     * if you want to keep the current footage.
     */
    async stop() {
        if (!this._active) throw new Error('Not recording.');
        this._active = false;
        this._paused = false;
        this._autoPaused = false;
        this._stopVisibilityWatch?.();
        this._stopVisibilityWatch = null;

        await this._teardownSources();

        this._videoChunks = [];
        this._audioChunks = [];
        this.videoDecoderConfig = null;
        this.audioDecoderConfig = null;
        this._videoCodec = null;
        this._audioCodec = null;

        this._log('Recording stopped');
        this.onStop?.();
    }

    /**
     * Mux the last `seconds` of buffered footage into a file and optionally download it.
     * @param {number} [seconds=this.bufferSeconds]
     * @param {{ download?: boolean }} [options] - Set `download: false` to get the
     *   blob without triggering a download.
     * @returns {Promise<Blob|null>}
     */
    async saveLastSeconds(seconds = this.bufferSeconds, { download = true } = {}) {
        if (!this.videoDecoderConfig || !this._videoChunks.length) {
            this._log('saveLastSeconds: insufficient data to export');
            return null;
        }

        const lastTs = this._videoChunks.at(-1).timestamp;
        const firstTs = this._videoChunks[0].timestamp;
        seconds = Math.min(seconds, lastTs - firstTs);

        const recentVideo = this._videoChunks.filter((c) => c.timestamp >= lastTs - seconds);

        const firstKeyIndex = recentVideo.findIndex((c) => c.type === 'key');
        if (firstKeyIndex < 0) {
            this._log('saveLastSeconds: no keyframe found in export window');
            return null;
        }
        const exportVideo = recentVideo.slice(firstKeyIndex);

        const exportAudio = this._audioChunks.filter(
            (c) => c.timestamp >= exportVideo[0].timestamp
        );

        exportVideo.sort((a, b) => a.timestamp - b.timestamp);
        exportAudio.sort((a, b) => a.timestamp - b.timestamp);

        const exportFirstTs = Math.min(
            exportVideo[0].timestamp,
            exportAudio[0]?.timestamp ?? exportVideo[0].timestamp
        );

        this._log(
            `Exporting ${seconds.toFixed(1)}s clip - ${exportVideo.length} video chunks, ${exportAudio.length} audio chunks`
        );

        const blob = await this._mux(exportVideo, exportAudio, exportFirstTs);
        if (download)
            downloadBlob(blob, generateOutputFilename(this.name, this.container, seconds));

        const result = { duration: seconds, size: blob.size };
        this._log(`Export complete - ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
        this.onExport?.(result);

        return blob;
    }

    /** @private */
    _elapsedSeconds() {
        return (performance.now() - this._startTime - this._pausedAccum) / 1000;
    }

    /** @private */
    async _selectCodecs() {
        const containerDef = CONTAINERS[this.container];
        if (!containerDef) throw new Error(`Unsupported container "${this.container}".`);
        const format = new containerDef.Format();

        const [availableVideo, availableAudio] = await Promise.all([
            getEncodableVideoCodecs(format.getSupportedVideoCodecs(), {
                width: this._encodeWidth,
                height: this._encodeHeight,
                quality: this.videoQuality
            }),
            this.audioNode
                ? getEncodableAudioCodecs(format.getSupportedAudioCodecs())
                : Promise.resolve([])
        ]);
        this._log(`Available video codecs: ${availableVideo.join(', ') || 'none'}`);
        if (this.audioNode)
            this._log(`Available audio codecs: ${availableAudio.join(', ') || 'none'}`);

        const videoCodec = availableVideo[0] ?? null;
        if (!videoCodec) throw new Error('No supported video codec found.');

        const audioCodec = this.audioNode ? (availableAudio[0] ?? null) : null;

        return { videoCodec, audioCodec };
    }

    /** @private */
    async _initSources() {
        const containerDef = CONTAINERS[this.container];
        this._holdingOutput = new Output({
            format: new containerDef.Format(containerDef.streaming),
            target: new NullTarget()
        });

        this._videoSource = new CanvasSource(this.canvas, {
            codec: this._videoCodec,
            quality: this.videoQuality,
            latencyMode: 'realtime',
            contentHint: 'motion',
            sizeChangeBehavior: 'contain',
            keyFrameInterval: this.keyframeInterval,
            transform: {
                width: this._encodeWidth,
                height: this._encodeHeight
            },
            onEncodedPacket: (pkt, meta) => {
                if (meta?.decoderConfig && !this.videoDecoderConfig)
                    this.videoDecoderConfig = meta.decoderConfig;
                this._videoChunks.push({ pkt, timestamp: pkt.timestamp, type: pkt.type });
                this.onVideoPacket?.(pkt, meta);
            }
        });
        this._holdingOutput.addVideoTrack(this._videoSource, { frameRate: this.fps });

        if (this.audioNode && this._audioCodec) {
            this._audioTap = tapAudioNode(this.audioNode);
            this._audioFirstTs = null;
            this._audioSyncBase = 0;

            this._audioSource = new MediaStreamAudioTrackSource(this._audioTap.track, {
                codec: this._audioCodec,
                quality: this.audioQuality,
                onEncodedPacket: (pkt, meta) => {
                    if (meta?.decoderConfig && !this.audioDecoderConfig)
                        this.audioDecoderConfig = meta.decoderConfig;
                    // Anchor the first audio packet to the video timeline.
                    if (this._audioFirstTs === null) {
                        this._audioFirstTs = pkt.timestamp;
                        this._audioSyncBase = this._elapsedSeconds();
                    }
                    const timestamp = pkt.timestamp - this._audioFirstTs + this._audioSyncBase;
                    this._audioChunks.push({ pkt, timestamp });
                    this.onAudioPacket?.(pkt, meta);
                }
            });
            this._holdingOutput.addAudioTrack(this._audioSource);

            this._audioSource.errorPromise.catch((err) => {
                throw new Error(`Audio source error: ${err?.message ?? err}`);
            });
        }

        await this._holdingOutput.start();
    }

    /** @private */
    async _teardownSources() {
        this._videoSource?.close();
        this._audioSource?.close();
        await this._holdingOutput?.cancel();
        this._audioTap?.disconnect();
        this._audioTap = null;
        this._videoSource = null;
        this._audioSource = null;
        this._holdingOutput = null;
    }

    /** @private */
    async _reinitSources() {
        const { videoCodec, audioCodec } = await this._selectCodecs();
        this._videoCodec = videoCodec;
        this._audioCodec = audioCodec;

        await this._teardownSources();
        this.videoDecoderConfig = null;
        this.audioDecoderConfig = null;
        await this._initSources();

        this._log(`Pipeline reinitialized - video: ${videoCodec} | audio: ${audioCodec ?? 'none'}`);
    }

    /** @private */
    async _captureLoop() {
        if (!this._active) return;
        if (this._paused) {
            requestAnimationFrame(() => this._captureLoop());
            return;
        }

        const elapsed = this._elapsedSeconds();
        const frameDuration = 1 / this.fps;
        const expectedIndex = Math.floor(elapsed / frameDuration);

        while (this._frameIndex <= expectedIndex) {
            const timestampSec = this._frameIndex * frameDuration;
            // Snapshot the source: a reinit can swap it in the middle of an add operation.
            const source = this._videoSource;
            try {
                await source.add(timestampSec, frameDuration);
            } catch (err) {
                if (!this._active) return;
                if (source !== this._videoSource) {
                    requestAnimationFrame(() => this._captureLoop());
                    return;
                }
                throw err;
            }
            this._frameIndex++;
        }

        this._pruneIfDue();
        requestAnimationFrame(() => this._captureLoop());
    }

    /** @private */
    _pruneIfDue() {
        const now = performance.now();
        if (now - this._lastPruneTime < 1000) return;
        this._lastPruneTime = now;

        const elapsed = this._elapsedSeconds();
        const cutoff = elapsed - (this.bufferSeconds + this.keyframeInterval + 1);
        this._videoChunks = this._videoChunks.filter((c) => c.timestamp >= cutoff);
        this._audioChunks = this._audioChunks.filter((c) => c.timestamp >= cutoff);
    }

    /**
     * @param {{ add(packet: EncodedPacket, meta?: object): Promise<void> }} source
     * @param {BufferedPacket} chunk
     * @param {number} firstTs
     * @param {VideoDecoderConfig | AudioDecoderConfig | null} decoderConfig
     * @param {boolean} isFirst
     * @private
     */
    async _addPacket(source, chunk, firstTs, decoderConfig, isFirst) {
        const normalized = chunk.pkt.clone({ timestamp: chunk.timestamp - firstTs });
        await source.add(normalized, isFirst ? { decoderConfig } : {});
    }

    /**
     * @param {BufferedVideoPacket[]} videoChunks
     * @param {BufferedPacket[]} audioChunks
     * @param {number} firstTs
     * @returns {Promise<Blob>}
     * @private
     */
    async _mux(videoChunks, audioChunks, firstTs) {
        const containerDef = CONTAINERS[this.container];
        const outputFormat = new containerDef.Format(containerDef.buffer);
        const output = new Output({ format: outputFormat, target: new BufferTarget() });

        const videoSource = new EncodedVideoPacketSource(this._videoCodec);
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
                    this.videoDecoderConfig,
                    !videoConfigSent
                );
                videoConfigSent = true;
                vi++;
            } else {
                await this._addPacket(
                    audioSource,
                    audioChunks[ai],
                    firstTs,
                    this.audioDecoderConfig,
                    !audioConfigSent
                );
                audioConfigSent = true;
                ai++;
            }
        }

        videoSource.close();
        if (audioSource) audioSource.close();
        await output.finalize();

        return new Blob([output.target.buffer], { type: outputFormat.mimeType });
    }
}
