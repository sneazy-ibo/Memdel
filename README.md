# memdel

> Record and clip `<canvas>` + Web Audio natively in your browser

[![npm version](https://img.shields.io/npm/v/memdel.svg)](https://www.npmjs.com/package/memdel)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/memdel?style=round-square)](https://bundlephobia.com/package/memdel@latest)
[![license](https://img.shields.io/npm/l/memdel.svg)](LICENSE)

Built on [mediabunny](https://mediabunny.dev) for WebCodecs-based encoding/muxing.

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

Pass the `AudioNode` whose output you want captured (e.g. a master gain/bus node). Capture happens on that node's own `AudioContext`:

```js
const audioCtx = new AudioContext();
const masterGain = audioCtx.createGain();
// ... connect your game/app's audio graph into masterGain ...

const recorder = new Recorder(canvas, { audioNode: masterGain });
```

With [Howler](https://howlerjs.com), for example, the whole engine's output is one line away:

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

`Replayer` keeps the last N seconds of canvas + audio encoded in a rolling buffer. Whenever something clip-worthy happens, `saveLastSeconds()` muxes that window into a file:

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

| Option         | Type                                   | Default       | Notes                                                                                                                                              |
| -------------- | -------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fps`          | `number`                               | `60`          |                                                                                                                                                    |
| `container`    | `"mp4" \| "mov" \| "webm" \| "mkv"`    | `"mp4"`       | Output container format                                                                                                                            |
| `videoQuality` | `number \| string \| Quality`          | `"high"`      | A bitrate in bits/sec (positive integer), a level (`"very-low"`\|`"low"`\|`"medium"`\|`"high"`\|`"very-high"`), or a mediabunny `Quality` instance |
| `audioQuality` | `number \| string \| Quality`          | `"very-high"` | Same shape as `videoQuality`                                                                                                                       |
| `saveMode`     | `"auto" \| "filesystem" \| "download"` | `"auto"`      | See save modes below                                                                                                                               |
| `audioNode`    | `AudioNode`                            | `null`        | The node to tap (e.g. a master gain/bus node), its context is used for capture                                                                     |
| `name`         | `string`                               | `""`          | Filename template — supports `YYYY`/`MM`/`DD`/`HH`/`mm`/`ss`, falls back to a timestamped name                                                     |
| `onLog`        | `(message: string) => void`            | `null`        | Internal diagnostics                                                                                                                               |
| `debug`        | `boolean`                              | `false`       | Logs to `console.debug` if `onLog` isn't set                                                                                                       |

**Static**

- `Recorder.isSupported` — whether the current browser has what `Recorder` needs (WebCodecs + `captureStream`).
- `Recorder.filesystemSupported` — whether the File System Access API is available.

**Instance**

- `recorder.recording` — `boolean`, whether a recording is in progress.
- `recorder.paused` — `boolean`, whether the current recording is paused.
- `recorder.bytesWritten` — live byte count written to the output so far (includes container overhead), works in both memory and filesystem mode.
- `recorder.directoryName` — name of the selected recording directory, or `null`.
- `recorder.configure(options)` — update config between recordings (throws if called while recording). Accepts any of `fps`, `container`, `videoQuality`, `audioQuality`, `saveMode`, `audioNode`.
- `await recorder.setRecordingDirectory()` — prompts the user to pick a folder, resolves to the directory handle.
- `recorder.pause()` / `recorder.resume()`
- `await recorder.start()`
- `await recorder.stop()` — resolves to `{ duration, size }`.

**Callbacks**

- `onStart()`
- `onStop({ duration, size })`
- `onPause()` / `onResume()`
- `onVideoPacket(packet, meta)` — called for each encoded video packet with its chunk metadata.
- `onAudioPacket(packet, meta)` — same for audio.

### `new Replayer(canvas, options?)`

Records a canvas into a rolling buffer of encoded packets. Call `saveLastSeconds()` at any point to mux the last N seconds into a file — muxing only, no re-encode.

| Option             | Type                                | Default       | Notes                                                                                                              |
| ------------------ | ----------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `fps`              | `number`                            | `60`          |                                                                                                                    |
| `container`        | `"mp4" \| "mov" \| "webm" \| "mkv"` | `"mp4"`       | Output container format                                                                                            |
| `videoQuality`     | `number \| string \| Quality`       | `"high"`      | Same shape as Recorder's; ignored while `targetMB` is set                                                          |
| `audioQuality`     | `number \| string \| Quality`       | `"very-high"` | Same shape as Recorder's; audio is pinned to max quality while `targetMB` is set                                   |
| `audioNode`        | `AudioNode`                         | `null`        | Same tap as Recorder; omit for video-only clips                                                                    |
| `bufferSeconds`    | `number`                            | `15`          | How much footage the rolling buffer holds                                                                          |
| `keyframeInterval` | `number`                            | `2`           | Seconds between keyframes; also the granularity `targetMB` trimming works at                                       |
| `targetMB`         | `number`                            | `null`        | Target export size in MB; `videoQuality` is derived to fit it and clips are shortened only if the cap can't be met |
| `name`             | `string`                            | `""`          | Filename template — same tokens as Recorder                                                                        |
| `onLog`            | `(message: string) => void`         | `null`        | Internal diagnostics                                                                                               |
| `debug`            | `boolean`                           | `false`       | Extra diagnostics (size trims, encoder lag); logs to `console.debug` if `onLog` isn't set                          |

**Static**

- `Replayer.isSupported` — same requirements as `Recorder.isSupported`.

**Instance**

- `replayer.recording` / `replayer.paused` — booleans, same meaning as on Recorder.
- `replayer.bufferBytes` — total byte size of the raw encoded packets currently buffered.
- `replayer.estimateExportBytes(seconds?)` — the encoded size of the clip `saveLastSeconds(seconds)` would currently produce (a hair under the muxed file size), or `null` when nothing is exportable yet.
- `replayer.configure(options)` — update settings, including mid-recording. Quality, `container`, `targetMB`, and `audioNode` changes rebuild the pipeline; buffered footage is only cleared when video encoding semantics change.
- `replayer.pause()` / `replayer.resume()` — like Recorder; audio and video stay aligned across pauses.
- `await replayer.start()` — begins filling the buffer (auto-pauses while the tab is hidden).
- `await replayer.stop()` — stops and clears the buffer.
- `await replayer.saveLastSeconds(seconds?, { download? })` — muxes the last `seconds` of footage into a file and downloads it; pass `{ download: false }` to just get the `Blob`. The clip is cut to run _exactly_ the requested duration, anchored to a keyframe (up to one GOP of the freshest footage may be left out). Resolves to the `Blob`, or `null` when nothing is exportable. With `targetMB` set, an over-budget clip is shortened from the front.

**Callbacks**

- `onStart()` / `onStop()` / `onPause()` / `onResume()`
- `onExport({ duration, size })`
- `onVideoPacket(packet, meta)` / `onAudioPacket(packet, meta)` — same as Recorder.

### Save modes

| Mode           | Behavior                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| `"auto"`       | Uses the picked directory if `setRecordingDirectory()` was called, otherwise falls back to a browser download |
| `"filesystem"` | Always writes to the picked directory, throws if none is set or the API isn't supported                       |
| `"download"`   | Always buffers in memory and triggers a download when `stop()` resolves                                       |

## Browser support

Requires WebCodecs + `canvas.captureStream`, check `Recorder.isSupported` / `Replayer.isSupported` at runtime. Streaming to a picked directory additionally needs the File System Access API (Chromium only), check `Recorder.filesystemSupported`.

## License

GPL-3.0-or-later © [sneazy-ibo](https://github.com/sneazy-ibo)
