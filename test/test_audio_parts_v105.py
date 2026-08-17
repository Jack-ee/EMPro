#!/usr/bin/env python3
"""
test/test_audio_parts_v105.py - split-pack build behaviour

Run:  python3 test/test_audio_parts_v105.py

The whole point of splitting the pack is that a run touches only what
changed. That is easy to get wrong in a way no one notices for months: the
build still produces a correct pack, it just quietly re-downloads and
re-uploads 1.4 GB every time, or worse, re-synthesises audio that was
already paid for. So the money-and-bandwidth properties are asserted here,
not eyeballed.

The GitHub Release and the OpenAI API are both replaced with in-process
fakes that RECORD every call, so a test can assert that a part was not
fetched and a clip was not synthesised.
"""
import hashlib
import importlib.util
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
GEN  = os.path.join(HERE, "..", "tools", "generate_audio_pack.py")

passed = []
failed = []


def ok(cond, label):
    (passed if cond else failed).append(label)
    print(("  \u2713 " if cond else "  \u2717 ") + label)


def eq(actual, expected, label):
    same = actual == expected
    ok(same, label + ("" if same else "  \u2014 got %r, want %r"
                      % (actual, expected)))


def load_gen(workdir):
    """Load the generator with its paths pointed at a scratch directory."""
    spec = importlib.util.spec_from_file_location("gen_%d" % id(workdir), GEN)
    g    = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(g)
    g.WORDLIST = os.path.join(workdir, "wordlist.txt")
    g.DIST_DIR = os.path.join(workdir, "dist")
    g.MAX_WORKERS = 2
    return g


class FakeRelease:
    """An in-memory stand-in for the audio-pack release."""

    def __init__(self):
        self.assets   = {}      # name -> bytes
        self.fetched  = []      # names read back
        self.synth    = []      # (word, voice) pairs synthesised
        self.spend_after = 0    # spend the time budget after N clips

    def install(self, g):
        rel = self

        def release_assets(repo, tag, token):
            return {n: {"name": n, "url": "fake://" + n} for n in rel.assets}

        def _api_get(url, token, accept):
            name = url.split("fake://", 1)[1]
            rel.fetched.append(name)
            return rel.assets[name]

        def synthesize(word, voice, api_key, model):
            if g._abort.is_set() or g._past_deadline():
                return None
            rel.synth.append((word, voice))
            # Let a test spend the budget after a fixed number of clips. Wall
            # clock will not do it: the fakes are instant, so a real budget
            # small enough to expire is also small enough to be flaky.
            if rel.spend_after and len(rel.synth) >= rel.spend_after:
                g._deadline[0] = g.time.monotonic() - 1
            # Deterministic fake audio so part bytes are reproducible.
            return hashlib.sha256((word + voice).encode()).digest() * 4

        g.release_assets = release_assets
        g._api_get       = _api_get
        g.synthesize     = synthesize

    def publish(self, g):
        """Copy dist/ onto the release the way the workflow does, honouring
        keep-assets.txt so stale assets are deleted."""
        dist = g.DIST_DIR
        keep = set()
        kp   = os.path.join(dist, "keep-assets.txt")
        if os.path.exists(kp):
            keep = set(l.strip() for l in open(kp) if l.strip())
        for fn in os.listdir(dist):
            if fn == "keep-assets.txt":
                continue
            self.assets[fn] = open(os.path.join(dist, fn), "rb").read()
        if keep:
            for name in list(self.assets):
                if name not in keep:
                    del self.assets[name]
        shutil.rmtree(dist, ignore_errors=True)

    def manifest(self):
        return json.loads(self.assets["empro-audio-pack.manifest.json"]
                          .decode("utf-8"))

    def reset_counters(self):
        self.fetched = []
        self.synth   = []


def write_list(g, words, header=""):
    lines = ["# voices: nova, fable", "# sentence_voice: nova",
             "# part_blocks: 3"]
    if header:
        lines.append(header)
    lines.append("")
    for i, (idx, entries) in enumerate(words):
        lines.append("#@%d w%d" % (idx, idx))
        lines.extend(entries)
    open(g.WORDLIST, "w", encoding="utf-8").write("\n".join(lines) + "\n")


def build(g, **kw):
    os.environ["GITHUB_REPOSITORY"] = "fake/repo"
    os.environ["OPENAI_API_KEY"]    = "sk-fake"
    try:
        g.run_build(**kw)
        return None
    except SystemExit as e:
        return str(e)


