#!/usr/bin/env python3
"""
generate_audio_pack.py - EMPro pre-generated pronunciation pack builder.

Reads a word list, synthesises each word with OpenAI TTS in several voices,
and emits a single bundled pack file. Built to run as a GitHub Action so the
OpenAI key lives only in an encrypted Action secret and never reaches the app.

Generation is incremental. The previous pack is downloaded from the GitHub
Release and reused as the state store, so each run synthesises only the
(word, voice) pairs that are not already present. Adding a voice makes every
existing word missing that voice, so the next run backfills it automatically.

The voices to synthesise come from a "# voices: ..." header line in the word
list when one is present, otherwise from the VOICES default below. The EMPro
app writes that header when it exports a word list, so voices are chosen in
the app UI rather than edited here.

PACK FORMAT (.empack, version 1)
--------------------------------
The pack is a single binary file. No base64, no zip, no client library.

  bytes  0..7    ASCII magic, exactly  b"EMPACK1\\x00"
  bytes  8..11   uint32 little-endian  = manifest length M, in bytes
  bytes 12..12+M UTF-8 JSON manifest (see below)
  bytes 12+M..   raw audio payload; every clip's MP3 bytes concatenated

The manifest is a JSON object:

  {
    "format"   : "empack",
    "version"  : 1,
    "generation": 3,                       integer, +1 each run that adds clips
    "createdAt": "2026-05-26T08:00:00Z",
    "model"    : "gpt-4o-mini-tts",
    "voices"   : ["alloy", "nova", "fable"],
    "clipCount": 1287,
    "clips"    : [
      { "word": "ubiquitous", "voice": "alloy", "gen": 1,
        "offset": 0, "length": 8421 },
      ...
    ]
  }

"offset" and "length" locate a clip's MP3 bytes inside the audio payload,
relative to the start of the payload (i.e. relative to byte 12+M of the file).
"word" is always lowercased. The app keys its IndexedDB store by
voice + "|" + word, mirroring the existing emp-tts cache key shape.

Parsing the pack in the browser is a few lines:

  const buf  = await response.arrayBuffer();
  const dv   = new DataView(buf);
  const mLen = dv.getUint32(8, true);
  const manifest = JSON.parse(
      new TextDecoder().decode(new Uint8Array(buf, 12, mLen)));
  const dataStart = 12 + mLen;
  for (const c of manifest.clips) {
      const slice = buf.slice(dataStart + c.offset,
                              dataStart + c.offset + c.length);
      const blob  = new Blob([slice], { type: "audio/mpeg" });
      // store blob under `${c.voice}|${c.word}`
  }

OUTPUT FILES (written to tools/dist/)
-------------------------------------
  empro-audio-pack.empack          full pack, every word x every voice
  empro-audio-pack.delta.empack    only clips added in this run (this gen)
  empro-audio-pack.manifest.json   the full pack manifest alone, no audio

The manifest file is tiny; the app can fetch it first to learn coverage and
the current generation before deciding whether to download the full pack.

USAGE
-----
  python tools/generate_audio_pack.py            real run (needs OPENAI_API_KEY)
  python tools/generate_audio_pack.py --dry-run  list missing clips, no API calls
  python tools/generate_audio_pack.py --selftest build+parse a pack with fake
                                                 audio; verifies the format only
  python tools/generate_audio_pack.py --limit 20 cap API calls (for a test run)
  python tools/generate_audio_pack.py --extract  unpack the built pack into
                                                 individual MP3 files to listen

ENVIRONMENT VARIABLES
---------------------
  OPENAI_API_KEY      required for a real run
  OPENAI_TTS_MODEL    optional, default "gpt-4o-mini-tts"
  GITHUB_TOKEN        optional, used to download the previous release pack
  GITHUB_REPOSITORY   "owner/repo", supplied automatically by GitHub Actions
  PACK_RELEASE_TAG    optional, default "audio-pack"
"""

import concurrent.futures
import datetime
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.request

# --- Configuration -------------------------------------------------------

# Voices synthesised for every word. Edit this list to add or drop voices;
# the incremental logic backfills any newly added voice on the next run.
# Valid gpt-4o-mini-tts voices: alloy ash ballad coral echo fable nova onyx
# sage shimmer verse. Distinct voices give a learner pronunciation variety.
VOICES = ["ash", "fable", "nova", "shimmer"]

