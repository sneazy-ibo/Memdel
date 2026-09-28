import type { AudioCodec } from 'mediabunny';
import { AUDIO_BLOCK_FRAMES, AUDIO_CHANNELS, AUDIO_IDLE_SECONDS } from './constants';

export interface AudioTap {
    ctx: AudioContext;
    /**
     * Subscribes to live planar f32 blocks (fresh per event, keep them freely).
     * `frameStart` is the audio context frame index of the block's first sample.
     * @returns unsubscribe.
     */
    onBlock(listener: (data: Float32Array, frameStart: number) => void): () => void;
    /** Auto taps stay armed for reuse, so only direct taps drop their edges. */
    disconnect: () => void;
}

/**
 * The first tap with a running context that is actually fed, preferring graphs
 * the page still feeds over ones whose edges went away. `null` until any exists.
 * Taps persist, so later recordings reuse them.
 */
export function getAudioTap(): AudioTap | null {
    let idle: AudioTap | null = null;
    for (const [ctx, tap] of taps) {
        if (ctx.state === 'closed' || tap.dead) {
            taps.delete(ctx);
            continue;
        }
        if (ctx.state !== 'running' || !tap.fed) continue;
        const candidate = wrapTap(ctx, tap);
        if (tap.live !== false) return candidate;
        idle ??= candidate;
    }
    return idle;
}

/** Resolves with the first live tap, immediately when one exists. */
export function waitForAudioTap(): Promise<AudioTap | null> {
    const tap = getAudioTap();
    if (tap) return Promise.resolve(tap);
    if (!autoTapSupported()) return Promise.resolve(null);
    return new Promise((resolve) => tapWaiters.add(() => resolve(getAudioTap())));
}

/** Direct node tap: routes the node through the context's silent worklet tap. */
export function tapAudioNode(node: AudioNode): AudioTap | null {
    const ctx = node.context as AudioContext;
    if (ctx.state === 'closed' || isOffline(ctx)) return null;
    const tap = ensureTap(ctx);
    if (!tap) return null;
    attach(tap, node);
    if (!tap.fed) {
        tap.fed = true;
        fireTapWaiters();
    }
    return {
        ctx,
        onBlock: tap.onBlock,
        disconnect: () => {
            tap.waiting.delete(node);
            try {
                if (tap.node) node.disconnect(tap.node);
            } catch {}
        }
    };
}

export function autoTapSupported(): boolean {
    return (
        typeof AudioContext !== 'undefined' &&
        typeof AudioWorkletNode !== 'undefined' &&
        'audioWorklet' in AudioContext.prototype &&
        isSecureContext
    );
}

/** Why a requested tap produced nothing. */
function audioTapFailureMessage(audioNode: boolean | AudioNode): string {
    if (audioNode !== true)
        return 'Audio node context unavailable (closed or offline), recording video only';
    return autoTapSupported()
        ? 'No audio graph yet, recording video only'
        : 'Audio capture needs a secure context, recording video only';
}

/** Acquire the tap for an `audioNode` option, logging why there is none. */
export function acquireAudioTap(
    audioNode: true | AudioNode,
    log: (message: string) => void
): AudioTap | null {
    const tap = audioNode === true ? getAudioTap() : tapAudioNode(audioNode);
    if (!tap) log(audioTapFailureMessage(audioNode));
    return tap;
}

export function describeAudioReady(codec: AudioCodec, tap: AudioTap): string {
    return `Audio ready (codec: ${codec}, sampleRate: ${tap.ctx.sampleRate}, channels: ${AUDIO_CHANNELS}, ctx: ${tap.ctx.state})`;
}

/**
 * Resumes every tapped context suspended by autoplay policy. Call from a
 * user gesture. Resumed taps wake `waitForAudioTap()` automatically.
 * @returns whether any suspended tap was found.
 */
export async function resumeTappedAudio(): Promise<boolean> {
    let found = false;
    for (const ctx of taps.keys()) {
        if (ctx.state === 'closed') {
            taps.delete(ctx);
            continue;
        }
        if (ctx.state !== 'suspended') continue;
        found = true;
        try {
            await ctx.resume();
        } catch {}
    }
    return found;
}

// --- Worklet tap ---

