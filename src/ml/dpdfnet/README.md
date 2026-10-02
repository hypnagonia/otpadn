# DPDFNet dereverb + denoise

`dereverb.ts` and `fft.ts` are vendored unchanged from **Hush / dpdfnet-webassembly**
(https://github.com/jenyanepoimannykh-it/dpdfnet-webassembly, `src/dsp/`): a port of the
JenyaDereverb2 plug-in's DPDFNet inference loop (960-pt STFT via Bluestein, hop 480, Vorbis
window, recurrent state seeded from model metadata, 40 ms network delay compensated so the
result is sample-aligned with the input — wet/dry blends don't comb-filter).

Model: DPDFNet-8, 48 kHz (CEVA, https://github.com/ceva-ip/DPDFNet), `public/models/`.
It removes noise strongly and room/reverb moderately in one pass; a second pass adds nothing.
Re-copy from the upstream repo to update; Otpadn only talks to `dpdfnet.worker.ts`.
