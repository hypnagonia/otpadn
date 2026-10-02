"""
Build Otpadn's multitrack "CrocellKit" (CC BY 4.0, DrumGizmo / Lars Muldjord) from the official
15-channel kit. Run fetch first (range requests: only the chosen hits are downloaded), then build:

    python tools/build_crocell_kit.py fetch  <workdir>   # needs: remotezip
    python tools/build_crocell_kit.py build  <workdir>   # needs: numpy soundfile; macOS afconvert

Output: <workdir>/out/{kit.json,*.m4a} → copy to public/kits/crocell/.
15 mics are summed into 7 mixer tracks (kick, snare, toms, hihat, ride, overheads, room); every hit
keeps its bleed into the other tracks, like a real multi-mic kit. One global gain keeps the
recorded balance; tails are trimmed per hit (same length on every track).
"""
import json, os, re, subprocess, sys

ZIP = "https://drumgizmo.org/kits/CrocellKit/CrocellKit1_1.zip"
PIECES = ["KDrumR", "Snare", "Tom1", "Tom2", "FTom1", "HihatClosed", "HihatOpen", "HihatPedal", "CrashL", "RideR", "RideRBell"]
LAYERS = 8
GM = {"KDrumR": [35, 36], "Snare": [38, 40], "Tom1": [48, 50], "Tom2": [45, 47], "FTom1": [41, 43],
      "HihatClosed": [42], "HihatOpen": [46], "HihatPedal": [44], "CrashL": [49, 57, 52, 55], "RideR": [51, 59], "RideRBell": [53]}
CAP = {"CrashL": 6.0, "RideR": 5.0, "RideRBell": 5.0, "HihatOpen": 3.0}  # seconds
# Pieces whose layer picks reach the very hardest hit (the default stops at 97 %).
TOP = {"CrashL"}
# Transient designer per piece, identical on every mic of a hit (coherent image):
# gain(t) = 1 + k·exp(−(t − onset)/tau). CrocellKit's crash is a slow-blooming wash (peak 120 ms
# after the stick, the room mics swell it further), so it gets the stick attack back: +7 dB at the
# onset, back to unity after ~100 ms.
TRANSIENT = {"CrashL": (1.25, 0.03)}
# Mic groups stored lossless (noise-like content); kick + toms stay AAC (tonal, codec-safe).
LOSSLESS = {"snare", "hihat", "ride", "overheads", "room"}
# Tracks that carry only the listed pieces (no other bleed → no gate needed). Toms: their own
# drums only. Snare: its own hits plus the kick and hats at their natural (low, ~30 dB under the
# snare) bleed level — toms (−20 dB), crash and ride bleed are removed.
ONLY = {
    "kick": {"KDrumR"},  # kick mic: the kick only
    "toms": {"Tom1", "Tom2", "FTom1"},
    "snare": {"Snare", "KDrumR", "HihatClosed", "HihatOpen", "HihatPedal"},
}
GROUPS = {
    "kick": {"stereo": False, "mics": {"KDrumInside": 0.7, "KDrumOutside": 0.7}},
    "snare": {"stereo": False, "mics": {"SnareTop": 1.0, "SnareBottom": 0.5}},  # polarity fixed below
    "toms": {"stereo": True, "mics": {"Tom1": (-0.35, 1.0), "Tom2": (0.0, 1.0), "FTom1": (0.45, 1.0), "FTom2": (0.6, 1.0)}},
    "hihat": {"stereo": False, "mics": {"Hihat": 1.0}},
    "ride": {"stereo": False, "mics": {"Ride": 1.0}},
    # Crocell names its overheads from the audience side; everything here is drummer's perspective
    # (hats + high tom left, floor tom + ride right), so the overhead pair is swapped.
    "overheads": {"stereo": True, "mics": {"OHLeft": (1.0, 1.0), "OHRight": (-1.0, 1.0), "OHCenter": (0.0, 0.7)}},
    "room": {"stereo": True, "mics": {"AmbLeft": (-1.0, 1.0), "AmbRight": (1.0, 1.0)}},
}


def fetch(work):
    from remotezip import RemoteZip
    os.makedirs(f"{work}/raw", exist_ok=True)
    plan = {}
    with RemoteZip(ZIP) as z:
        for p in PIECES:
            x = z.read(f"CrocellKit/{p}/{p}.xml").decode()
            samples = re.findall(r'<sample name="([^"]+)" power="([0-9.eE-]+)">\s*<audiofile[^>]*file="([^"]+)"', x)
            chans = re.findall(r'channel="([^"]+)" file="[^"]+" filechannel="(\d+)"', x.split("</sample>")[0])
            samples = sorted((float(pw), f) for _, pw, f in samples)
            n = len(samples)
            k = min(LAYERS, n)
            hi = 1.0 if p in TOP else 0.97
            idx = sorted({min(n - 1, round((0.05 + (hi - 0.05) * i / max(1, k - 1)) * (n - 1))) for i in range(k)})
            picks = [samples[i] for i in idx]
            plan[p] = {"channels": {c: int(i) for c, i in chans}, "layers": [{"power": pw, "file": f} for pw, f in picks]}
            for _, f in picks:
                dst = f"{work}/raw/{p}__{os.path.basename(f)}"
                if not os.path.exists(dst):
                    open(dst, "wb").write(z.read(f"CrocellKit/{p}/{f}"))
    json.dump(plan, open(f"{work}/plan.json", "w"), indent=1)


