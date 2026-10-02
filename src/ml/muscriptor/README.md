# MuScriptor WebGPU engine

Vendored unchanged from **byEar** (https://github.com/hypnagonia/chrome-ext-audio2midi, `engine/`, v0.7.1),
by the same author: a hand-written WebGPU transformer for the MuScriptor transcription model
(fp16 KV cache, split-K attention), mel front-end, token vocabulary and note decoder.

Model: MuScriptor by Kyutai & Mirelo (https://github.com/muscriptor/muscriptor, paper arXiv:2607.08168).
**Weights are CC BY-NC 4.0 — personal and research use only, not commercial.**
Weights load from the token-free fp16 mirror `huggingface.co/jenyasn/muscriptor-{size}-fp16`
(falls back to the gated official repo with a token) and are cached in the browser.

Update by re-copying `engine/*.js` from byEar; Otpadn talks to `worker.js` only via its message protocol
(see `src/ml/muscriptor.ts`).