# Delivery guidance passed to gpt-4o-mini-tts. Single words read too fast by
# default; this asks for a clear, learner-paced model pronunciation.
TTS_INSTRUCTIONS = (
    "Pronounce this single English word clearly and at a natural, "
    "unhurried pace, as a model for an English learner. Use a standard accent."
)

MAGIC          = b"EMPACK1\x00"           # 8 bytes, fixed
PACK_VERSION   = 1
OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech"
DEFAULT_MODEL  = "gpt-4o-mini-tts"

# Paths are resolved next to this script. It works whether the script sits
# in tools/ (the intended layout) or anywhere else, as long as wordlist.txt
# is in the same folder. The dist/ output folder is created beside it too.
SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
WORDLIST     = os.path.join(SCRIPT_DIR, "wordlist.txt")
DIST_DIR     = os.path.join(SCRIPT_DIR, "dist")
FULL_NAME    = "empro-audio-pack.empack"
DELTA_NAME   = "empro-audio-pack.delta.empack"
MANIFEST_NAME = "empro-audio-pack.manifest.json"

MAX_WORKERS  = 4                          # gentle concurrency for the API
HTTP_TIMEOUT = 60                         # seconds per request
MAX_RETRIES  = 5                          # for 429 / 5xx / network errors


# --- Word list -----------------------------------------------------------

def read_wordlist(path):
    """Return a deduplicated, lowercased list of words from a word list file.

    Plain text: one word per line, blank lines and lines starting with '#'
    ignored. A .json file is also accepted: an array of strings, or an array
    of objects each carrying a "word" field (an EMPro notebook export).
    """
    if not os.path.exists(path):
        raise SystemExit("word list not found: " + path)

    raw = open(path, "r", encoding="utf-8").read().strip()
    words = []

    if path.endswith(".json") or raw.startswith("[") or raw.startswith("{"):
        parsed = json.loads(raw)
        items  = parsed if isinstance(parsed, list) else parsed.get("notebook", [])
        for it in items:
            if isinstance(it, str):
                words.append(it)
            elif isinstance(it, dict) and it.get("word"):
                words.append(it["word"])
    else:
        for line in raw.splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                words.append(line)

    seen   = set()
    unique = []
    for w in words:
        norm = " ".join(str(w).strip().lower().split())
        if norm and norm not in seen:
            seen.add(norm)
            unique.append(norm)
    return unique


def read_voice_config(path):
    """Look for a "# voices: a, b, c" header in a plain-text word list.

    The EMPro app writes this line when it exports a word list, so the
    voice choice lives in the app UI. Returns the voice list, or None
    when no such line is present (the caller then falls back to VOICES).
    """
    if not os.path.exists(path) or path.endswith(".json"):
        return None
    for line in open(path, "r", encoding="utf-8"):
        body = line.strip()
        if not body.startswith("#"):
            continue
        body = body[1:].strip()
        if body.lower().startswith("voices:"):
            spec   = body.split(":", 1)[1].replace(",", " ")
            voices = [t.lower() for t in spec.split()]
            return voices or None
    return None


# --- Pack format ---------------------------------------------------------

def build_pack(clips, voices, generation, model):
    """Build a .empack byte string from a list of clip dicts.

    Each clip dict carries word, voice, gen, audio (bytes). Returns the tuple
    (pack_bytes, manifest_dict) so the caller can also emit the manifest alone.
    """
    payload = bytearray()
    entries = []
    for c in sorted(clips, key=lambda c: (c["word"], c["voice"])):
        offset = len(payload)
        payload.extend(c["audio"])
        entries.append({
            "word"  : c["word"],
            "voice" : c["voice"],
            "gen"   : c["gen"],
            "offset": offset,
            "length": len(c["audio"]),
        })

    manifest = {
        "format"   : "empack",
        "version"  : PACK_VERSION,
        "generation": generation,
        "createdAt": datetime.datetime.now(datetime.timezone.utc)
                             .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "model"    : model,
        "voices"   : list(voices),
        "clipCount": len(entries),
        "clips"    : entries,
    }
    mjson = json.dumps(manifest, ensure_ascii=False,
                       separators=(",", ":")).encode("utf-8")

    out = bytearray()
    out.extend(MAGIC)
    out.extend(struct.pack("<I", len(mjson)))
    out.extend(mjson)
    out.extend(payload)
    return bytes(out), manifest