# ============================================================
print("\n1. First build splits the list into parts")
work = tempfile.mkdtemp()
g    = load_gen(work)
rel  = FakeRelease()
rel.install(g)

# part_blocks 3, so blocks 1-3 are one part, 4-6 the next.
write_list(g, [(1, ["alpha"]), (2, ["bravo"]), (3, ["charlie"]),
               (4, ["delta"]), (5, ["echo"])])
build(g)
rel.publish(g)
man = rel.manifest()

eq(man["version"], 2, "manifest is v2")
eq(man["partBlocks"], 3, "the stride comes from the header")
eq([p["name"] for p in man["parts"]],
   ["empro-audio-pack.p00001-00003.empack",
    "empro-audio-pack.p00004-00006.empack"],
   "blocks are grouped 1-3 and 4-6")
eq(man["clipCount"], 10, "5 words x 2 voices")
ok(all(len(p["sha256"]) == 64 for p in man["parts"]),
   "every part carries a sha256")
ok(all("keysSha256" in p for p in man["parts"]),
   "and the hash of the keys it actually holds")
eq(len(rel.synth), 10, "10 clips synthesised on a first build")

# ============================================================
print("\n2. Nothing changed: no download, no synthesis, no new bytes")
rel.reset_counters()
before = dict(rel.assets)
build(g)
rel.publish(g)

eq(rel.synth, [], "not one clip is synthesised")
ok(all(not n.endswith(".empack") for n in rel.fetched),
   "and not one part is downloaded \u2014 the manifest alone settles it")
eq(rel.manifest()["parts"], man["parts"],
   "the part records are carried over byte for byte")
ok(all(before[n] == rel.assets[n] for n in before if n.endswith(".empack")),
   "the published part bytes are untouched")

# ============================================================
print("\n3. Editing one word rebuilds only its part")
rel.reset_counters()
write_list(g, [(1, ["alpha"]), (2, ["bravo CHANGED"]), (3, ["charlie"]),
               (4, ["delta"]), (5, ["echo"])])
build(g)

fetched_parts = [n for n in rel.fetched if n.endswith(".empack")]
eq(fetched_parts, ["empro-audio-pack.p00001-00003.empack"],
   "only the part holding block 2 is downloaded")
eq(sorted(rel.synth), [("bravo changed", "fable"), ("bravo changed", "nova")],
   "only the changed entry is synthesised")
built = sorted(f for f in os.listdir(g.DIST_DIR) if f.endswith(".empack"))
eq(built, ["empro-audio-pack.p00001-00003.empack"],
   "only that part is written out, so only it is re-uploaded")
rel.publish(g)
man3 = rel.manifest()
eq(len(man3["parts"]), 2, "both parts are still in the manifest")
p4 = next(p for p in man3["parts"] if p["from"] == 4)
eq(p4["sha256"], next(p for p in man["parts"] if p["from"] == 4)["sha256"],
   "the untouched part keeps its old sha256")

# ============================================================
print("\n4. Adding words lands in the tail part only")
rel.reset_counters()
write_list(g, [(1, ["alpha"]), (2, ["bravo CHANGED"]), (3, ["charlie"]),
               (4, ["delta"]), (5, ["echo"]), (6, ["foxtrot"])])
build(g)
fetched_parts = [n for n in rel.fetched if n.endswith(".empack")]
eq(fetched_parts, ["empro-audio-pack.p00004-00006.empack"],
   "only the tail part is fetched")
eq(sorted(set(w for w, _ in rel.synth)), ["foxtrot"],
   "only the new word is synthesised")
rel.publish(g)

# ============================================================
print("\n5. A time budget stops the run and leaves a resumable state")
rel.reset_counters()
write_list(g, [(1, ["alpha"]), (2, ["bravo CHANGED"]), (3, ["charlie"]),
               (4, ["delta"]), (5, ["echo"]), (6, ["foxtrot"]),
               (7, ["golf"]), (8, ["hotel"]), (9, ["india"])])
g.TIME_BUDGET_MINUTES = 320             # a real budget, spent on cue below
rel.spend_after = 3                     # after 3 of the 6 new clips
msg = build(g)
ok(msg is not None and "INCOMPLETE" in msg,
   "the run reports INCOMPLETE rather than pretending to be done")
ok("time budget" in (msg or ""), "and names the time budget as the cause")
ok("planned checkpoint" in (msg or ""),
   "with re-run advice rather than billing advice")
rel.publish(g)
g.TIME_BUDGET_MINUTES = 0.0
rel.spend_after = 0