interface InternalTap {
    /** Null until the context's worklet has booted. */
    node: AudioWorkletNode | null;
    /** Nodes mirrored while booting. Connected once the worklet node exists. */
    waiting: Set<AudioNode>;
    listeners: Set<(data: Float32Array, frameStart: number) => void>;
    /** False until the page actually connects something into the tap. */
    fed: boolean;
    /** Set when booting failed (no worklet, strict CSP). The tap is dropped. */
    dead: boolean;
    /** Null until the worklet reports. False while the page feeds nothing. */
    live: boolean | null;
    onBlock(listener: (data: Float32Array, frameStart: number) => void): () => void;
}

const taps = new Map<AudioContext, InternalTap>();

const tapWaiters = new Set<() => void>();

/** Nodes owned by a tap, so the connect hook ignores them. */
const internalNodes = new WeakSet<AudioNode>();

let hookInstalled = false;

let moduleUrl: string | null = null;

// Ambient globals in the worklet scope, missing from TS lib.dom. Types only,
// erased at emit. At runtime they resolve inside the AudioWorkletGlobalScope.
declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
    readonly port: MessagePort;
    constructor(options?: { processorOptions?: Record<string, unknown> });
    process(
        inputs: Float32Array[][],
        outputs: Float32Array[][],
        parameters: Record<string, Float32Array>
    ): boolean;
}
declare function registerProcessor(name: string, ctor: unknown): void;

/**
 * The worklet module, written as a regular function and serialized with
 * `toString()`. Fully self contained (no external references), so
 * minification is safe: everything it names lives inside the call wrapper.
 * Tuning arrives through `processorOptions` so the values live in one place.
 */
function memdelTapModule(): void {
    const RENDER_QUANTUM = 128;

    class MemdelTap extends AudioWorkletProcessor {
        private channels: number;
        private blockFrames: number;
        private idleFrames: number;
        private n = 0;
        private buf: Float32Array;
        private live: boolean | null = null;
        private lastInputFrame = 0;
        private blockStartFrame = 0;

        constructor(options: { processorOptions: Record<string, unknown> }) {
            super();
            this.channels = options.processorOptions.channels as number;
            const requested = options.processorOptions.blockFrames as number;
            // Whole number of render quanta, so emit() always sends full blocks.
            this.blockFrames = Math.max(
                RENDER_QUANTUM,
                Math.round(requested / RENDER_QUANTUM) * RENDER_QUANTUM
            );
            this.idleFrames = (options.processorOptions.idleSeconds as number) * sampleRate;
            this.buf = new Float32Array(this.blockFrames * this.channels);
        }

        process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
            const ch = inputs[0];
            const hasInput = !!(ch && ch.length);
            if (hasInput) {
                this.lastInputFrame = currentFrame;
                if (this.live !== true) {
                    this.live = true;
                    this.port.postMessage({ live: true });
                }
            } else if (
                this.live !== false &&
                currentFrame - this.lastInputFrame > this.idleFrames
            ) {
                this.live = false;
                this.port.postMessage({ live: false });
            }
            // Always accumulate, writing silence for empty quanta: games that
            // connect edges per one shot SFX leave the input empty between
            // sounds, and the stream must stay contiguous in the audio clock.
            const size = hasInput ? ch[0].length : (outputs[0]?.[0]?.length ?? RENDER_QUANTUM);
            if (this.n === 0) this.blockStartFrame = currentFrame;
            for (let c = 0; c < this.channels; c++) {
                const plane = c * this.blockFrames + this.n;
                const src = hasInput ? (ch[c] ?? ch[0]) : null;
                if (src) this.buf.set(src, plane);
                else this.buf.fill(0, plane, plane + size);
            }
            this.n += size;
            if (this.n === this.blockFrames) this.emit();
            // Zero the output: an aliased input buffer would otherwise pass through.
            const out = outputs[0];
            if (out) for (let i = 0; i < out.length; i++) out[i].fill(0);
            return true;
        }

        private emit(): void {
            const data = this.buf;
            this.buf = new Float32Array(this.blockFrames * this.channels);
            this.n = 0;
            this.port.postMessage({ data, frameStart: this.blockStartFrame }, [data.buffer]);
        }
    }
    registerProcessor('memdel-tap', MemdelTap);
}

const WORKLET_SOURCE = `(${memdelTapModule.toString()})()`;

