import { Quality, type QualityLevel } from 'mediabunny';
import { ContainerName, CONTAINERS } from './containers';

/**
 * Numbers are treated as bitrates in bits/sec, strings are quality levels.
 */
export function toQuality(value: number | QualityLevel | Quality): Quality {
    if (value instanceof Quality) return value;
    if (typeof value === 'number') return new Quality({ bitrate: value });
    return new Quality(value);
}

/** Trigger a browser download for a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), {
        href: url,
        download: filename
    });
    a.click();
    URL.revokeObjectURL(url);
}

/**
 * Fire `onHidden` once the tab has been hidden for `ms` continuously, and
 * `onShow` whenever it becomes visible again. Returns a teardown function.
 */
export function onVisibilityChange(
    { onHidden, onShow }: { onHidden: () => void; onShow?: () => void },
    ms = 750
): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
        clearTimeout(timer!);
        if (document.hidden) {
            timer = setTimeout(() => {
                if (document.hidden) onHidden();
            }, ms);
        } else {
            onShow?.();
        }
    };
    document.addEventListener('visibilitychange', handler);
    return () => {
        clearTimeout(timer!);
        document.removeEventListener('visibilitychange', handler);
    };
}

/**
 * Render a filename template using a small set of date tokens
 * against the current time, and append an extension.
 * Falls back to `fallbackTemplate` when `template` is blank.
 *
 * e.g. `generateFilename("clip_YYYY-MM-DD")` -> `"clip_2026-08-22.mp4"`
 */
export function generateFilename(
    template: string,
    fallbackTemplate: string,
    extension = 'mp4'
): string {
    const tpl = template.trim() || fallbackTemplate;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const tokens: Record<string, string | number> = {
        YYYY: now.getFullYear(),
        MM: pad(now.getMonth() + 1),
        DD: pad(now.getDate()),
        HH: pad(now.getHours()),
        mm: pad(now.getMinutes()),
        ss: pad(now.getSeconds())
    };
    const name = tpl.replace(/YYYY|MM|DD|HH|mm|ss/g, (match) => String(tokens[match]));
    return `${name}.${extension}`;
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
    const ext = new CONTAINERS[container].Format().fileExtension.replace(/^\./, '');
    const fallback =
        seconds !== undefined
            ? `replay_YYYY-MM-DD_HH-mm-ss_${Math.round(seconds)}s`
            : 'recording-YYYY-MM-DD_HH-mm-ss';
    return generateFilename(name, fallback, ext);
}

export interface AudioTap {
    ctx: AudioContext;
    channelCount: number;
    track: MediaStreamAudioTrack;
    disconnect: () => void;
}

/**
 * Taps an audio node by connecting it to a MediaStream track destination,
 * so its output can be captured and encoded while still playing normally.
 *
 * The destination is created on `node.context`, to pass any node of a
 * live graph (e.g. a master gain). Call `disconnect()` on the result when
 * done recording, the node keeps working in the graph either way.
 *
 * `ctx` and `channelCount` are returned explicitly because
 * `track.getSettings()` doesn't reliably report them on all browsers.
 *
 * Returns `null` when the node's context is closed, so no audio can be captured.
 */
export function tapAudioNode(node: AudioNode): AudioTap | null {
    const ctx = node.context as AudioContext;
    if (ctx.state === 'closed') return null;
    const dest = ctx.createMediaStreamDestination();
    const [track] = dest.stream.getAudioTracks();
    node.connect(dest);
    return {
        ctx,
        channelCount: dest.channelCount,
        track: track as MediaStreamAudioTrack,
        disconnect: () => node.disconnect(dest)
    };
}
