import type { Quality, QualityLevel } from 'mediabunny';
import type { ContainerName } from './containers';

// --- Defaults ---

export const DEFAULT_FPS = 60;
export const DEFAULT_CONTAINER: ContainerName = 'mp4';
export const DEFAULT_VIDEO_QUALITY: QualityLevel = 'high';
export const DEFAULT_AUDIO_QUALITY: QualityLevel = 'very-high';
export const DEFAULT_BUFFER_SECONDS = 15;
export const DEFAULT_KEYFRAME_INTERVAL = 2;

// --- Audio capture ---

/** Stereo is assumed end to end. */
export const AUDIO_CHANNELS = 2;
/** Frames accumulated per tap message (~85-93 ms at 44.1-48 kHz). */
export const AUDIO_BLOCK_FRAMES = 4096;
/** Continuous silence before the tap reports its graph idle, in seconds. */
export const AUDIO_IDLE_SECONDS = 5;
/**
 * Encoded seconds allowed to queue before the feed drops audio. Live audio must
 * stay within ~1 s of wall time: a CPU bound encoder that falls behind skips
 * content to stay in sync rather than accumulate drift.
 */
export const AUDIO_MAX_QUEUED_SECONDS = 1;

/** Upper bound on GOP trim iterations when fitting a `targetMB` export. */
export const MAX_GOP_TRIM_STEPS = 64;

// --- Config ---

/** Settings shared by `Recorder` and `Replayer`. */
export interface MediaCaptureConfig {
    /** Target frame rate in Hz. */
    fps?: number;
    container?: ContainerName;
    /**
     * A target bitrate in bits/sec (positive integer), a qualitative level
     * ("very-low"|"low"|"medium"|"high"|"very-high"), or a mediabunny `Quality` instance.
     */
    videoQuality?: number | QualityLevel | Quality;
    /** Same shape as `videoQuality`. */
    audioQuality?: number | QualityLevel | Quality;
    /** Rate control mode applied to qualitative `videoQuality` levels. */
    bitrateMode?: 'constant' | 'variable';
    /**
     * The audio source: `false` for video only, `true` for automatic capture
     * of any audio graph on the page, or an `AudioNode` to tap directly
     * (e.g. a master gain/bus node, like Howler's).
     */
    audioNode?: boolean | AudioNode;
    /** Filename template, supports `YYYY`/`MM`/`DD`/`HH`/`mm`/`ss`, falls back to a timestamped name. */
    name?: string;
    /** Called with internal diagnostic messages. */
    onLog?: (message: string) => void;
    /** If true and `onLog` isn't provided, logs to console.debug. */
    debug?: boolean;
}

/** Drops the fields fixed at construction, leaving what `configure()` may override. */
export type ConfigOverrides<T> = Omit<T, 'name' | 'onLog' | 'debug'>;
