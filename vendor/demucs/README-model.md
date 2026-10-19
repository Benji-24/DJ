---
license: mit
pipeline_tag: audio-to-audio
tags:
  - audio
  - music-source-separation
  - demucs
  - htdemucs
  - onnx
  - onnxruntime-web
  - webgpu
  - fp16
---

# htdemucs for the browser: mixed precision, 21-piece chained split

[htdemucs](https://github.com/facebookresearch/demucs) (Hybrid Transformer Demucs) 4-stem
music source separation (drums / bass / other / vocals), exported to ONNX for
**onnxruntime-web on WebGPU**, in a form designed to run while the same GPU is rendering a
UI the user is watching.

## Why this exists

Running htdemucs as one ONNX session makes each inference a ~200-330ms monolithic GPU burst.
The browser compositor cannot interleave frames with a submitted burst, so any UI sharing the
GPU freezes for the duration, and pacing between runs cannot shorten a single burst. This
export solves both cost and burst length:

- **Mixed precision**: fp16 everywhere except `Conv`/`ConvTranspose` (full fp16 degrades the
  drums and bass stems badly; with convolutions kept fp32 every stem stays at correlation
  >= 0.9998 against the fp32 reference). Constants are folded before conversion. ~2.4x faster
  than fp32 and 126MB total instead of 173MB.
- **21 chained pieces** (`htdemucs_p00.onnx` ... `htdemucs_p20.onnx`), cut at encoder /
  transformer-layer / decoder sub-block boundaries so each piece is a ~10-30ms GPU
  submission. Draining the queue between pieces lets a 30-60Hz UI keep every frame while
  separation runs. The fp32 piece chain reproduces the monolithic model **bit-exactly**;
  the shipped fp16 chain measures per-stem correlation >= 0.9998 on real music.

Measured on a Radeon RX 7600 with a WebGPU app actively rendering: 30Hz display holds a
steady 30fps through the entire separation (a monolithic session managed 12-18fps with
330ms freezes). Throughput ~22x realtime run back-to-back, ~8x with compositor-friendly
pacing.

## Files

- `htdemucs_split_manifest.json`: ordered piece list. Each entry: `{file, inputs, outputs}`
  (ONNX tensor names). Top level also has `outputs: {"freq": "x", "time": "xt"}`.
- `htdemucs_p00.onnx` ... `htdemucs_p20.onnx`: the pieces. Run strictly in manifest order.

## How to run

- Graph inputs (piece 0): `mix` `[1, 2, 343980]` fp32 waveform segment (44.1kHz stereo),
  `mag` `[1, 4, 2048, 336]` fp32 spectrogram (STFT real/imag interleaved per channel,
  matching the standard demucs-web preprocessing). Final outputs: `x`
  `[1, 4, 4, 2048, 336]` (frequency branch) and `xt` `[1, 4, 2, 343980]` (time branch),
  combined by the usual demucs post-processing (mask/iSTFT + overlap-add).
- Feed each piece from a name->tensor map: start with `mix`/`mag`, run pieces in order,
  merge each piece's outputs back into the map. All boundary tensors are fp32
  (`keep_io_types`). With `preferredOutputLocation: 'gpu-buffer'` the boundaries never leave
  the GPU; dispose them after each segment.
- **Piece 0 requires the fp16-fragile input-normalization prologue pinned to CPU** or the
  graph produces NaN on the WebGPU EP:

```js
const CPU_NODES = ['/ReduceMean','/Sub','/Pow','/ReduceMean_1','/Clip','/Sqrt','/Add','/Div',
                   '/ReduceMean_2','/Sub_1','/Pow_1','/ReduceMean_3','/Clip_1','/Sqrt_1','/Add_1','/Div_1'];
const session0 = await ort.InferenceSession.create(piece0, {
  executionProviders: [{ name: 'webgpu', forceCpuNodeNames: CPU_NODES }],
  graphOptimizationLevel: 'all',
  preferredOutputLocation: 'gpu-buffer',
});
// pieces 1..20: executionProviders: ['webgpu'], NO forceCpuNodeNames
```

  If you feed `mix`/`mag` as GPU buffers, create those buffers with `COPY_SRC` usage
  (the CPU-pinned nodes read them back host-side).
- For smooth UI while separating: `await device.queue.onSubmittedWorkDone()` plus a few ms of
  sleep after each piece. For maximum throughput: run pieces back to back (~7% overhead vs
  a monolithic session). Never have two `run()` calls in flight at once.

## Provenance

Exported from the official [facebookresearch/demucs](https://github.com/facebookresearch/demucs)
`htdemucs` weights (single model, not the ft ensemble) via torch.onnx with an fp16-safe
normalization wrapper; the fp32 export is bit-identical in output to
[timcsy/demucs-web-onnx](https://huggingface.co/timcsy/demucs-web-onnx) `htdemucs_embedded.onnx`.
Then: ONNX Runtime offline BASIC optimization while still fp32 (constant folding),
`convert_float_to_float16(op_block_list=['Conv','ConvTranspose'])` per piece, and a
dependency-bounded graph cut into 21 pieces validated bit-exact against the monolith in fp32.

License: MIT, matching demucs. Credit for htdemucs goes to Alexandre Défossez et al. (Meta AI);
see the demucs repository for the papers.
