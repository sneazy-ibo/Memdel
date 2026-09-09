import {
    Quality,
    Output,
    NullTarget,
    BufferTarget,
    MediaStreamVideoTrackSource,
    MediaStreamAudioTrackSource,
    EncodedVideoPacketSource,
    EncodedAudioPacketSource,
    getFirstEncodableVideoCodec,
    getFirstEncodableAudioCodec
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

// Aiming under targetMB so normal size variance doesn't trigger the trim cap
const TARGET_AIM = 0.95;

/**
 * @typedef {import('mediabunny').QualityLevel} QualityLevel
 * @typedef {import('mediabunny').EncodedPacket} EncodedPacket
 * @typedef {import('mediabunny').PacketType} PacketType
 */

/**
 * A raw encoded packet held in the rolling buffer, stamped on the recording timeline.
 * @typedef {Object} BufferedPacket
 * @property {EncodedPacket} pkt
 * @property {number} timestamp
 */

/** @typedef {BufferedPacket & { type: PacketType }} BufferedVideoPacket */

/**
 * @typedef {Object} ReplayerConfig
 * @property {number}   [fps=60]
 * @property {'mp4' | 'mov' | 'webm' | 'mkv'} [container="mp4"]
 * @property {number|QualityLevel|Quality} [videoQuality="high"]
 * @property {number|QualityLevel|Quality} [audioQuality="very-high"]
 * @property {AudioNode} [audioNode]
 * @property {number} [targetMB]
 * @property {'constant' | 'variable'} [bitrateMode="constant"]
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
        this.targetMB = options.targetMB;
        this.bitrateMode = options.bitrateMode ?? 'constant';

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

        /** @type {Quality} */
        this._resolvedVideoQuality = this.videoQuality;
        /** @type {Quality} */
        this._resolvedAudioQuality = this.audioQuality;
        /** @type {number|null} */
        this._requestedVideoBitrate = null;
        this._sizeCorrection = 1;

        // --- Live capture pipeline ---
        this._holdingOutput = null;
        /** @type {MediaStream|null} */
        this._captureStream = null;
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
     * Encoded packet byte size an export of `seconds` would produce right now,
     * including the targetMB cap an export would apply.
     * @param {number} [seconds=this.bufferSeconds]
     * @returns {number|null}
     */
    estimateExportBytes(seconds = this.bufferSeconds) {
        const clip = this._selectExportWindow(seconds);
        if (!clip) return null;
        const { exportVideo, exportAudio } = clip;
        const audioBytes = this._sumBytes(exportAudio);
        let videoBytes = this._sumBytes(exportVideo);
        if (!this._targetMBActive()) return Math.round(videoBytes + audioBytes);

        // An export over the budget trims GOP at the front, walk them off the same way
        // so the estimate matches the muxed result instead of the raw window.
        const lastTs = exportVideo.at(-1).timestamp;
        const span = lastTs - exportVideo[0].timestamp || 1;
        let start = 0;
        let size = videoBytes + audioBytes;
        while (size > this.targetMB * 1e6) {
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
     * @typedef {Pick<ReplayerConfig, 'fps' | 'container' | 'videoQuality' | 'audioQuality' | 'targetMB' | 'bitrateMode' | 'bufferSeconds' | 'keyframeInterval' | 'audioNode'>} ReplayerConfigOverrides
     * @param {ReplayerConfigOverrides} [config]
     */
    async configure({
        fps,
        container,
        videoQuality,
        audioQuality,
        targetMB,
        bitrateMode,
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
        if (targetMB !== undefined) this.targetMB = targetMB;
        const prevBitrateMode = this.bitrateMode;
        if (bitrateMode !== undefined) this.bitrateMode = bitrateMode;

        const targetMBActive = this._targetMBActive();
        const qualityChange = videoQuality !== undefined || audioQuality !== undefined;
        const encoderChanged =
            (qualityChange && !targetMBActive) ||
            container !== undefined ||
            targetMB !== undefined ||
            (targetMBActive && bufferSeconds !== undefined);
        const rebuild =
            encoderChanged ||
            fps !== undefined ||
            (bitrateMode !== undefined && bitrateMode !== prevBitrateMode && targetMBActive) ||
            (audioNode !== undefined && audioNode !== this.audioNode);

        if (container !== undefined) this.container = container;
        if (videoQuality !== undefined) this.videoQuality = toQuality(videoQuality);
        if (audioQuality !== undefined) this.audioQuality = toQuality(audioQuality);
        if (audioNode !== undefined) this.audioNode = audioNode;

        if (rebuild && this._active) await this._reinitSources(encoderChanged);
    }

    pause() {
        if (!this._active) throw new Error('Not recording.');
        if (this._paused) return;
        this._paused = true;
        this._videoSource?.pause();
        this._audioSource?.pause();
        this.onPause?.();
    }

    resume() {
        if (!this._active) throw new Error('Not recording.');
        if (!this._paused) return;
        this._videoSource?.resume();
        this._audioSource?.resume();
        this._paused = false;
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

        // Automatically pause while hidden, debounced so brief hides (e.g. DevTools) don't trigger
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
            exportVideo.at(-1).timestamp - exportVideo[0].timestamp + 1 / this.fps;
        const fullSeconds = clipLen();

        const targeting = this._targetMBActive();
        const targetBytes = targeting ? this.targetMB * 1e6 : 0;

        let blob = await muxWindow();
        const fullBlobSize = blob.size;

        // When over budet: drop the oldest key frame groups and remux until it fits
        let droppedGOPs = 0;
        if (targeting) {
            let guard = 0;
            while (blob.size > targetBytes && guard++ < 64) {
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
            this._sizeCorrection = this._smoothRatio(this._sizeCorrection, next, 0.5, 2);
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
        this._log(`Export complete - ${(blob.size / 1e6).toFixed(2)} MB${targetNote}`);
        this.onExport?.(result);

        return blob;
    }

    /** @private */
    _targetMBActive() {
        return typeof this.targetMB === 'number' && this.targetMB > 0;
    }

    /**
     * The last `seconds` of the footage, starting on the keyframe at or before the window start.
     * @private
     * @param {number} seconds
     * @returns {{ exportVideo: BufferedVideoPacket[], exportAudio: BufferedPacket[] } | null}
     */
    _selectExportWindow(seconds) {
        const video = this._videoChunks;
        if (!video.length) return null;
        const lastTs = video.at(-1).timestamp;
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
        const endTs = video[start].timestamp + seconds;
        const end = video.findIndex((c) => c.timestamp > endTs);
        const exportVideo = video.slice(start, end < 0 ? undefined : end);
        const exportAudio = this._audioChunks.filter(
            (c) =>
                c.timestamp >= exportVideo[0].timestamp &&
                c.timestamp <= exportVideo.at(-1).timestamp
        );
        return { exportVideo, exportAudio };
    }

    /**
     * Smooth a measured ratio into `current` (EMA, alpha 0.3), clamped to `[min, max]`.
     * @private
     * @param {number} current
     * @param {number} measured
     * @param {number} min
     * @param {number} max
     * @returns {number}
     */
    _smoothRatio(current, measured, min, max) {
        if (!Number.isFinite(measured) || measured <= 0) return current;
        return Math.min(max, Math.max(min, current + 0.3 * (measured - current)));
    }

    /**
     * Observed audio bitrate in the buffer, `null` with too little data.
     * @private
     */
    _measuredAudioBitrate() {
        const chunks = this._audioChunks;
        if (chunks.length < 2) return null;
        const span = chunks.at(-1).timestamp - chunks[0].timestamp;
        if (span <= 0) return null;
        return (this._sumBytes(chunks) * 8) / span;
    }

    /**
     * Video Quality sized so a full export window lands at `TARGET_AIM` of `targetMB`.
     * @private
     * @param {number} audioBitrate
     * @returns {Quality}
     */
    _targetVideoQuality(audioBitrate) {
        const targetBits = this.targetMB * 1e6 * 8;
        const perSecondBits = targetBits / Math.max(1 / this.fps, this.bufferSeconds);
        const available = (perSecondBits - audioBitrate) * this._sizeCorrection;
        if (available < 1000) {
            this._log(
                `targetMB (${this.targetMB} MB) is too small for a ${this.bufferSeconds}s clip: ` +
                    `audio alone needs ~${Math.round(audioBitrate / 1000)} kbps of the ` +
                    `~${Math.round(perSecondBits / 1000)} kbps budget. Video pinned to 1 kbps and the ` +
                    `export will exceed the target.`
            );
        }
        this._requestedVideoBitrate = Math.round(Math.max(1000, available));
        return new Quality({ bitrate: this._requestedVideoBitrate, bitrateMode: this.bitrateMode });
    }

    /**
     * @param {BufferedPacket[]} chunks
     * @private
     */
    _sumBytes(chunks) {
        return chunks.reduce((sum, c) => sum + c.pkt.byteLength, 0);
    }

    /** @private */
    async _selectCodecs() {
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
            this._resolvedVideoQuality = this.videoQuality;
        }

        const videoCodec = await getFirstEncodableVideoCodec(format.getSupportedVideoCodecs(), {
            width: this._encodeWidth,
            height: this._encodeHeight,
            quality: this._resolvedVideoQuality
        });
        if (!videoCodec) throw new Error('No supported video codec found.');

        return { videoCodec, audioCodec };
    }

    /** @private */
    async _initSources(videoTail = null, audioTail = null) {
        const containerDef = CONTAINERS[this.container];
        this._holdingOutput = new Output({
            format: new containerDef.Format(containerDef.streaming),
            target: new NullTarget()
        });

        this._captureStream = this.canvas.captureStream(this.fps);
        const [videoTrack] = this._captureStream.getVideoTracks();

        // Fresh sources stamp from 0, offset packets to continue the kept buffer
        const videoOffset = videoTail ?? 0;
        const audioOffset = audioTail ?? 0;

        this._videoSource = new MediaStreamVideoTrackSource(videoTrack, {
            codec: this._videoCodec,
            quality: this._resolvedVideoQuality,
            contentHint: 'motion',
            sizeChangeBehavior: 'contain',
            keyFrameInterval: this.keyframeInterval,
            transform: {
                width: this._encodeWidth,
                height: this._encodeHeight,
                fit: 'contain'
            },
            onEncodedPacket: (pkt, meta) => {
                if (meta?.decoderConfig && !this.videoDecoderConfig)
                    this.videoDecoderConfig = meta.decoderConfig;
                const ts = pkt.timestamp + videoOffset;
                this._videoChunks.push({ pkt, timestamp: ts, type: pkt.type });
                this._pruneIfDue();
                this.onVideoPacket?.(pkt, meta);
            }
        });
        this._videoSource.errorPromise.catch((err) => {
            this._log(`Video source error: ${err?.message ?? err}, 'error'`);
        });
        this._holdingOutput.addVideoTrack(this._videoSource, { frameRate: this.fps });

        if (this.audioNode && this._audioCodec) {
            this._audioTap = tapAudioNode(this.audioNode);
            if (!this._audioTap) {
                this._log('Audio context is closed; recording video only');
            } else {
                this._audioSource = new MediaStreamAudioTrackSource(this._audioTap.track, {
                    codec: this._audioCodec,
                    quality: this._resolvedAudioQuality,
                    onEncodedPacket: (pkt, meta) => {
                        if (meta?.decoderConfig && !this.audioDecoderConfig)
                            this.audioDecoderConfig = meta.decoderConfig;
                        this._audioChunks.push({ pkt, timestamp: pkt.timestamp + audioOffset });
                        this.onAudioPacket?.(pkt, meta);
                    }
                });
                this._audioSource.errorPromise.catch((err) => {
                    this._log(`Audio source error: ${err?.message ?? err}, 'error'`);
                });
                this._holdingOutput.addAudioTrack(this._audioSource);
            }
        }

        await this._holdingOutput.start();
    }

    /** @private */
    async _teardownSources() {
        const { _videoSource, _audioSource, _audioTap } = this;
        this._videoSource = null;
        this._audioSource = null;
        _videoSource?.close();
        _audioSource?.close();
        await this._holdingOutput?.cancel();
        _audioTap?.disconnect();
        this._audioTap = null;
        this._holdingOutput = null;
        this._captureStream?.getVideoTracks().forEach((t) => t.stop());
        this._captureStream = null;
    }

    /**
     * Rebuild the capture pipeline, keeping buffered packets unless `resetBuffer`.
     * @private
     * @param {boolean} resetBuffer
     */
    async _reinitSources(resetBuffer) {
        const { videoCodec, audioCodec } = await this._selectCodecs();
        this._videoCodec = videoCodec;
        this._audioCodec = audioCodec;

        const videoTail = resetBuffer ? null : (this._videoChunks.at(-1)?.timestamp ?? null);
        // If no buffered audio yet, continue from the video tail
        const audioTail = resetBuffer ? null : (this._audioChunks.at(-1)?.timestamp ?? videoTail);

        await this._teardownSources();
        if (resetBuffer) {
            this.videoDecoderConfig = null;
            this.audioDecoderConfig = null;
            this._videoChunks = [];
            this._audioChunks = [];
        }
        await this._initSources(videoTail, audioTail);

        this._log(
            `Pipeline reinitialized - video: ${videoCodec} | audio: ${audioCodec ?? 'none'}${resetBuffer ? ' (buffer reset)' : ''}`
        );
    }

    /**
     * Trim the rolling buffer which is throttled to 1/s
     * @private
     */
    _pruneIfDue() {
        const now = performance.now();
        if (now - this._lastPruneTime < 1000) return;
        this._lastPruneTime = now;

        // Retention follows footage time instead of wall clock
        const lastTs = this._videoChunks.at(-1)?.timestamp;
        if (lastTs === undefined) return;
        const cutoff = lastTs - (this.bufferSeconds + this.keyframeInterval + 1);
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
        const outputFormat = new containerDef.Format(containerDef.export);
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
