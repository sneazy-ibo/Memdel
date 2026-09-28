import { AudioSample } from 'mediabunny';
import type { AudioTap } from './audio';
import { errorMessage } from './utils';
import { AUDIO_CHANNELS, AUDIO_MAX_QUEUED_SECONDS } from './constants';

/** A tap piped into a source. `detach` unsubscribes, `drain` awaits queued adds. */
export interface AudioFeed {
    detach: () => void;
    drain: () => Promise<void>;
    /** Tell the feed exactly when the owning recorder pauses/unpauses. */
    notifyPause: (paused: boolean) => void;
    /** e.g. `"218 delivered, 0 dropped"`, so callers can tell audio actually flowed. */
    describe: () => string;
}

// Sentinel for "not paused". Pause start timestamps are always >= 0.
const NOT_PAUSED = -1;

/**
 * Bridges tap blocks into an `AudioSampleSource`.
 *
 * Each block is stamped from its place on the audio context clock, mapped to
 * the shared pipeline origin, so buffered blocks land where they actually
 * occurred and a stall on the main thread can't shift the timeline. If the
 * context suspends, its clock freezes while wall time advances. On resume the
 * mapping is anchored again, turning the missing span into a gap mediabunny pads.
 *
 * @param originMs Shared wall clock origin (the video clock's), in ms.
 */
export function attachAudioTap(
    tap: AudioTap,
    source: { add(sample: AudioSample): Promise<void> },
    isPaused: () => boolean,
    log: (message: string) => void,
    originMs = performance.now()
): AudioFeed {
    const sampleRate = tap.ctx.sampleRate;

    let anchorWallMs = performance.now();
    let anchorFrame = tap.ctx.currentTime * sampleRate;
    let queuedSeconds = 0;
    let delivered = 0;
    let dropped = 0;
    let stalling = false;
    let failed = false;
    let queue = Promise.resolve();

    let pausedAt: number = NOT_PAUSED;
    let pausedAccumMs = 0;

    const timestampFor = (frameStart: number) =>
        (anchorWallMs + ((frameStart - anchorFrame) / sampleRate) * 1000 - originMs) / 1000 -
        pausedAccumMs / 1000;

    // Point the anchor at "now" on both clocks. Used on statechange and resume.
    const realign = () => {
        anchorWallMs = performance.now();
        anchorFrame = tap.ctx.currentTime * sampleRate;
    };

    const onState = () => {
        if (tap.ctx.state === 'running') realign();
    };
    tap.ctx.addEventListener('statechange', onState);

    const offBlock = tap.onBlock((data, frameStart) => {
        if (isPaused()) return;
        if (queuedSeconds >= AUDIO_MAX_QUEUED_SECONDS) {
            dropped++;
            if (!stalling) {
                stalling = true;
                log('Audio encoder overloaded, dropping audio');
            }
            return;
        }
        stalling = false;

        const timestamp = timestampFor(frameStart);
        if (timestamp < 0) return; // block predates the pipeline origin
        delivered++;
        const duration = data.length / AUDIO_CHANNELS / sampleRate;
        const sample = new AudioSample({
            data,
            format: 'f32-planar',
            numberOfChannels: AUDIO_CHANNELS,
            sampleRate,
            timestamp
        });
        queuedSeconds += duration;
        queue = queue.then(async () => {
            try {
                await source.add(sample);
            } catch (err) {
                if (!failed) {
                    failed = true;
                    log(`Audio source error: ${errorMessage(err)}`);
                }
            } finally {
                sample.close();
                queuedSeconds -= duration;
            }
        });
    });

    return {
        detach: () => {
            offBlock();
            tap.ctx.removeEventListener('statechange', onState);
        },
        drain: () => queue,
        notifyPause: (paused) => {
            const now = performance.now();
            if (paused === (pausedAt !== NOT_PAUSED)) return;
            if (paused) {
                pausedAt = now;
            } else {
                pausedAccumMs += now - pausedAt;
                pausedAt = NOT_PAUSED;
                // The context may have kept running through the pause while wall
                // time advanced (sleep), so anchor again before stamping.
                realign();
            }
        },
        describe: () => `${delivered} delivered, ${dropped} dropped`
    };
}