def parse_pack(raw):
    """Parse a .empack byte string. Returns (manifest, clips_by_key).

    clips_by_key maps (word, voice) -> {"audio": bytes, "gen": int}.
    Raises ValueError if the magic or structure is wrong.
    """
    if len(raw) < 12 or raw[:8] != MAGIC:
        raise ValueError("not an EMPACK1 file (bad magic)")

    mlen       = struct.unpack("<I", raw[8:12])[0]
    manifest   = json.loads(raw[12:12 + mlen].decode("utf-8"))
    data_start = 12 + mlen

    clips = {}
    for e in manifest.get("clips", []):
        start = data_start + e["offset"]
        clips[(e["word"], e["voice"])] = {
            "audio": raw[start:start + e["length"]],
            "gen"  : e.get("gen", manifest.get("generation", 1)),
        }
    return manifest, clips


# --- Previous pack (incremental state) -----------------------------------

def _api_get(url, token, accept):
    req = urllib.request.Request(url, headers={
        "Accept"               : accept,
        "User-Agent"           : "empro-audio-pack-builder",
        "X-GitHub-Api-Version" : "2022-11-28",
    })
    if token:
        req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return resp.read()


def download_previous_pack(repo, tag, token):
    """Download the full pack from the GitHub Release, if one exists.

    Returns (manifest, clips_by_key) or (None, {}) when there is no prior
    release. The previous pack is the only incremental state the build needs.
    """
    if not repo:
        print("[prev] no GITHUB_REPOSITORY set; treating this as a first run")
        return None, {}
    try:
        rel_json = _api_get(
            "https://api.github.com/repos/%s/releases/tags/%s" % (repo, tag),
            token, "application/vnd.github+json")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print("[prev] no '%s' release yet; first run" % tag)
            return None, {}
        raise
    except urllib.error.URLError as e:
        print("[prev] could not reach GitHub API (%s); first run" % e)
        return None, {}

    release = json.loads(rel_json)
    asset   = next((a for a in release.get("assets", [])
                    if a["name"] == FULL_NAME), None)
    if not asset:
        print("[prev] release exists but has no %s asset; first run" % FULL_NAME)
        return None, {}

    raw = _api_get(asset["url"], token, "application/octet-stream")
    manifest, clips = parse_pack(raw)
    print("[prev] loaded %d clips, generation %d"
          % (len(clips), manifest.get("generation", 1)))
    return manifest, clips


# --- OpenAI TTS ----------------------------------------------------------

def synthesize(word, voice, api_key, model):
    """Synthesise one word in one voice. Returns MP3 bytes.

    Retries 429 and 5xx and network errors with exponential backoff. Raises
    on a 401/403 (bad key) so the run aborts rather than burning the quota.
    Returns None on a 400 so a single bad word is skipped, not fatal.
    """
    body = json.dumps({
        "model"          : model,
        "voice"          : voice,
        "input"          : word,
        "response_format": "mp3",
        "instructions"   : TTS_INSTRUCTIONS,
    }).encode("utf-8")

    for attempt in range(MAX_RETRIES):
        req = urllib.request.Request(OPENAI_TTS_URL, data=body, method="POST")
        req.add_header("Authorization", "Bearer " + api_key)
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                audio = resp.read()
                if not audio:
                    raise urllib.error.URLError("empty audio body")
                return audio
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:200]
            if e.code in (401, 403):
                raise SystemExit("OpenAI rejected the API key (HTTP %d): %s"
                                 % (e.code, detail))
            if e.code == 400:
                print("  ! skipped '%s' [%s]: HTTP 400 %s" % (word, voice, detail))
                return None
            wait = 2 ** attempt
            print("  . retry '%s' [%s] in %ds (HTTP %d)"
                  % (word, voice, wait, e.code))
            time.sleep(wait)
        except urllib.error.URLError as e:
            wait = 2 ** attempt
            print("  . retry '%s' [%s] in %ds (%s)" % (word, voice, wait, e))
            time.sleep(wait)

    print("  ! gave up on '%s' [%s] after %d attempts"
          % (word, voice, MAX_RETRIES))
    return None


