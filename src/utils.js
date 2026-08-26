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
 * Fire `callback` when the tab has been hidden for `ms` continuously.
 * Returns a teardown function that removes the listener.
 * @param {() => void} callback
 * @param {number} [ms=750]
 * @returns {() => void} teardown
 */
export function onHiddenDebounced(callback, ms = 750) {
    let timer = null;
    const handler = () => {
        clearTimeout(timer);
        if (document.hidden) {
            timer = setTimeout(() => {
                if (document.hidden) callback();
            }, ms);
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
 * @returns {{ ctx: AudioContext, channelCount: number, track: MediaStreamAudioTrack, disconnect: () => void }}
 */
export function tapAudioNode(node) {
    const ctx = /** @type {AudioContext} */ (node.context);
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
