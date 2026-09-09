import { Mp4OutputFormat, MovOutputFormat, WebMOutputFormat, MkvOutputFormat } from 'mediabunny';

/**
 * Muxing options per container: `streaming` for append-only disk writes,
 * `buffer` for progressive download mode, `export` for Replayer clips with moov first.
 * @typedef {{ Format: new (options?: object) => import('mediabunny').OutputFormat, streaming: object, buffer: object, export: object }} ContainerDef
 */

/** @type {Record<'mp4'|'mov'|'webm'|'mkv', ContainerDef>} */
export const CONTAINERS = {
    mp4: {
        Format: Mp4OutputFormat,
        streaming: { fastStart: 'fragmented' },
        buffer: { fastStart: false },
        export: { fastStart: 'in-memory' }
    },
    mov: {
        Format: MovOutputFormat,
        streaming: { fastStart: 'fragmented' },
        buffer: { fastStart: false },
        export: { fastStart: 'in-memory' }
    },
    webm: {
        Format: WebMOutputFormat,
        streaming: { appendOnly: true },
        buffer: {},
        export: {}
    },
    mkv: {
        Format: MkvOutputFormat,
        streaming: { appendOnly: true },
        buffer: {},
        export: {}
    }
};
