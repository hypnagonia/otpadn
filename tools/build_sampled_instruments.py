"""
Build Otpadn's sampled bass / acoustic guitar / DI electric guitar and the guitar-cab impulse
responses from free (CC0) sources. Only the chosen samples are downloaded.

    python tools/build_sampled_instruments.py fetch <workdir>
    python tools/build_sampled_instruments.py build <workdir>   # needs: numpy soundfile; macOS afconvert

Output: <workdir>/out/<instrument>/{inst.json,*.m4a,LICENSE.txt} and <workdir>/out/cabs/*.wav
→ copy to public/instruments/.

Sources (all CC0 1.0):
  bass-darkblack   Karoryfer Samples "Black And Blue Basses" (dark black 5-string), fingered sustains:
                   every 2nd semitone, 4 dynamics × 2 round robins.
  acoustic-martin  2017 Martin HD-28 Vintage Series by Jeff Learman (Discord SFZ GM Bank).
  egtr-fsbs        FreePats "Electric Guitar FSBS (direct)": bridge-pickup DI, 2 dynamics × 3 round robins.
  cabs             Jester Dyne Productions "Jester's Brutal Pack" 4x12 cabinet IRs.
"""
import json, os, re, subprocess, sys, urllib.parse, urllib.request, zipfile, io

GH = "https://api.github.com/repos"
RAW = "https://raw.githubusercontent.com"

BASS = ("sfzinstruments/karoryfer.black-and-blue-basses", "main", "Samples/darkblack/reg")
MARTIN = ("sfzinstruments/Discord-SFZ-GM-Bank", "master", "Discord GM/Melodic/026-Acoustic Guitar (steel)")
DI = ("freepats/electric-guitar-FSBS-direct", "main", "samples/bridge")
CAB_ZIP = "https://www.jester-dyne-productions.com/content/files/2023/04/JestersBrutalPack_1.0.zip"
CABS = {"v30": "1_Cookie_Monster.wav", "blend": "8_Big_Bubba.wav", "dv77": "2_Darth_Genocider.wav"}

NOTE = {"c": 0, "cs": 1, "db": 1, "d": 2, "ds": 3, "eb": 3, "e": 4, "f": 5, "fs": 6, "gb": 6, "g": 7, "gs": 8, "ab": 8, "a": 9, "as": 10, "bb": 10, "b": 11}


def midi(name):
    """'a2', 'cs3', 'C#4', 'A#5', 'Bb2' → MIDI note (C4 = 60)."""
    m = re.match(r"([A-Ga-g])([#sb]?)(-?\d)$", name.replace("_", ""))
    n, acc, octave = m.group(1).lower(), m.group(2), int(m.group(3))
    acc = {"#": "s", "s": "s", "b": "b", "": ""}[acc]
    return NOTE[n + acc] + 12 * (octave + 1)


def listing(repo, ref, path):
    req = urllib.request.Request(f"{GH}/{repo}/contents/{urllib.parse.quote(path)}?ref={ref}", headers={"Accept": "application/vnd.github+json"})
    if os.environ.get("GITHUB_TOKEN"):
        req.add_header("Authorization", f"Bearer {os.environ['GITHUB_TOKEN']}")
    return [x["name"] for x in json.load(urllib.request.urlopen(req)) if x["type"] == "file"]


def download(repo, ref, path, name, dst):
    if not os.path.exists(dst):
        urllib.request.urlretrieve(f"{RAW}/{repo}/{ref}/{urllib.parse.quote(path)}/{urllib.parse.quote(name)}", dst)


def plan_bass(names):
    # darkblack_<note>_<dyn>_rr<n>.wav, dyn ∈ p mp mf f
    out = []
    for n in names:
        m = re.match(r"darkblack_([a-g](?:s|b)?\d)_(p|mp|mf|f)_rr(\d)\.wav$", n)
        if m:
            out.append({"file": n, "note": midi(m.group(1)), "dyn": m.group(2), "rr": int(m.group(3))})
    keys = sorted({x["note"] for x in out})
    keep = set(keys[::2]) | {keys[-1]}  # every 2nd semitone (± 1 semitone of pitch shift at most)
    return [x for x in out if x["note"] in keep and x["rr"] <= 2]