# --- Build orchestration -------------------------------------------------

def collect_missing(words, voices, existing):
    """Return the list of (word, voice) pairs not present in `existing`."""
    missing = []
    for w in words:
        for v in voices:
            if (w, v) not in existing:
                missing.append((w, v))
    return missing


def run_build(dry_run=False, limit=0):
    """Full build pipeline. Reads the word list, fills gaps, writes packs."""
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    model   = os.environ.get("OPENAI_TTS_MODEL", DEFAULT_MODEL).strip() \
              or DEFAULT_MODEL
    repo    = os.environ.get("GITHUB_REPOSITORY", "").strip()
    token   = os.environ.get("GITHUB_TOKEN", "").strip()
    tag     = os.environ.get("PACK_RELEASE_TAG", "audio-pack").strip() \
              or "audio-pack"

    words       = read_wordlist(WORDLIST)
    file_voices = read_voice_config(WORDLIST)
    voices      = file_voices or VOICES
    print("[words] %d unique words in %s" % (len(words), WORDLIST))
    print("[voices] %s  (%s)" % (", ".join(voices),
          "from word list" if file_voices else "default"))

    prev_manifest, existing = download_previous_pack(repo, tag, token)
    prev_gen = prev_manifest.get("generation", 0) if prev_manifest else 0

    # Drop clips for words no longer in the list so the pack does not grow
    # forever with audio for deleted vocabulary.
    wordset = set(words)
    kept    = {k: v for k, v in existing.items() if k[0] in wordset}
    dropped = len(existing) - len(kept)
    if dropped:
        print("[prune] dropped %d clip(s) for words removed from the list"
              % dropped)

    missing = collect_missing(words, voices, kept)
    print("[plan] %d clip(s) already cached, %d to synthesise"
          % (len(kept), len(missing)))

    if limit and len(missing) > limit:
        print("[plan] --limit %d applied; deferring %d clip(s) to a later run"
              % (limit, len(missing) - limit))
        missing = missing[:limit]

    if dry_run:
        for w, v in missing:
            print("  would synthesise  %-28s [%s]" % (w, v))
        chars = sum(len(w) for w, _ in missing)
        print("[dry-run] %d clip(s), %d input character(s); no API calls made"
              % (len(missing), chars))
        return

    if missing and not api_key:
        raise SystemExit("OPENAI_API_KEY is not set; cannot synthesise. "
                         "Use --dry-run to preview without it.")

    # Synthesise missing clips with a small thread pool.
    new_gen   = prev_gen + 1 if missing else prev_gen
    new_clips = {}
    if missing:
        print("[synth] generating %d clip(s) at generation %d ..."
              % (len(missing), new_gen))
        done = 0
        with concurrent.futures.ThreadPoolExecutor(MAX_WORKERS) as pool:
            futures = {pool.submit(synthesize, w, v, api_key, model): (w, v)
                       for w, v in missing}
            for fut in concurrent.futures.as_completed(futures):
                w, v  = futures[fut]
                audio = fut.result()
                done += 1
                if audio:
                    new_clips[(w, v)] = audio
                if done % 25 == 0 or done == len(missing):
                    print("  progress %d/%d" % (done, len(missing)))
        print("[synth] %d clip(s) synthesised, %d failed"
              % (len(new_clips), len(missing) - len(new_clips)))

    # Assemble the full clip set: old kept clips plus the new ones.
    all_clips = []
    for (w, v), info in kept.items():
        all_clips.append({"word": w, "voice": v,
                           "gen": info["gen"], "audio": info["audio"]})
    for (w, v), audio in new_clips.items():
        all_clips.append({"word": w, "voice": v,
                           "gen": new_gen, "audio": audio})

    if not all_clips:
        raise SystemExit("no clips to write; word list may be empty")

    os.makedirs(DIST_DIR, exist_ok=True)

    full_bytes, manifest = build_pack(all_clips, voices, new_gen, model)
    open(os.path.join(DIST_DIR, FULL_NAME), "wb").write(full_bytes)

    manifest_only = dict(manifest)
    open(os.path.join(DIST_DIR, MANIFEST_NAME), "w", encoding="utf-8").write(
        json.dumps(manifest_only, ensure_ascii=False, indent=2))

    delta_clips = [c for c in all_clips if c["gen"] == new_gen and new_clips]
    if delta_clips:
        delta_bytes, _ = build_pack(delta_clips, voices, new_gen, model)
        open(os.path.join(DIST_DIR, DELTA_NAME), "wb").write(delta_bytes)
        print("[write] %s  (%d clip(s) added this run)"
              % (DELTA_NAME, len(delta_clips)))
    else:
        # No additions: remove any stale delta so the release does not keep
        # an out-of-date delta asset around.
        stale = os.path.join(DIST_DIR, DELTA_NAME)
        if os.path.exists(stale):
            os.remove(stale)
        print("[write] no new clips; delta pack omitted")

    size_mb = len(full_bytes) / (1024 * 1024)
    print("[write] %s  (%d clip(s), %.2f MB, generation %d)"
          % (FULL_NAME, manifest["clipCount"], size_mb, new_gen))
    print("[write] %s  (manifest only)" % MANIFEST_NAME)
    print("[done]  pack ready in %s" % DIST_DIR)