partial = rel.manifest()
p7 = next((p for p in partial["parts"] if p["from"] == 7), None)
ok(p7 is not None and p7["clipCount"] < 6,
   "the part it was working on is published INCOMPLETE, not discarded — "
   "the clips already paid for are saved")
eq(len(rel.synth), 3, "only the clips it had time for were synthesised")
prev_keys = p7["keysSha256"] if p7 else ""
ok(bool(prev_keys), "and its keysSha256 describes what it actually holds")

print("\n6. Re-running after the budget fills the gap and nothing else")
rel.reset_counters()
build(g)
rel.publish(g)
final = rel.manifest()
eq(final["clipCount"], 18, "9 words x 2 voices are all present in the end")
resynth = [k for k in rel.synth if k[0] in ("alpha", "charlie", "delta")]
eq(resynth, [], "no clip from an earlier run is synthesised again")
eq(len(rel.synth), 3, "exactly the 3 clips the budget cut off are filled in")
ok("empro-audio-pack.p00007-00009.empack" in rel.fetched,
   "it re-reads the incomplete part to keep the clips already in it")

# ============================================================
print("\n7. Deleting a word retires its part and the stale asset")
rel.reset_counters()
write_list(g, [(1, ["alpha"]), (2, ["bravo CHANGED"]), (3, ["charlie"])])
build(g)
rel.publish(g)
names = sorted(n for n in rel.assets if n.endswith(".empack"))
eq(names, ["empro-audio-pack.p00001-00003.empack"],
   "parts for removed blocks are deleted from the release")
eq(rel.manifest()["clipCount"], 6, "and the manifest shrinks to match")

# ============================================================
print("\n7b. New parts are built before parts that only changed")
rel.reset_counters()
# Blocks 1-3 already exist. Change one of them AND add a new part's worth of
# blocks, then cut the budget short: the new part must be the one that got
# finished, because that is the material the user is waiting for. Under plain
# index order the changed part sorts first and would eat the whole budget.
write_list(g, [(1, ["alpha"]), (2, ["bravo AGAIN"]), (3, ["charlie"]),
               (4, ["delta"]), (5, ["echo"]), (6, ["foxtrot"])])
g.TIME_BUDGET_MINUTES = 320
rel.spend_after = 2               # enough for the new part, not for both
build(g)
rel.publish(g)
man7 = rel.manifest()
p456 = next((p for p in man7["parts"] if p["from"] == 4), None)
ok(p456 is not None and p456["clipCount"] > 0,
   "the brand-new part is the one that got worked on")
ok(all(w in ("delta", "echo", "foxtrot") for w, _ in rel.synth),
   "every clip the budget paid for belongs to the new part, not to "
   "re-synthesising the old one")
ok(not any(w == "bravo again" for w, _ in rel.synth),
   "the changed part waits its turn")
g.TIME_BUDGET_MINUTES = 0.0
rel.spend_after = 0
rel.reset_counters()
build(g); rel.publish(g)          # finish the changed part on the next run

# ============================================================
print("\n8. Migrating from the pre-split pack synthesises nothing")
work2 = tempfile.mkdtemp()
g2    = load_gen(work2)
rel2  = FakeRelease()
rel2.install(g2)

# Publish a v1 monolith by hand, the way the old builder did.
old_clips = [{"word": w, "voice": v, "gen": 1,
              "audio": hashlib.sha256((w + v).encode()).digest() * 4}
             for w in ("alpha", "bravo", "charlie", "delta")
             for v in ("nova", "fable")]
mono, _ = g2.build_pack(old_clips, voices=["nova", "fable"], generation=4,
                        model="gpt-4o-mini-tts", stamp=True)
rel2.assets["empro-audio-pack.empack"] = mono

write_list(g2, [(1, ["alpha"]), (2, ["bravo"]), (3, ["charlie"]),
                (4, ["delta"])])
build(g2)
eq(rel2.synth, [], "the migration run synthesises nothing at all")
ok("empro-audio-pack.empack" in rel2.fetched,
   "it reads the pre-split pack as prior state")
rel2.publish(g2)
m2 = rel2.manifest()
eq(m2["version"], 2, "and republishes it as a v2 split pack")
eq(m2["clipCount"], 8, "with every clip carried across")
ok("empro-audio-pack.empack" not in rel2.assets,
   "the pre-split asset is cleaned up afterwards")

# ============================================================
print("\n" + "=" * 56)
print("%d passed, %d failed" % (len(passed), len(failed)))
print("=" * 56)
sys.exit(1 if failed else 0)
