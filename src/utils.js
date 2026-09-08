import { Quality } from 'mediabunny';
import { CONTAINERS } from './containers.js';

/**
 * Numbers are treated as bitrates in bits/sec, strings are quality levels.
 * @param {number|import('mediabunny').QualityLevel|Quality} value
 * @returns {Quality}
 */
export function toQuality(value) {
    if (value instanceof Quality) return value;
    if (typeof value === 'number') return new Quality({ bitrate: value });
    return new Quality(value);
}

/**
 * Trigger a browser download for a Blob.
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
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
 * @param {{ onHidden: () => void, onShow?: () => void }} callbacks
 * @param {number} [ms=750]
 * @returns {() => void} teardown
 */
export function onVisibilityChange({ onHidden, onShow }, ms = 750) {
    let timer = null;
    const handler = () => {
        clearTimeout(timer);
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
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', handler);
    };
}

/**
 * Render a filename template using a small set of date tokens
 * against the current time, and append an extension.
 * Falls back to `fallbackTemplate` when `template` is blank.
 *
 * e.g. `generateFilename("clip_YYYY-MM-DD")` -> `"clip_2026-08-22.mp4"`
 *
 * @param {string} template
 * @param {string} fallbackTemplate
 * @param {string} [extension="mp4"]
 * @returns {string}
 */
export function generateFilename(template, fallbackTemplate, extension = 'mp4') {
    const tpl = template?.trim() || fallbackTemplate;
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const tokens = {
        YYYY: now.getFullYear(),
        MM: pad(now.getMonth() + 1),
        DD: pad(now.getDate()),
        HH: pad(now.getHours()),
        mm: pad(now.getMinutes()),
        ss: pad(now.getSeconds())
    };
    const name = tpl.replace(/YYYY|MM|DD|HH|mm|ss/g, (match) => tokens[match]);
    return `${name}.${extension}`;
}

/**
 * Create a bound logger that captures the class's onLog / debug config.
 * @param {((message: string) => void) | null} onLog
 * @param {boolean} debug
 * @returns {(message: string) => void}
 */
export function createLogger(onLog, debug) {
    return (message) => {
        if (onLog) onLog(message);
        else if (debug) console.debug('[memdel]', message);
    };
}

/**
 * Build a filename from a name template or a timestamped fallback, using the
 * container's extension. With `seconds` the fallback includes the clip length.
 * @param {string} name
 * @param {'mp4' | 'mov' | 'webm' | 'mkv'} container
 * @param {number} [seconds]
 * @returns {string}
 */
export function generateOutputFilename(name, container, seconds) {
    const ext = new CONTAINERS[container].Format().fileExtension.replace(/^\./, '');
    const fallback =
        seconds !== undefined
            ? `replay_YYYY-MM-DD_HH-mm-ss_${Math.round(seconds)}s`
            : 'recording-YYYY-MM-DD_HH-mm-ss';
    return generateFilename(name, fallback, ext);
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
 * @param {AudioNode} node
 * @returns {{ ctx: AudioContext, channelCount: number, track: MediaStreamAudioTrack, disconnect: () => void } | null}
 */
export function tapAudioNode(node) {
    const ctx = /** @type {AudioContext} */ (node.context);
    if (ctx.state === 'closed') return null;
    const dest = ctx.createMediaStreamDestination();
    const [track] = dest.stream.getAudioTracks();
    node.connect(dest);
    return {
        ctx,
        channelCount: dest.channelCount,
        track: /** @type {MediaStreamAudioTrack} */ (track),
        disconnect: () => node.disconnect(dest)
    };
}
