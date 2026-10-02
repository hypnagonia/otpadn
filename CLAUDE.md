# Otpadn — code map

Browser DAW: drop a song → stems → MIDI → auto-arrange → auto-mix. Vite + React 19 + TS, no backend.
Staging: https://daw.jenyadoesapps.com (Vercel project `stemdaw`; deploy with `vercel deploy --prod --yes`).

## Where things live

| Folder | Owns | Key entry points |
|---|---|---|
| `src/model/` | Project data model + the single store | `types.ts` (Project/Track/Clip/Note), `store.ts` (`store.update`, `store.setUi`, `useStore`, `buffers`) |
| `src/engine/` | Realtime + offline audio graph | `transport.ts` (`engine` singleton: play/stop/seek/loop, count-in + metronome, lookahead scheduler, mixer sync), `recorder.ts` (input recording via AudioWorklet, latency-compensated), `liveInput.ts` (musical typing, Web MIDI), `graph.ts` (channel strip, master bus, reverb), `schedule.ts` (clip→node scheduling), `render.ts` (offline bounce) |
| `src/instruments/` | Sound sources (all lazy) | `catalog.ts` (library list incl. ★ Essentials + role defaults), `factory.ts` (`createInstrument(ctx,id,dest)`), `sampled.ts` (`sampled:` multisampled bass / acoustic / DI guitar from `public/instruments/`, built by `tools/build_sampled_instruments.py`; 16-bit PCM store), `ampsim.ts` (guitar amp + CC0 4×12 cab IRs; also the `amp` insert), `synth.ts` (unison/24 dB/drive/LFO synth presets), `kit.ts` (CC0 Virtuosity acoustic kit, thin subset), `multikit.ts` (multitrack CrocellKit, CC BY 4.0: 7 mic-group outputs → aux tracks; shared 16-bit store + LRU; assets in `public/kits/crocell/`, rebuilt by `tools/build_crocell_kit.py`), `pluck.ts` (Karplus-Strong acoustic + amp/cab distortion guitar), `smplr.ts` (sample libraries + fuzzy GM drum resolver) |
| `src/plugins/` | Insert effects (our own MIT DSP) | `defs.ts` (params), `worklets.ts` (compressor, 3-band LR4 multiband, Dattorro plate, look-ahead brickwall limiter — AudioWorklet), `nodes.ts` (delay + `InsertChain`), `ops.ts` (add/remove/toggle/setParam) |
| `src/dsp/` | Heavy DSP in Web Workers | `pool.ts` (`dspPool.separate/peaks/lufs/wav`), `dsp.worker.ts` (STFT stem masks, features, LUFS, WAV), `fft.ts` |
| `src/ml/` | ML in workers | `muscriptor.ts` (audio→MIDI: MuScriptor via the WebGPU engine vendored from byEar in `muscriptor/` — re-copy from hypnagonia/chrome-ext-audio2midi `engine/`, don't edit in place; weights CC BY-NC 4.0), `dpdfnet.ts` (dereverb + denoise, DPDFNet-8 via engine vendored from dpdfnet-webassembly in `dpdfnet/`, one worker per channel), `demucs.ts` + `demucs.worker.ts` (HTDemucs 6-stem via onnxruntime-web WebGPU→WASM), `onnxPatch.ts` (float64→float32 graph patch; web runtime lacks double kernels) |
| `src/analysis/` | Music analysis on worker features (cheap, main thread) | `tempo.ts`, `key.ts`, `chords.ts`, `sections.ts`, `grid.ts` (beat grid helpers), `notes.ts` (transcription cleanup) |
| `src/assist/` | The semi-automatic workflow (each step is a separate user command) | `import.ts` → `separate.ts` (split stems + song analysis) → `clean.ts` (dereverb + denoise, in place, undoable) → `convert.ts` (any audio track → MuScriptor → one MIDI track per instrument; stems restrict to their family) → `arrange/arrange.ts` (+`generators.ts`, `clips.ts`) → `mix.ts`; `tracks.ts` = track factories |
| `src/drumproducer/` | Drum Producer: dirty drum MIDI → clean/reworked electronic drums | `pipeline.ts` (map→`analyze`→`clean`→`rework` (house/techno, `styles.ts`)→`groove`→`sound`; pure, seeded via `rng.ts`, runs in `dp.worker.ts` via `client.ts`), `session.ts` (capture/apply/revert, sessions live in `project.drumSessions`), `audition.ts` (A/B via `engine.setAudition`); kit = `instruments/drumsynth.ts` (`dpkit:`); UI `ui/drumproducer/` |
| `src/partproducer/` | Part Producer: transcribed keys / vocal-lead line / guitar MIDI → clean, reworked, playable parts | `pipeline.ts` (`harmony` key+chords (project chord track or notes) → `clean` → `rework` (keys comp/stabs/pad/arp with voice leading; line faithful/tight/hook with unified repeats; guitar faithful/strum/fingerpick/power via the fretboard model in `voicing.ts`) → `groove` → `sound`; pure, seeded, runs in `pp.worker.ts`), `session.ts` (capture/apply/revert, `project.partSessions`), `audition.ts`; UI `ui/partproducer/` |
| `src/edit/` | Editing commands | `ops.ts` (regions, tracks, tool/snap, `retempo`), `routing.ts` (buses, sends, sidechain) |
| `src/system/` | Memory manager | `memory.ts`: budget, ledger (`track/untrack`), reclaimers, `ensure(bytes,label)` guards, `ensureDisk`, background monitor, `est.*` size estimates |
| `src/io/` | Export + session persistence | `export.ts` (WAV via worker, MIDI), `persist.ts` (IndexedDB autosave/restore; stems rebuilt from provenance) |
| `src/ui/` | React UI, Logic-style window | `shell/` (App layout, ControlBar, StatusBar, shortcuts), `tracks/` (TracksArea, TrackHeader, canvas renderer), `inspector/`, `library/`, `editors/` (EditorPane, PianoRoll, Console), `mixer/` (Mixer, ChannelStrip, Meter), `eq/` (visual ChannelEq + EqThumb), `plugins/` (PluginEditor visuals, InsertSlots), `editors/Tablature`, `shell/ContextMenu`, `common/` (Select, Dialog, Knob — never native widgets) (theme, format, NumberField, runTask) |

## Rules of the road

- **Routing**: `bus` tracks are FX returns (no clips, no sends of their own); channels send via `ch.sends` (dB, pre/post). Compressor inserts may have `sidechain: trackId` (post-fader source → worklet input 1). Inserts + sends are wired in a second pass once all strips exist (engine + offline render).
- Kit default mix lives in `model/auxTracks.ts` (`KIT_MIX`, measured fader levels); applied only when a kit's outputs are first created.
- **Pro-mix chains**: `model/chains.ts` (`CHAINS` per instrument, e.g. sampled bass) + the kit's mic/bus chain in `auxTracks.ts`; applied when the instrument lands on a track (`track.chain` marks it), "reset to pro mix" in the track menu re-applies. Faders are calibrated by offline LUFS renders — re-measure if you change a chain.
- **Summing**: every channel strip is stereo from its input (mono → dual-mono) with our own constant-power pan (unity centre); never reintroduce `StereoPannerNode` on strips (it's equal-power for mono but a summing balance for stereo, so levels jumped with the source / with any insert).
- **Worklet plugins get their initial params via `processorOptions`** (`createPlugin(ctx, type, params)`): offline renders can finish before a port message arrives.

- **Aux tracks** (`kind: "aux"`, `auxOf`, `auxOut`) are owned outputs of a multi-out instrument; `model/auxTracks.ts` creates/removes them after every project change — never add/delete them by hand. Their strips feed the owner's strip (drum bus).
- Drum Producer style `rock` = acoustic mode (`drumproducer/acoustic.ts`): one track on the CrocellKit, velocities fitted to the kit's layers.

- **Memory**: before any heavy allocation call `await memory.ensure(estimate, label)`; `memory.track()` long-lived buffers/models and `untrack()` on release; anything freeable registers a `memory.reclaimer()` (undo history 10, idle DSP workers 20, idle MuScriptor 30). Never allocate full-song copies you don't need (merge in place).

- **Audio→MIDI is MuScriptor only** (user decision). No Basic Pitch / other transcribers.
- `src/drumproducer/` is someone else's work in progress — don't edit it.

- **No native browser widgets**: use `ui/common/Select`, `Dialog` (`confirmDialog`), `data-tip` tooltips — never `<select>`, `confirm()`, `title=`.
- **AI stems** are stored as 16-bit PCM in IndexedDB (`persist.savePcm`); DSP stems are re-split on restore.

- **Persistence**: every new decoded buffer must get a `bufferSources` entry (file or stem provenance) or it can't be restored after reload.
- **Colors**: console-grey palette (big-studio DAW look, not a copy: mid-grey panels over darker playlists, amber mute, yellow solo, green play, red record, yellow cycle, green→red meters, saturated regions with the name bar at the bottom, inset black number readouts); tokens in `styles.css` + `ui/common/theme.ts`. Flat — no gradients.

- **State**: mutate the project only via `store.update(p => …)`; UI-only state via `store.setUi`. `store.projectVersion` bumps only on project changes (the engine syncs on that).
- **Heavy work never on the main thread**: DSP → `dspPool`, ML → `ml/transcribe`, rendering → `OfflineAudioContext`.
- **Times**: clips/notes are in **beats**; audio clip `offset`/`duration` in **seconds**. `spb = 60 / bpm`. Change tempo only via `retempo(p, bpm)` (edit/ops): audio, `anchored` MIDI (transcribed from audio) and sections keep their time; hand-made MIDI keeps its beats.
- **smplr instruments** must be created through `createInstrument` (it injects a no-lookahead Scheduler; without it offline renders drop notes).
- **Canvas colors/fonts** come from `ui/common/theme.ts` (`T.font` sans for labels, `T.mono` for numbers); CSS tokens in `styles.css` mirror it (`--ui` / `--mono`). Dark only; compact sans UI text, Courier for every number (counters, dB, pan, values), 2 px button corners.
- **React effects**: always use braces in `useEffect` bodies (Chrome's `scrollIntoView` returns a Promise; an expression body makes React call it as cleanup → crash).

## Checks

`npm run build` (tsc + vite). End-to-end browser test script lives outside the repo (puppeteer-core driving "Google Chrome 2.app").