/** Offline contexts render sounds ahead of time. They are never a live output to capture. */
function isOffline(ctx: BaseAudioContext): boolean {
    return typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
}

function ensureTap(ctx: AudioContext): InternalTap | null {
    if (!autoTapSupported()) return null;
    let tap = taps.get(ctx);
    if (tap?.dead) {
        taps.delete(ctx);
        tap = undefined;
    }
    if (!tap) {
        const listeners = new Set<(data: Float32Array, frameStart: number) => void>();
        tap = {
            node: null,
            waiting: new Set(),
            listeners,
            fed: false,
            dead: false,
            live: null,
            onBlock(listener: (data: Float32Array, frameStart: number) => void) {
                listeners.add(listener);
                return () => listeners.delete(listener);
            }
        };
        taps.set(ctx, tap);
        // A fresh tap is never usable yet (not fed, maybe suspended). Waiters
        // wake from the hook's first edge or a resume below.
        ctx.addEventListener('statechange', () => {
            if (ctx.state === 'running') fireTapWaiters();
        });
        bootTap(ctx, tap);
    }
    return tap;
}

function bootTap(ctx: AudioContext, tap: InternalTap): void {
    void (async () => {
        // Strict CSP can block the blob: module. Boot then fails quietly, and
        // automatic capture simply stays video only.
        moduleUrl ??= URL.createObjectURL(
            new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
        );
        await ctx.audioWorklet.addModule(moduleUrl);
        const node = new AudioWorkletNode(ctx, 'memdel-tap', {
            outputChannelCount: [AUDIO_CHANNELS],
            processorOptions: {
                channels: AUDIO_CHANNELS,
                blockFrames: AUDIO_BLOCK_FRAMES,
                idleSeconds: AUDIO_IDLE_SECONDS
            }
        });
        node.port.onmessage = (
            event: MessageEvent<{ data?: Float32Array; frameStart?: number; live?: boolean }>
        ) => {
            const { data, frameStart, live } = event.data;
            if (live !== undefined) {
                tap.live = live;
                fireTapWaiters();
                return;
            }
            if (!tap.listeners.size || !data || frameStart === undefined) return;
            for (const listener of tap.listeners) listener(data, frameStart);
        };
        internalNodes.add(node);
        // Mute the tap output so it can never add signal to the destination.
        const silent = ctx.createGain();
        silent.gain.value = 0;
        internalNodes.add(silent);
        node.connect(silent);
        silent.connect(ctx.destination);
        tap.node = node;
        for (const waiting of tap.waiting) attach(tap, waiting);
        tap.waiting.clear();
    })().catch(() => {
        tap.dead = true;
        tap.waiting.clear();
        // Mint a fresh module URL next time in case this one is unusable.
        moduleUrl = null;
    });
}

function attach(tap: InternalTap, node: AudioNode): void {
    try {
        if (tap.node) node.connect(tap.node);
        else tap.waiting.add(node);
    } catch {}
}

/** Patches connect once at import. Original edges stay untouched. */
function installAudioHook(): void {
    if (hookInstalled || typeof AudioNode === 'undefined') return;
    hookInstalled = true;

    const nativeConnect = AudioNode.prototype.connect as (...args: unknown[]) => AudioNode;
    AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
        if (
            !internalNodes.has(this) &&
            args[0] === this.context.destination &&
            this.context.state !== 'closed' &&
            !isOffline(this.context)
        ) {
            const tap = ensureTap(this.context as AudioContext);
            if (tap) {
                attach(tap, this);
                if (!tap.fed) {
                    tap.fed = true;
                    fireTapWaiters();
                }
            }
        }
        return nativeConnect.apply(this, args);
    } as typeof AudioNode.prototype.connect;
}

installAudioHook();

function wrapTap(ctx: AudioContext, tap: InternalTap): AudioTap {
    return {
        ctx,
        onBlock: tap.onBlock,
        // The tap is shared and stays armed, so disconnect does nothing.
        disconnect: () => {}
    };
}

/** Only fires while a usable tap exists, so consumers never resolve to null. */
function fireTapWaiters(): void {
    if (!tapWaiters.size || !getAudioTap()) return;
    const waiters = [...tapWaiters];
    tapWaiters.clear();
    for (const waiter of waiters) waiter();
}
