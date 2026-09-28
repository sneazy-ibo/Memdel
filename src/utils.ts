import { Quality, canEncodeVideo, type QualityLevel, type VideoCodec } from 'mediabunny';
import { ContainerName, CONTAINERS } from './containers';

/**
 * Latency modes to try per codec, best first. Platform encoders are picky about
 * latency mode (Firefox's H.264 fails in realtime, for example), so both are
 * probed for H.264/HEVC; software codecs are quality-only.
 */
function latencyModesForCodec(codec: VideoCodec): Array<'realtime' | 'quality'> {
    return codec === 'avc' || codec === 'hevc' ? ['realtime', 'quality'] : ['quality'];
}

/** A codec that can be encoded, together with the latency mode that works for it. */
export interface EncodableVideoCodec {
    codec: VideoCodec;
    latencyMode: 'realtime' | 'quality';
}

/**
 * Pick the first codec the browser can encode with the exact config the pipeline
 * will use, probing each candidate latency mode. mediabunny's Firefox probe
 * reflects on the options, so passing the real config rejects a codec/mode the
 * platform can't handle (Firefox H.264 in realtime) before the first frame.
 *
 * `getFirstEncodableVideoCodec` can't be used: its options type drops `latencyMode`.
 */
export async function findEncodableVideoCodec(
    codecs: VideoCodec[],
    options: { width: number; height: number; quality: Quality }
): Promise<EncodableVideoCodec | null> {
    for (const codec of codecs) {
        for (const latencyMode of latencyModesForCodec(codec)) {
            if (await canEncodeVideo(codec, { ...options, latencyMode })) {
                return { codec, latencyMode };
            }
        }
    }
    return null;
}

/** Coerce a thrown value into a message, for logs. */
export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Wrap a logger so the same error message is only logged once. */
export function dedupeErrors(
    log: (message: string, level?: 'error') => void,
    prefix: string
): (err: unknown) => void {
    let last: string | null = null;
    return (err) => {
        const message = errorMessage(err);
        if (message === last) return;
        last = message;
        log(`${prefix}${message}`, 'error');
    };
}

/** Most video encoders require even dimensions. */
export function toEven(value: number): number {
    return value & ~1;
}

/** Contain into the even encode box, with a `transform` only when the canvas is odd. */
export function canvasFitOptions(
    canvas: HTMLCanvasElement,
    width: number,
    height: number
): {
    sizeChangeBehavior: 'contain';
    transform?: { width: number; height: number; fit: 'contain' };
} {
    const odd = (canvas.width & 1) === 1 || (canvas.height & 1) === 1;
    return odd
        ? { sizeChangeBehavior: 'contain', transform: { width, height, fit: 'contain' } }
        : { sizeChangeBehavior: 'contain' };
}

/** Whether this browser exposes the WebCodecs APIs memdel needs. */
export function webCodecsSupported(): boolean {
    return typeof window !== 'undefined' && 'VideoEncoder' in window && 'VideoFrame' in window;
}

/**
 * Numbers are bitrates in bits/sec, strings are quality levels. `bitrateMode`
 * applies only to qualitative levels. Explicit bitrates and prebuilt
 * `Quality` instances pass through untouched.
 */
export function toQuality(
    value: number | QualityLevel | Quality,
    bitrateMode?: 'constant' | 'variable'
): Quality {
    if (value instanceof Quality) return value;
    if (typeof value === 'number') return new Quality({ bitrate: value });
    return new Quality({ quality: value, bitrateMode });
}

const DOWNLOAD_REVOKE_MS = 1000;

export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), {
        href: url,
        download: filename
    });
    a.click();
    // Revoking too early cancels the download in Firefox/Safari.
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_MS);
}

const HIDE_DEBOUNCE_MS = 750;

/**
 * Fire `onHidden` once the tab has been hidden for `ms` continuously, and
 * `onShow` whenever it becomes visible again. Returns a teardown function.
 * If throttled or frozen timers ate the hidden callback (Firefox), a hide long
 * enough still fires `onHidden` retroactively, right before `onShow`.
 */
export function onVisibilityChange(
    { onHidden, onShow }: { onHidden: () => void; onShow?: () => void },
    ms = HIDE_DEBOUNCE_MS
): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let hiddenAt = 0;
    let hiddenFired = false;
    const handler = () => {
        if (timer !== null) clearTimeout(timer);
        if (document.hidden) {
            hiddenAt = Date.now();
            hiddenFired = false;
            timer = setTimeout(() => {
                if (document.hidden) {
                    hiddenFired = true;
                    onHidden();
                }
            }, ms);
        } else {
            if (!hiddenFired && hiddenAt && Date.now() - hiddenAt >= ms) onHidden();
            hiddenAt = 0;
            onShow?.();
        }
    };
    document.addEventListener('visibilitychange', handler);
    return () => {
        if (timer !== null) clearTimeout(timer);
        document.removeEventListener('visibilitychange', handler);
    };
}

/** Create a bound logger that captures the class's onLog / debug config. */
export function createLogger(
    onLog: ((message: string) => void) | null,
    debug: boolean
): (message: string, level?: 'error') => void {
    return (message, level) => {
        if (onLog) onLog(message);
        else if (level === 'error') console.error('[memdel]', message);
        else if (debug) console.debug('[memdel]', message);
    };
}

/**
 * Build a filename from a name template or a timestamped fallback, using the
 * container's extension. With `seconds` the fallback includes the clip length.
 */
export function generateOutputFilename(
    name: string,
    container: ContainerName,
    seconds?: number
): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const fallback =
        seconds !== undefined
            ? `replay_YYYY-MM-DD_HH-mm-ss_${Math.round(seconds)}s`
            : 'recording-YYYY-MM-DD_HH-mm-ss';
    const tokens: Record<string, string | number> = {
        YYYY: now.getFullYear(),
        MM: pad(now.getMonth() + 1),
        DD: pad(now.getDate()),
        HH: pad(now.getHours()),
        mm: pad(now.getMinutes()),
        ss: pad(now.getSeconds())
    };
    const ext = new CONTAINERS[container].Format().fileExtension.replace(/^\./, '');
    const stem = (name.trim() || fallback).replace(/YYYY|MM|DD|HH|mm|ss/g, (match) =>
        String(tokens[match])
    );
    return `${stem}.${ext}`;
}
