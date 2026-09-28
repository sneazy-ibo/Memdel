export interface VideoClockOptions {
    /** Target frame rate in Hz. */
    fps: number;
    /** Emit a frame spanning `duration` seconds starting at `timestamp` seconds. */
    onFrame: (timestamp: number, duration: number) => void | Promise<void>;
    onError?: (error: unknown) => void;
}

/**
 * Drives `CanvasSource.add` at a constant slot rate on a wall clock that can be
 * paused, so video timestamps share one origin with the audio feed.
 *
 * - Slots are `1 / fps` wide. The first emitted frame starts at timestamp 0.
 * - A single missed slot is emitted normally. Two or more missed slots collapse
 *   into one frame with the combined duration (one encode instead of duplicates).
 * - While a frame is in flight the tick is skipped, applying backpressure.
 * - `pause()`/`resume()` freeze the clock without emitting.
 */
export class VideoClock {
    private readonly _slotMs: number;
    private readonly _onFrame: (timestamp: number, duration: number) => void | Promise<void>;
    private readonly _onError: (error: unknown) => void;

    private _originMs = 0;
    private _pausedAccumMs = 0;
    private _pauseStartedAt = -1;
    private _lastSlot = -1;
    private _inFlight = false;
    private _running = false;
    private _rafId: number | null = null;

    constructor(options: VideoClockOptions) {
        this._slotMs = 1000 / options.fps;
        this._onFrame = options.onFrame;
        this._onError = options.onError ?? (() => {});
    }

    /** Wall clock origin in milliseconds, shared with the audio feed. */
    get originMs(): number {
        return this._originMs;
    }

    /** Unpaused elapsed time since `start()`, in milliseconds. */
    get elapsedMs(): number {
        return this._wallActiveMs();
    }

    start(originMs?: number): void {
        if (this._running) return;
        this._running = true;
        this._originMs = originMs ?? performance.now();
        this._pausedAccumMs = 0;
        this._pauseStartedAt = -1;
        this._lastSlot = -1;
        this._schedule();
    }

    stop(): void {
        this._running = false;
        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    }

    pause(): void {
        if (this._pauseStartedAt < 0) this._pauseStartedAt = performance.now();
    }

    resume(): void {
        if (this._pauseStartedAt < 0) return;
        this._pausedAccumMs += performance.now() - this._pauseStartedAt;
        this._pauseStartedAt = -1;
    }

    private _wallActiveMs(): number {
        const now = performance.now();
        const paused =
            this._pausedAccumMs + (this._pauseStartedAt >= 0 ? now - this._pauseStartedAt : 0);
        return now - this._originMs - paused;
    }

    private _schedule(): void {
        this._rafId = requestAnimationFrame(this._tick);
    }

    private _tick = (): void => {
        this._rafId = null;
        if (!this._running) return;
        this._schedule();
        if (this._pauseStartedAt >= 0 || this._inFlight) return;

        const slot = Math.floor(this._wallActiveMs() / this._slotMs);
        if (slot <= this._lastSlot) return;

        const startSlot = this._lastSlot + 1;
        const timestamp = (startSlot * this._slotMs) / 1000;
        const duration = ((slot - startSlot + 1) * this._slotMs) / 1000;
        this._lastSlot = slot;
        this._inFlight = true;

        void Promise.resolve(this._onFrame(timestamp, duration))
            .catch((error) => {
                if (this._running) this._onError(error);
            })
            .finally(() => {
                this._inFlight = false;
            });
    };
}