def plan_di(names):
    # <Note>_s<string>[_soft]_<rr>.wav — one string per note (the lowest = thickest), 3 round robins
    out = []
    for n in names:
        m = re.match(r"([A-G]#?\d)_s(\d)(_soft)?_(\d+)\.wav$", n)
        if m:
            out.append({"file": n, "note": midi(m.group(1)), "string": int(m.group(2)), "dyn": "soft" if m.group(3) else "hard", "rr": int(m.group(4))})
    best = {}
    for x in out:
        best[x["note"]] = min(best.get(x["note"], 9), x["string"])
    return [x for x in out if x["string"] == best[x["note"]] and x["rr"] <= 3]


def plan_martin(names):
    out = []
    for n in names:
        m = re.match(r"MartinGM2_\d+_+([A-G]b?\d)_\d\.wav$", n)
        if m:
            out.append({"file": n, "note": midi(m.group(1)), "dyn": "all", "rr": 1})
    return out


def fetch(work):
    os.makedirs(work, exist_ok=True)
    plans = {}
    for key, (repo, ref, path), planner in [("bass-darkblack", BASS, plan_bass), ("egtr-fsbs", DI, plan_di), ("acoustic-martin", MARTIN, plan_martin)]:
        picks = planner(listing(repo, ref, path))
        os.makedirs(f"{work}/raw/{key}", exist_ok=True)
        for x in picks:
            download(repo, ref, path, x["file"], f"{work}/raw/{key}/{x['file']}")
        plans[key] = picks
        print(key, len(picks), "samples")
    z = zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(CAB_ZIP).read()))
    os.makedirs(f"{work}/raw/cabs", exist_ok=True)
    for short, f in CABS.items():
        name = next(n for n in z.namelist() if n.endswith("/48kHz/" + f) and "__MACOSX" not in n)
        open(f"{work}/raw/cabs/{short}.wav", "wb").write(z.read(name))
    json.dump(plans, open(f"{work}/plan.json", "w"), indent=1)


SPEC = {
    # cap: seconds kept (a fade-out ends the sample); vel: dynamic → [lovel, hivel]
    "bass-darkblack": {"cap": 3.0, "vel": {"p": [1, 45], "mp": [46, 75], "mf": [76, 102], "f": [103, 127]}, "release": 0.08, "mono": True, "bitrate": 96000,
                       "name": "Black And Blue Basses — dark black 5-string, fingered",
                       "credit": "Karoryfer Samples, \"Black And Blue Basses\" (https://shop.karoryfer.com/pages/free-black-and-blue-basses)"},
    "egtr-fsbs": {"cap": 4.0, "vel": {"soft": [1, 92], "hard": [93, 127]}, "release": 0.12, "mono": False, "bitrate": 96000,
                  "name": "Electric guitar DI — FSBS, bridge pickup",
                  "credit": "FreePats project, \"Electric Guitar FSBS (direct)\" (https://github.com/freepats/electric-guitar-FSBS-direct)"},
    "acoustic-martin": {"cap": 4.5, "vel": {"all": [1, 127]}, "release": 0.35, "mono": False, "bitrate": 128000,
                        "name": "Acoustic guitar — 2017 Martin HD-28 Vintage Series",
                        "credit": "Jeff Learman, for the Discord SFZ GM Bank (https://github.com/sfzinstruments/Discord-SFZ-GM-Bank)"},
}


