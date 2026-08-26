import { Mp4OutputFormat, MovOutputFormat, WebMOutputFormat, MkvOutputFormat } from 'mediabunny';

/**
 * Supported container formats.
 *
 * Each entry provides two option sets: `streaming` makes the output append only
 * (safe to write through a WritableStream, playable before finalize),
 * MP4/MOV express this via `fastStart`, WebM/MKV via `appendOnly`.
 * `buffer` is used with a BufferTarget, where append only isn't a concern.
 * @type {Record<'mp4'|'mov'|'webm'|'mkv', { Format: new (options?: object) => import('mediabunny').OutputFormat, streaming: object, buffer: object }>}
 */
export const CONTAINERS = {
    mp4: {
        Format: Mp4OutputFormat,
        streaming: { fastStart: 'fragmented' },
        buffer: { fastStart: 'in-memory' }
    },
    mov: {
        Format: MovOutputFormat,
        streaming: { fastStart: 'fragmented' },
        buffer: { fastStart: 'in-memory' }
    },
    webm: {
        Format: WebMOutputFormat,
        streaming: { appendOnly: true },
        buffer: {}
    },
    mkv: {
        Format: MkvOutputFormat,
        streaming: { appendOnly: true },
        buffer: {}
    }
};
