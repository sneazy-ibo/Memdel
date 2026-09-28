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

// mp4/mov and webm/mkv share their options
const ISOBMFF: Pick<ContainerDef, 'streaming' | 'buffer' | 'export'> = {
    streaming: { fastStart: 'fragmented' },
    buffer: { fastStart: false },
    export: { fastStart: 'in-memory' }
};

const MATROSKA: Pick<ContainerDef, 'streaming' | 'buffer' | 'export'> = {
    streaming: { appendOnly: true },
    buffer: {},
    export: {}
};

export const CONTAINERS: Record<ContainerName, ContainerDef> = {
    mp4: { Format: Mp4OutputFormat, ...ISOBMFF },
    mov: { Format: MovOutputFormat, ...ISOBMFF },
    webm: { Format: WebMOutputFormat, ...MATROSKA },
    mkv: { Format: MkvOutputFormat, ...MATROSKA }
};

/** Every supported container, in display order. */
export const CONTAINER_NAMES = Object.keys(CONTAINERS) as ContainerName[];
