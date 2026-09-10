import {
    Mp4OutputFormat,
    MovOutputFormat,
    WebMOutputFormat,
    MkvOutputFormat,
    type IsobmffOutputFormatOptions,
    type MkvOutputFormatOptions,
    type OutputFormat
} from 'mediabunny';

export type ContainerName = 'mp4' | 'mov' | 'webm' | 'mkv';

export interface ContainerDef {
    // `object` because each constructor only accepts its own options type
    Format: new (options?: object) => OutputFormat;
    /** Appends only, safe to stream to disk */
    streaming: IsobmffOutputFormatOptions | MkvOutputFormatOptions;
    /** Writes progressively, metadata sits at the end */
    buffer: IsobmffOutputFormatOptions | MkvOutputFormatOptions;
    /** moov at the front, ready to stream or share the moment it lands */
    export: IsobmffOutputFormatOptions | MkvOutputFormatOptions;
}

export const CONTAINERS: Record<ContainerName, ContainerDef> = {
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
