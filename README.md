# memdel

[![npm version](https://img.shields.io/npm/v/memdel.svg)](https://www.npmjs.com/package/memdel)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/memdel?style=round-square)](https://bundlephobia.com/package/memdel@latest)

Record and replay `<canvas>` + Web Audio natively in your browser. Built on [mediabunny](https://mediabunny.dev) for encoding and muxing with WebCodecs.

## Contents

- [Usage](#usage)
- [Quick start](#quick-start)
- [API](#api)
- [Save modes](#save-modes)
- [Browser support](#browser-support)
- [License](#license)

## Usage

As an npm dependency (`mediabunny` is a peer dependency):

```bash
npm install memdel mediabunny
```

```js
import { Recorder } from 'memdel';

const recorder = new Recorder(myCanvas);
await recorder.start();
// ... later
const { duration, size } = await recorder.stop();
```

Or load it directly from a CDN with no bundler:

```html
<script src="https://cdn.jsdelivr.net/npm/memdel"></script>
<script type="module">
    const recorder = new Memdel.Recorder(document.querySelector('canvas'));
    await recorder.start();
</script>
```

You can even load it through a userscript on any domain:

```js
// @require https://cdn.jsdelivr.net/npm/memdel
```

## Quick start

### Video only

```js
import { Recorder } from 'memdel';

const recorder = new Recorder(canvas, { fps: 60 });

recorder.onStop = ({ duration, size }) => {
    console.log(`Recorded ${(size / 1e6).toFixed(1)} MB over ${(duration / 1000).toFixed(1)}s`);
};

await recorder.start();
// ...
await recorder.stop(); // triggers a download by default
```

### With audio

Pass `audioNode: true` to capture the page's game audio automatically. Memdel mirrors every connection made to the page's audio destination into its own silent tap, so audio is captured from the moment the page first plays a sound, without touching the app's graph:

```js
const recorder = new Recorder(canvas, { audioNode: true });
```

> Auto-capture requires a **secure context** (https). On `http://` or `file://` pages it degrades to video only with a log line. The mirror installs once, when memdel is loaded, so load memdel before the page builds its audio graph. The first `AudioContext` actually playing to the speakers is tapped for the session. Pass a specific `AudioNode` to pin a context. If autoplay leaves the tapped context suspended, `start()` and `saveLastSeconds()` resume it on a best effort basis while you're still in the triggering gesture. Call `resumeTappedAudio()` yourself if you need it outside one. Pages with a strict `script-src` CSP that blocks `blob:` module scripts also fall back to video only.

Alternatively, pass the `AudioNode` whose output you want captured (e.g. a master gain/bus node). Capture happens on that node's own `AudioContext`:

```js
const audioCtx = new AudioContext();
const masterGain = audioCtx.createGain();
// ... connect your game/app's audio graph into masterGain ...

const recorder = new Recorder(canvas, { audioNode: masterGain });
```

With [Howler](https://howlerjs.com), the engine's output is a single node:

```js
const recorder = new Recorder(canvas, { audioNode: Howler.masterGain });
```

If you don't pass `audioNode`, `Recorder` silently records video only.

### Pausing

Pausing halts frame capture and mutes the audio tap. On resume, timestamps are offset so there's no hole in the output:

```js
recorder.pause();
// ... later
recorder.resume();
```

### Continuous clipping

`Replayer` keeps the last N seconds of canvas + audio encoded in a rolling buffer. Call `saveLastSeconds()` to mux the buffered footage into a file:

```js
import { Replayer } from 'memdel';

const replayer = new Replayer(canvas, { audioNode: masterGain, bufferSeconds: 15 });
await replayer.start();
// ... right after the moment you want to keep
const blob = await replayer.saveLastSeconds(); // downloads (also returns the Blob)
```

With `targetMB` set, exports stay within a file size budget instead of following a fixed quality:

```js
const replayer = new Replayer(canvas, { audioNode: masterGain, targetMB: 16 });
```

### Streaming to disk directly

On browsers that support the File System Access API, you can record straight to a folder instead of recording in memory and triggering a browser download each time:

```js
if (Recorder.filesystemSupported) {
    await recorder.setRecordingDirectory(); // prompts the user once
}

const recorder = new Recorder(canvas, { saveMode: 'auto' }); // uses the directory if set, else falls back to download
```

## API

### `new Recorder(canvas, options?)`

| Option         | Type                                 | Default       | Notes                                                                                                                                              |
| -------------- | ------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fps`          | `number`                             | `60`          |                                                                                                                                                    |
| `container`    | `"mp4" \| "mov" \| "webm" \| "mkv"`  | `"mp4"`       | Output container format                                                                                                                            |
| `videoQuality` | `number \| string \| Quality`        | `"high"`      | A bitrate in bits/sec (positive integer), a level (`"very-low"`\|`"low"`\|`"medium"`\|`"high"`\|`"very-high"`), or a mediabunny `Quality` instance |
| `audioQuality` | `number \| string \| Quality`        | `"very-high"` | Same shape as `videoQuality`                                                                                                                       |
| `bitrateMode`  | `"constant" \| "variable"`           | `"variable"`  | Rate control mode applied to qualitative `videoQuality` levels. `constant` forces the encoder to actually spend the level's target bitrate         |
| `saveMode`     | `"auto" \| "filesystem" \| "memory"` | `"auto"`      | See save modes below                                                                                                                               |
| `audioNode`    | `boolean \| AudioNode`               | `null`        | `true` taps the page's audio automatically. Alternatively, pass the `AudioNode` to capture. Its context is used for capture                        |
| `name`         | `string`                             | `""`          | Filename template. Supports `YYYY`/`MM`/`DD`/`HH`/`mm`/`ss`, falls back to a timestamped name                                                      |
| `onLog`        | `(message: string) => void`          | `null`        | Internal diagnostics                                                                                                                               |
| `debug`        | `boolean`                            | `false`       | Logs to `console.debug` if `onLog` isn't set                                                                                                       |

**Static**

- `Recorder.isSupported`: whether the current browser has what `Recorder` needs (WebCodecs `VideoEncoder` + `VideoFrame`).
- `Recorder.filesystemSupported`: whether the File System Access API is available.

**Instance**

- `recorder.recording`: `boolean`, whether a recording is in progress.
- `recorder.paused`: `boolean`, whether the current recording is paused.
- `recorder.elapsedMs`: elapsed recording time excluding pauses, in milliseconds (`0` when idle).
- `recorder.bytesWritten`: live byte count written to the output so far (includes container overhead), works in both memory and filesystem mode.
- `recorder.directoryName`: name of the selected recording directory, or `null`.
- `recorder.configure(options)`: update config between recordings (throws if called while recording). Accepts any of `fps`, `container`, `videoQuality`, `audioQuality`, `bitrateMode`, `saveMode`, `audioNode`.
- `await recorder.setRecordingDirectory()`: prompts the user to pick a folder, resolves to the directory handle.
- `recorder.pause()` / `recorder.resume()`
- `await recorder.start()`
- `await recorder.stop()`: resolves to `{ duration, size }`.

**Callbacks**

- `onStart()`
- `onStop({ duration, size })`
- `onPause()` / `onResume()`

### `new Replayer(canvas, options?)`

Records a canvas into a rolling buffer of encoded packets. Call `saveLastSeconds()` at any point to mux the last N seconds into a file (muxing only, no transcoding).

| Option             | Type                                | Default       | Notes                                                                                                                    |
| ------------------ | ----------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `fps`              | `number`                            | `60`          |                                                                                                                          |
| `container`        | `"mp4" \| "mov" \| "webm" \| "mkv"` | `"mp4"`       | Output container format                                                                                                  |
| `videoQuality`     | `number \| string \| Quality`       | `"high"`      | Same shape as Recorder's. Ignored while `targetMB` is set                                                                |
| `audioQuality`     | `number \| string \| Quality`       | `"very-high"` | Same shape as Recorder's. Audio is pinned to max quality while `targetMB` is set                                         |
| `audioNode`        | `boolean \| AudioNode`              | `null`        | `true` taps the page's audio automatically. Alternatively, pass the same node tap as Recorder. Omit to record video only |
| `bufferSeconds`    | `number`                            | `15`          | How much footage the rolling buffer holds                                                                                |
| `keyframeInterval` | `number`                            | `2`           | Seconds between keyframes. Also the granularity `targetMB` trimming works at                                             |
| `targetMB`         | `number`                            | `undefined`   | Target export size in MB. `videoQuality` is derived to fit it. Clips are shortened only if the cap can't be met          |
| `bitrateMode`      | `"constant" \| "variable"`          | `"constant"`  | Rate control mode for quality levels and the `targetMB`-derived bitrate. `variable` spends fewer bits on flat scenes     |
| `name`             | `string`                            | `""`          | Filename template. Same tokens as Recorder                                                                               |
| `onLog`            | `(message: string) => void`         | `null`        | Internal diagnostics                                                                                                     |
| `debug`            | `boolean`                           | `false`       | Extra diagnostics (size trims, encoder lag). Logs to `console.debug` if `onLog` isn't set                                |

**Static**

- `Replayer.isSupported`: same requirements as `Recorder.isSupported`.

**Instance**

- `replayer.recording` / `replayer.paused`: booleans, same meaning as on Recorder.
- `replayer.bufferBytes`: total byte size of the raw encoded packets currently buffered.
- `replayer.bufferedSeconds`: duration of the footage currently in the rolling buffer, in seconds.
- `replayer.estimateExportBytes(seconds?)`: the encoded size of the clip `saveLastSeconds(seconds)` would currently produce (a hair under the muxed file size), or `null` when nothing is exportable yet.
- `replayer.configure(options)`: update settings, including during recording. Quality, `container`, `targetMB`, `bitrateMode`, and `audioNode` changes rebuild the pipeline. Buffered footage is only cleared when video encoding semantics change.
- `replayer.pause()` / `replayer.resume()`: like Recorder. Audio and video stay aligned across pauses.
- `await replayer.start()`: begins filling the buffer (pauses automatically while the tab is hidden).
- `await replayer.stop()`: stops and clears the buffer.
- `await replayer.saveLastSeconds(seconds?, { download? })`: muxes the last `seconds` of footage into a file and downloads it. Pass `{ download: false }` to just get the `Blob`. The clip starts on the keyframe at or before the window and always runs to the newest packet, so it can be up to one GOP longer than requested. Resolves to the `Blob`, or `null` when nothing is exportable. With `targetMB` set, a clip that is over budget is shortened from the front.

**Callbacks**

- `onStart()` / `onStop()` / `onPause()` / `onResume()`
- `onExport({ duration, size })`

### Save modes

| Mode           | Behavior                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------- |
| `"auto"`       | Uses the picked directory if `setRecordingDirectory()` was called, otherwise falls back to memory |
| `"filesystem"` | Always writes to the picked directory, throws if none is set or the API isn't supported           |
| `"memory"`     | Always buffers in memory and triggers a download when `stop()` resolves                           |

## Browser support

Requires WebCodecs (`VideoEncoder` + `VideoFrame`), check `Recorder.isSupported` / `Replayer.isSupported` at runtime. Streaming to a picked directory additionally needs the File System Access API (Chromium only), check `Recorder.filesystemSupported`.

## License

GPL-3.0-or-later © [sneazy-ibo](https://github.com/sneazy-ibo)