# --- Self-test -----------------------------------------------------------

def run_selftest():
    """Build a pack from fake audio, parse it back, and verify byte-equality.

    Exercises the binary format only; makes no network calls and needs no key.
    """
    import random
    random.seed(1)

    fake = []
    words = ["ubiquitous", "ephemeral", "salient", "nuance", "pivotal"]
    for gen, w in enumerate(words, start=1):
        for v in VOICES:
            n = random.randint(2000, 9000)
            fake.append({"word": w, "voice": v, "gen": gen,
                         "audio": bytes(random.getrandbits(8)
                                        for _ in range(n))})

    pack, manifest = build_pack(fake, VOICES, generation=3, model="test-model")
    assert pack[:8] == MAGIC, "magic header mismatch"

    parsed_manifest, parsed = parse_pack(pack)
    assert parsed_manifest["clipCount"] == len(fake), "clip count mismatch"
    assert parsed_manifest["voices"] == VOICES, "voices mismatch"

    for c in fake:
        got = parsed[(c["word"], c["voice"])]
        assert got["audio"] == c["audio"], \
            "audio bytes differ for %s/%s" % (c["word"], c["voice"])
        assert got["gen"] == c["gen"], \
            "gen differs for %s/%s" % (c["word"], c["voice"])

    # Delta: only the highest-generation clips.
    delta_clips = [c for c in fake if c["gen"] == 3]
    delta, _    = build_pack(delta_clips, VOICES, generation=3, model="test")
    _, dparsed  = parse_pack(delta)
    assert len(dparsed) == len(delta_clips), "delta clip count mismatch"

    print("[selftest] OK - %d clips round-tripped, %d-byte pack, delta verified"
          % (len(fake), len(pack)))


# --- Extract (listen to clips) -------------------------------------------

def run_extract():
    """Unpack the built pack into individual MP3 files so the clips can be
    played and checked. Reads tools/dist/empro-audio-pack.empack and writes
    one MP3 per clip into tools/dist/clips/, named word__voice.mp3.
    """
    pack_path = os.path.join(DIST_DIR, FULL_NAME)
    if not os.path.exists(pack_path):
        raise SystemExit("no pack at %s; run a build first" % pack_path)

    raw             = open(pack_path, "rb").read()
    manifest, clips = parse_pack(raw)
    out_dir         = os.path.join(DIST_DIR, "clips")
    os.makedirs(out_dir, exist_ok=True)

    for (word, voice), info in sorted(clips.items()):
        safe = "".join(ch if ch.isalnum() else "_" for ch in word)
        name = "%s__%s.mp3" % (safe, voice)
        open(os.path.join(out_dir, name), "wb").write(info["audio"])

    print("[extract] wrote %d MP3 file(s) to %s" % (len(clips), out_dir))
    print("[extract] open that folder and play a few to check the audio")


# --- Entry point ---------------------------------------------------------

_args = sys.argv[1:]

if "--selftest" in _args:
    run_selftest()
elif "--extract" in _args:
    run_extract()
elif "--dry-run" in _args:
    run_build(dry_run=True)
else:
    _limit = 0
    if "--limit" in _args:
        _limit = int(_args[_args.index("--limit") + 1])
    run_build(dry_run=False, limit=_limit)