def build(work):
    import numpy as np
    import soundfile as sf

    plans = json.load(open(f"{work}/plan.json"))
    os.makedirs(f"{work}/out", exist_ok=True)
    for key, picks in plans.items():
        spec = SPEC[key]
        out = f"{work}/out/{key}"
        os.makedirs(out, exist_ok=True)
        for f in os.listdir(out):
            os.remove(f"{out}/{f}")
        data = {}
        for x in picks:
            d, sr = sf.read(f"{work}/raw/{key}/{x['file']}", dtype="float32", always_2d=True)
            d = d.mean(1)
            peak = float(np.abs(d).max())
            # Onset: first sample within 40 dB of the peak; keep 3 ms before it (tight timing).
            on = int(np.argmax(np.abs(d) > peak * 0.01))
            d = d[max(0, on - int(0.003 * sr)):]
            n = min(len(d), int(spec["cap"] * sr))
            d = d[:n].copy()
            fade = min(int(0.25 * sr), n // 3)
            d[n - fade:] *= np.linspace(1, 0, fade) ** 2
            d[: int(0.001 * sr)] *= np.linspace(0, 1, int(0.001 * sr))  # click-free start
            data[x["file"]] = (d, sr)
        G = 0.89 / max(float(np.abs(d).max()) for d, _ in data.values())  # one gain: keeps the dynamics
        zones = {}
        for x in picks:
            d, sr = data[x["file"]]
            d = d * G
            stem = os.path.splitext(x["file"])[0].replace("#", "s")  # "#" breaks URLs (C#4 → Cs4)
            sf.write(f"{out}/{stem}.wav", d, sr, subtype="PCM_24")
            subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", "-b", str(spec["bitrate"]), f"{out}/{stem}.wav", f"{out}/{stem}.m4a"], check=True)
            os.remove(f"{out}/{stem}.wav")
            # loudness of the attack (first 200 ms), energy-like, for level-matching between layers
            w = d[: int(0.2 * sr)]
            z = zones.setdefault(x["note"], {})
            layer = z.setdefault(x["dyn"], {"vel": spec["vel"][x["dyn"]], "files": [], "power": []})
            layer["files"].append(f"{stem}.m4a")
            layer["power"].append(float(np.mean(w * w)))
        keys = sorted(zones)
        manifest = {"name": spec["name"], "license": "CC0 1.0", "credit": spec["credit"], "release": spec["release"], "mono": spec["mono"], "zones": []}
        for i, k in enumerate(keys):
            lo = 0 if i == 0 else (keys[i - 1] + k) // 2 + 1
            hi = 127 if i == len(keys) - 1 else (k + keys[i + 1]) // 2
            layers = sorted(({"lovel": L["vel"][0], "hivel": L["vel"][1], "power": round(sum(L["power"]) / len(L["power"]) * 1e4, 4), "rr": sorted(L["files"])} for L in zones[k].values()), key=lambda L: L["lovel"])
            manifest["zones"].append({"key": k, "lo": lo, "hi": hi, "layers": layers})
        json.dump(manifest, open(f"{out}/inst.json", "w"), indent=1)
        open(f"{out}/LICENSE.txt", "w").write(f"{spec['name']}\n{spec['credit']}\nLicense: CC0 1.0 Universal (public domain dedication) — https://creativecommons.org/publicdomain/zero/1.0/\nChanges for Otpadn: subset of samples, pre-onset silence and long tails trimmed, one global gain, mono, encoded as AAC. Build script: tools/build_sampled_instruments.py\n")
        print(key, len(picks), "files,", len(keys), "zones")
    # Cabinet IRs: mono, first 120 ms (cab + a little room), gentle fade, 16-bit WAV (exact, tiny).
    cab = f"{work}/out/cabs"
    os.makedirs(cab, exist_ok=True)
    for short in CABS:
        d, sr = sf.read(f"{work}/raw/cabs/{short}.wav", dtype="float32", always_2d=True)
        d = d.mean(1)[: int(0.12 * sr)].copy()
        f = int(0.02 * sr)
        d[-f:] *= np.linspace(1, 0, f)
        d /= float(np.sqrt(np.sum(d * d)))  # unit energy: cabs swap at equal loudness
        d *= 0.5 / float(np.abs(d).max()) if float(np.abs(d).max()) > 0.5 else 1
        sf.write(f"{cab}/{short}.wav", d, sr, subtype="PCM_16")
    open(f"{cab}/LICENSE.txt", "w").write("Jester's Brutal Pack — guitar cabinet impulse responses (modified Behringer BG412S 4x12; Celestion Vintage 30, Rockdriver Jr., Eminence DV-77)\nby Bastian Karschewski / Jester Dyne Productions (https://jester-dyne-productions.com)\nLicense: CC0 1.0 (public domain), \"completely free to use in your private and commercial projects\".\nChanges for Otpadn: 3 IRs, mono, first 120 ms, unit-energy normalised.\nv30 = 1 Cookie Monster (SM57, Vintage 30) · blend = 8 Big Bubba (e606 + SM57, Rockdriver Jr. + Vintage 30) · dv77 = 2 Darth Genocider (SM57, DV-77)\n")


if __name__ == "__main__":
    {"fetch": fetch, "build": build}[sys.argv[1]](sys.argv[2])