def build(work):
    import numpy as np
    import soundfile as sf

    plan = json.load(open(f"{work}/plan.json"))
    pan2 = lambda x, p: np.stack([x * np.cos((p + 1) * np.pi / 4), x * np.sin((p + 1) * np.pi / 4)], 1)
    # Snare bottom polarity from the loudest snare hit.
    s = plan["Snare"]
    d, sr = sf.read(f"{work}/raw/Snare__{os.path.basename(s['layers'][-1]['file'])}", dtype="float32")
    top, bot = d[:4800, s["channels"]["SnareTop"] - 1], d[:4800, s["channels"]["SnareBottom"] - 1]
    if float(np.dot(top, bot)) < 0:
        GROUPS["snare"]["mics"]["SnareBottom"] = -0.5
    mixed = {}
    for piece, info in plan.items():
        ch = info["channels"]
        for li, layer in enumerate(info["layers"]):
            d, sr = sf.read(f"{work}/raw/{piece}__{os.path.basename(layer['file'])}", dtype="float32")
            if piece in TRANSIENT:
                k, tau = TRANSIENT[piece]
                oh = np.abs(d[:, ch["OHLeft"] - 1]) + np.abs(d[:, ch["OHRight"] - 1])
                on = int(np.argmax(oh > oh.max() * 0.1))
                t = np.maximum(0, np.arange(len(d)) - on) / sr
                d = d * (1 + k * np.exp(-t / tau))[:, None].astype(np.float32)
            out = {}
            for g, spec in GROUPS.items():
                acc = np.zeros((len(d), 2 if spec["stereo"] else 1), np.float32)
                for mic, v in spec["mics"].items():
                    if mic not in ch:
                        continue
                    x = d[:, ch[mic] - 1]
                    if spec["stereo"]:
                        acc += pan2(x * v[1], v[0])
                    else:
                        acc[:, 0] += x * v
                out[g] = acc
            mixed[(piece, li)] = out
    G = 0.89 / max(float(np.abs(a).max()) for o in mixed.values() for a in o.values())
    os.makedirs(f"{work}/out", exist_ok=True)
    for f in os.listdir(f"{work}/out"):
        os.remove(f"{work}/out/{f}")  # (m4a + flac)
    manifest = {"name": "CrocellKit", "sampleRate": sr, "license": "CC BY 4.0",
                "credit": "CrocellKit by Lars Muldjord / DrumGizmo (drumgizmo.org); kit: Crocell (crocell.dk); mic setup: JBOSound",
                "groups": {g: {"stereo": s["stereo"]} for g, s in GROUPS.items()}, "pieces": {}}
    for (piece, li), out in mixed.items():
        cap = int(CAP.get(piece, 3.5) * sr)
        entry = {"power": plan[piece]["layers"][li]["power"], "files": {}}
        for g, a in out.items():
            if g in ONLY and piece not in ONLY[g]:
                continue  # e.g. no snare/cymbal bleed on the toms track, no tom/cymbal bleed on the snare
            a = a * G
            peak = float(np.abs(a).max())
            if 20 * np.log10(peak + 1e-12) < -48:
                continue  # negligible bleed: skip the file
            # Each track ends where *it* decays (60 dB under its own peak, floor −80 dBFS):
            # bleed tails are short, so they don't inherit the cymbal's length.
            mag = np.abs(a).max(1)
            idx = np.nonzero(mag > max(peak * 1e-3, 1e-4))[0]
            n = min(int(idx[-1]) + 1 if len(idx) else 480, cap)
            fade = min(int(0.03 * sr), n)
            a = a[:n].copy()
            a[n - fade:] *= np.linspace(1, 0, fade)[:, None]
            name = f"{piece}_{li}_{g}"
            if g in LOSSLESS:
                # Cymbals / snare wires are noise-like: AAC smears them (error only 11–15 dB under
                # the signal at 96–160 kb/s, audible as "distortion" once the top is boosted).
                # FLAC 16-bit is exact; the kit is held as 16-bit PCM in memory anyway.
                sf.write(f"{work}/out/{name}.flac", a, sr, subtype="PCM_16", format="FLAC")
                entry["files"][g] = f"{name}.flac"
                continue
            sf.write(f"{work}/out/{name}.wav", a, sr, subtype="PCM_24")
            # (Higher bitrates don't help: the source mics carry little above ~12 kHz — the cymbals'
            # air is generated by an exciter in the mix instead.)
            subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", "-b", "160000" if a.shape[1] == 2 else "96000",
                            f"{work}/out/{name}.wav", f"{work}/out/{name}.m4a"], check=True)
            os.remove(f"{work}/out/{name}.wav")
            entry["files"][g] = f"{name}.m4a"
        manifest["pieces"].setdefault(piece, {"gm": GM[piece], "layers": []})["layers"].append(entry)
    for piece, p in manifest["pieces"].items():
        if piece.startswith("Hihat"):
            p["group"] = "hihat"
        if piece in ("HihatClosed", "HihatPedal"):
            p["choke"] = "hihat"
    json.dump(manifest, open(f"{work}/out/kit.json", "w"), indent=1)


if __name__ == "__main__":
    {"fetch": fetch, "build": build}[sys.argv[1]](sys.argv[2])
