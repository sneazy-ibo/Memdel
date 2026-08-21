export class Replayer {
    static get isSupported() {
        return typeof window !== 'undefined' && 'VideoEncoder' in window;
    }

    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.options = options;
    }
}
