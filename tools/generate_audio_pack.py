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

Long entries (sentences and definitions) use the "# sentence_voice:" header
instead, so the word voice selection can change without re-synthesising every
sentence in the pack.

A run is bounded by TIME_BUDGET_MINUTES (environment, 0 = unbounded). When the
budget runs out the build stops itself, writes the partial pack, and exits
non-zero with [INCOMPLETE]; the workflow publishes the pack anyway, so the
next run continues from it. A runner that is killed on its own timeout instead
loses everything that run synthesised, which is what the budget exists to
prevent.

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
  python tools/generate_audio_pack.py --limit 20 cap words synthesised this run
  python tools/generate_audio_pack.py --range 51-100  build only word indices
                                                 51..100 (the word list, when
                                                 exported from the app, tags
                                                 each word with a stable index;
                                                 a "# range:" header does the
                                                 same and the CLI flag overrides it)
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
import hashlib
import json
import os
import struct
import sys
import threading
import time
import urllib.error
import urllib.request

# --- Configuration -------------------------------------------------------

# Voices synthesised for every word. Edit this list to add or drop voices;
# the incremental logic backfills any newly added voice on the next run.
# Valid gpt-4o-mini-tts voices: alloy ash ballad coral echo fable nova onyx
# sage shimmer verse. Distinct voices give a learner pronunciation variety.
VOICES = ["ash", "fable", "nova", "shimmer"]

# Per-entry voice policy. A word-list entry no longer than
# SHORT_ENTRY_MAX_CHARS (a word or a short collocation) is synthesised in
# EVERY voice, so My Words autoplay can vary the voice on repeat. A longer
# entry (an example sentence or a definition) is synthesised in only
# LONG_ENTRY_VOICES voice(s): those clips are several times larger, are
# heard far less often than a drilled word, and voice variety across a
# whole sentence is barely noticeable — so paying 4x the bytes for it is
# not worth it. Raise LONG_ENTRY_VOICES toward len(VOICES) if you do want
# sentences and definitions to rotate too, at a real cost in pack size.
SHORT_ENTRY_MAX_CHARS = 40
LONG_ENTRY_VOICES     = 1

# Which voice reads the long entries. Left empty, a long entry uses
# voices[:LONG_ENTRY_VOICES] - the FIRST voice of the active list, which is
# alphabetical, so de-selecting whichever voice sorts first (dropping
# "alloy" from an all-voices list) silently moves every sentence to the next
# voice and re-synthesises thousands of clips at full price, while the old
# ones stay in the pack forever. Pinning the sentence voice here, or with a
# "# sentence_voice:" header from the app, breaks that link: the word voice
# list can then change freely without touching a single sentence clip.
SENTENCE_VOICES = []

# In-band time budget, in minutes, from the TIME_BUDGET_MINUTES environment
# variable; 0 disables it. A hosted runner is killed at its own limit with
# no warning, and every clip synthesised in that run dies with the process.
# With a budget the run stops itself first, the partial pack is written and
# published, and the next run continues from it. So the budget turns a
# timeout from "lost the run" into "saved a checkpoint".
TIME_BUDGET_MINUTES = float(os.environ.get("TIME_BUDGET_MINUTES", "0") or 0)

# Delivery guidance passed to gpt-4o-mini-tts. The list now contains
# words, collocations, example sentences and definitions, so the prompt
# is phrased to suit any of them: a clear, learner-paced model reading.
TTS_INSTRUCTIONS = (
    "Read the following English text clearly and at a natural, unhurried "
    "pace, as a model for an English learner. Use a standard accent."
)

MAGIC          = b"EMPACK1\x00"           # 8 bytes, fixed
PACK_VERSION   = 2

# --- Split packs (v2) ----------------------------------------------------
#
# A single 1.4 GB asset is a bad unit of work: one flaky download loses all
# of it, and one new word means re-uploading and re-downloading all of it.
# So the pack is emitted as several parts and the client fetches only the
# parts whose sha256 changed.
#
# Parts are cut on WORD-BLOCK boundaries, and which part owns a block is a
# pure function of the block index: block b belongs to the part covering
# [k*stride+1 .. (k+1)*stride] where k = (b-1)//stride. That matters more
# than it looks. A size-greedy split would cascade - adding audio to an
# early block pushes a later block into the next part, changing that part,
# which pushes its own last block along, so a single edit re-downloads the
# whole pack. Index arithmetic cannot cascade: editing block 7 can only ever
# change the part that owns block 7.
#
# The cost is that parts are not equal in size, since a word with a long
# example carries more audio than a bare word. That is a fair price for
# never re-downloading a part that did not change.
PART_BLOCK_STRIDE = 80                    # word blocks per part
PART_NAME_FMT     = "empro-audio-pack.p%05d-%05d.empack"
OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech"
DEFAULT_MODEL  = "gpt-4o-mini-tts"

# Paths are resolved next to this script. It works whether the script sits
# in tools/ (the intended layout) or anywhere else, as long as wordlist.txt
# is in the same folder. The dist/ output folder is created beside it too.
SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
WORDLIST     = os.path.join(SCRIPT_DIR, "wordlist.txt")
DIST_DIR     = os.path.join(SCRIPT_DIR, "dist")
FULL_NAME    = "empro-audio-pack.empack"
# The v1 delta asset is retired: with split packs the parts that changed ARE
# the delta, and publishing a second copy of them doubled the upload for no
# gain. The name is kept only so the cleanup step can delete the old asset.
DELTA_NAME   = "empro-audio-pack.delta.empack"
MANIFEST_NAME = "empro-audio-pack.manifest.json"

MAX_WORKERS  = 4                          # gentle concurrency for the API
HTTP_TIMEOUT = 60                         # seconds per request
MAX_RETRIES  = 5                          # for 429 / 5xx / network errors
ABORT_AFTER_FAILS = 12                    # consecutive failures => stop early


# --- Word list -----------------------------------------------------------

def _norm_entry(s):
    """Lowercase, trim, and collapse internal whitespace."""
    return " ".join(str(s).strip().lower().split())


def read_wordlist(path):
    """Parse the word list into indexed blocks.

    A line  '#@N label'  starts block number N; every non-comment,
    non-blank line after it (until the next marker) is an entry for that
    block. Other '#' lines are comments. Blank lines are ignored. A file
    with no '#@' markers is read as one entry per block, numbered 1..n in
    file order, so a range still works on a hand-written list.

    Returns a list of dicts {"index": int, "entries": [str, ...]}. Entries
    are normalised (lowercased, whitespace-collapsed) and de-duplicated
    across the whole list; the first occurrence wins. A .json file (an
    array of strings, or notebook objects with a "word" field) is also
    accepted and yields one entry per block.
    """
    if not os.path.exists(path):
        raise SystemExit("word list not found: " + path)

    raw      = open(path, "r", encoding="utf-8").read()
    stripped = raw.strip()
    seen     = set()

    if path.endswith(".json") or stripped.startswith("[") \
            or stripped.startswith("{"):
        parsed = json.loads(stripped)
        items  = parsed if isinstance(parsed, list) \
                 else parsed.get("notebook", [])
        blocks = []
        for it in items:
            w = it if isinstance(it, str) \
                else (it.get("word") if isinstance(it, dict) else "")
            n = _norm_entry(w)
            if n and n not in seen:
                seen.add(n)
                blocks.append({"index": len(blocks) + 1, "entries": [n]})
        return blocks

    lines      = raw.splitlines()
    has_marker = any(ln.lstrip().startswith("#@") for ln in lines)
    blocks     = []
    current    = None

    for line in lines:
        s = line.strip()
        if not s:
            continue
        if s.startswith("#@"):
            # Block marker. The index is the run of digits after '@'.
            digits = ""
            for ch in s[2:].strip():
                if ch.isdigit():
                    digits += ch
                else:
                    break
            idx = int(digits) if digits else (len(blocks) + 1)
            current = {"index": idx, "entries": []}
            blocks.append(current)
            continue
        if s.startswith("#"):
            continue                        # config / comment line
        n = _norm_entry(s)
        if not n or n in seen:
            continue
        seen.add(n)
        if has_marker:
            if current is None:
                # Stray entry before the first marker — give it a block.
                current = {"index": len(blocks) + 1, "entries": []}
                blocks.append(current)
            current["entries"].append(n)
        else:
            blocks.append({"index": len(blocks) + 1, "entries": [n]})
    return blocks


def read_pack_config(path):
    """Parse "# key: value" header lines from a plain-text word list.

    The EMPro app writes these lines when it exports a word list, so
    pack settings are chosen in the app UI rather than edited here.
    Recognised keys:
      voices  comma- or space-separated voice names
      limit   max words to synthesise per run (0 or absent = no cap)
      range   word-index range to build this run, e.g. "1-50" (A-B, A..B
              or A B all accepted; trailing comment text is ignored)
      sentence_voice(s)
              voice(s) for entries longer than SHORT_ENTRY_MAX_CHARS, so
              sentence audio no longer follows the first word voice
      prune_voices
              on/off; when on, a clip whose voice is no longer used for its
              entry is dropped from the pack instead of kept forever
    Returns a dict holding only the keys that were actually present.
    """
    cfg = {}
    if not os.path.exists(path) or path.endswith(".json"):
        return cfg
    for line in open(path, "r", encoding="utf-8"):
        body = line.strip()
        if not body.startswith("#"):
            continue
        body = body[1:].strip()
        low = body.lower()
        if low.startswith("voices:"):
            spec   = body.split(":", 1)[1].replace(",", " ")
            voices = [t.lower() for t in spec.split()]
            if voices:
                cfg["voices"] = voices
        elif low.startswith("limit:"):
            try:
                n = int(body.split(":", 1)[1].strip())
                if n > 0:
                    cfg["limit"] = n
            except ValueError:
                pass
        elif low.startswith("sentence_voice:") \
                or low.startswith("sentence_voices:"):
            spec = body.split(":", 1)[1].replace(",", " ")
            vs   = [t.lower() for t in spec.split()]
            if vs:
                cfg["sentence_voices"] = vs
        elif low.startswith("part_blocks:"):
            try:
                n = int(body.split(":", 1)[1].strip())
                if n > 0:
                    cfg["part_blocks"] = n
            except ValueError:
                pass
        elif low.startswith("prune_voices:"):
            val = body.split(":", 1)[1].strip().lower()
            cfg["prune_voices"] = val in ("on", "1", "true", "yes")
        elif low.startswith("range:"):
            spec  = body.split(":", 1)[1]
            found = []
            for tok in spec.replace("..", " ").replace("-", " ") \
                           .replace(",", " ").split():
                if tok.isdigit():
                    found.append(int(tok))
                if len(found) >= 2:        # only the two bounds matter
                    break
            if len(found) >= 2:
                lo, hi = found[0], found[1]
                if lo > hi:
                    lo, hi = hi, lo
                cfg["range"] = (max(1, lo), hi)
    return cfg


# --- Pack format ---------------------------------------------------------

def build_pack(clips, voices=None, generation=None, model=None,
               stamp=True, part=None):
    """Build a .empack byte string from a list of clip dicts.

    Each clip dict carries word, voice, gen, audio (bytes). Returns the tuple
    (pack_bytes, manifest_dict) so the caller can also emit the manifest alone.

    stamp=False omits generation, createdAt, model and voices from the
    embedded manifest. That is what makes a part's bytes a pure function of
    its clips: the same clips produce the same sha256 on every run, so the
    client can trust "same hash, nothing to download". With the stamp left
    in, every part's hash would change on every build and the split would buy
    nothing at all.
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

    # Keys go in in a fixed order and json.dumps preserves it, so equal
    # clips give byte-equal output.
    manifest = {
        "format" : "empack",
        "version": PACK_VERSION,
    }
    if part:
        manifest["part"] = [int(part[0]), int(part[1])]
    if stamp:
        manifest["generation"] = generation
        manifest["createdAt"]  = (datetime.datetime.now(datetime.timezone.utc)
                                  .strftime("%Y-%m-%dT%H:%M:%SZ"))
        manifest["model"]      = model
        manifest["voices"]     = list(voices or [])
    manifest["clipCount"] = len(entries)
    manifest["clips"]     = entries
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


# --- Split-pack helpers --------------------------------------------------

def part_span(block_index, stride):
    """The [from, to] block range of the part that owns this block index."""
    k = (int(block_index) - 1) // stride
    return (k * stride + 1, (k + 1) * stride)


def part_name(span):
    return PART_NAME_FMT % (span[0], span[1])


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def keys_hash(keys):
    """Stable hash of a clip-key set, as "word|voice" lines.

    Recorded per part so the next run can tell whether a part's content set
    changed without downloading the part. It hashes the keys ACTUALLY written
    into the part, never the keys that were wanted: a part whose synthesis
    stopped half way must come out as "changed" next run, or its gaps would
    never be filled.
    """
    body = "\n".join(sorted("%s|%s" % (w, v) for w, v in keys))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def entry_blocks(blocks):
    """Map each entry to the block index that owns it.

    read_wordlist de-duplicates entries across the whole list, first
    occurrence winning, so an entry belongs to exactly one block and therefore
    to exactly one part.
    """
    owner = {}
    for b in blocks:
        for e in b["entries"]:
            owner.setdefault(e, b["index"])
    return owner


def plan_parts(blocks, voices, svoices, stride):
    """Group the desired clip keys by part.

    Returns a list of (span, keys) ordered by span, where keys is every
    (entry, voice) pair the part should hold.
    """
    by_span = {}
    seen    = set()
    for b in blocks:
        span = part_span(b["index"], stride)
        for e in b["entries"]:
            if e in seen:
                continue
            seen.add(e)
            for v in voices_for(e, voices, svoices):
                by_span.setdefault(span, []).append((e, v))
    return [(span, by_span[span]) for span in sorted(by_span)]


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


def release_assets(repo, tag, token):
    """Assets on the release, by name. ({} when there is no release yet.)"""
    if not repo:
        print("[prev] no GITHUB_REPOSITORY set; treating this as a first run")
        return {}
    try:
        rel_json = _api_get(
            "https://api.github.com/repos/%s/releases/tags/%s" % (repo, tag),
            token, "application/vnd.github+json")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print("[prev] no '%s' release yet; first run" % tag)
            return {}
        raise
    except urllib.error.URLError as e:
        print("[prev] could not reach GitHub API (%s); first run" % e)
        return {}
    release = json.loads(rel_json)
    return {a["name"]: a for a in release.get("assets", [])}


def read_previous_manifest(assets, token):
    """The published manifest, or None. Small file, always worth reading.

    A v2 manifest is the index the whole incremental build turns on: it says
    which parts exist, what their sha256 is, and which clip keys each one
    holds, so this run can decide what to touch WITHOUT downloading 1.4 GB.
    """
    a = assets.get(MANIFEST_NAME)
    if not a:
        return None
    try:
        raw = _api_get(a["url"], token, "application/octet-stream")
        return json.loads(raw.decode("utf-8"))
    except Exception as e:                     # a damaged manifest is not fatal
        print("[prev] manifest unreadable (%s); treating as a first run" % e)
        return None


def load_part(assets, token, name):
    """Download one published part and return its clips_by_key."""
    a = assets.get(name)
    if not a:
        return {}
    raw = _api_get(a["url"], token, "application/octet-stream")
    _, clips = parse_pack(raw)
    print("      downloaded %s (%.1f MB, %d clip(s))"
          % (name, len(raw) / (1024 * 1024), len(clips)))
    return clips


def load_monolith(assets, token):
    """Read the pre-split single-file pack as prior state.

    The first v2 build must find the v1 pack, or it would treat 1.4 GB of
    already-paid-for audio as missing and synthesise all of it again.
    """
    a = assets.get(FULL_NAME)
    if not a:
        return None, {}
    raw = _api_get(a["url"], token, "application/octet-stream")
    manifest, clips = parse_pack(raw)
    print("[prev] loaded the pre-split pack: %d clip(s), generation %d "
          "- this run re-emits them as parts, synthesising nothing new"
          % (len(clips), manifest.get("generation", 1)))
    return manifest, clips


# --- OpenAI TTS ----------------------------------------------------------

# A fatal, account-level problem (a bad or blocked key, or — most often —
# the OpenAI usage / billing limit being reached) sets this event. Worker
# threads check it and return quickly instead of each grinding through five
# slow retries, and run_build stops submitting new work. Crucially the
# worker NEVER raises out: a SystemExit raised inside a thread used to
# propagate out of run_build and skip the pack write entirely, which is how
# an earlier run lost thousands of already-synthesised clips. Now the run
# always continues far enough to save whatever it managed to generate.
_abort        = threading.Event()
_abort_reason = [""]


_deadline = [0.0]          # monotonic seconds; 0.0 means no budget


def _signal_abort(reason):
    """Record the first fatal reason and raise the shared abort flag."""
    if not _abort.is_set():
        _abort_reason[0] = reason
        _abort.set()


def _budget_start():
    """Arm the in-band deadline and clear any abort state.

    The clear matters for correctness, not just tidiness. Under Actions every
    run is a fresh process, so a leftover flag never showed up there — but a
    second run_build in one process inherited the previous run's abort and
    skipped every part without synthesising anything, silently producing a
    pack that looked finished and was not. Arming the run resets it.
    """
    _abort.clear()
    _abort_reason[0] = ""
    _deadline[0] = (time.monotonic() + TIME_BUDGET_MINUTES * 60) \
                   if TIME_BUDGET_MINUTES > 0 else 0.0


def _past_deadline():
    return _deadline[0] > 0 and time.monotonic() >= _deadline[0]


def _budget_hit():
    """Raise the abort flag for a spent budget. Safe to call from a worker."""
    _signal_abort("time budget of %g minute(s) reached - this is a planned "
                  "checkpoint, not a failure" % TIME_BUDGET_MINUTES)


def _retry_after(http_error):
    """Seconds to wait from a Retry-After header, clamped; 0 if absent."""
    try:
        val = http_error.headers.get("Retry-After")
        if val:
            return max(1, min(60, int(float(val))))
    except (ValueError, TypeError, AttributeError):
        pass
    return 0


def _is_quota_error(detail):
    """True when an OpenAI error body shows a billing / quota limit rather
    than a transient rate limit. A quota error never clears by retrying,
    so it must be treated as fatal instead of retried for minutes."""
    low = (detail or "").lower()
    return ("insufficient_quota" in low
            or "exceeded your current quota" in low
            or ("billing" in low and "limit" in low))


def synthesize(word, voice, api_key, model):
    """Synthesise one word in one voice. Returns MP3 bytes, or None.

    Transient errors (a rate-limit 429, 5xx, or a network error) are retried
    with exponential backoff, honouring a Retry-After header when present. A
    400 skips just that one clip. A 401/403, or a 429 whose body shows a
    quota / billing limit, is FATAL: it sets the shared abort signal and
    returns None so the run stops soon and saves what it already has. It
    never raises out of the worker thread.
    """
    if _abort.is_set():
        return None
    # Checked here as well as in the main loop: a worker must not START a
    # new clip past the deadline, which bounds the overrun to whatever is
    # already in flight instead of one full clip per worker.
    if _past_deadline():
        _budget_hit()
        return None

    body = json.dumps({
        "model"          : model,
        "voice"          : voice,
        "input"          : word,
        "response_format": "mp3",
        "instructions"   : TTS_INSTRUCTIONS,
    }).encode("utf-8")

    for attempt in range(MAX_RETRIES):
        if _abort.is_set():
            return None
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
            detail = e.read().decode("utf-8", "replace")[:300]
            if e.code in (401, 403):
                _signal_abort("OpenAI rejected the request (HTTP %d) - a bad "
                              "or blocked key, or the account/billing limit "
                              "was reached: %s" % (e.code, detail))
                return None
            if e.code == 429 and _is_quota_error(detail):
                _signal_abort("OpenAI quota / billing limit reached "
                              "(HTTP 429): %s" % detail)
                return None
            if e.code == 400:
                print("  ! skipped '%s' [%s]: HTTP 400 %s"
                      % (word, voice, detail))
                return None
            # Transient: a rate-limit 429 or a 5xx. Honour Retry-After.
            wait = _retry_after(e) or (2 ** attempt)
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

def voices_for(entry, voices, sentence_voices=None):
    """Voices to synthesise for one word-list entry.

    Words and short collocations (up to SHORT_ENTRY_MAX_CHARS) get every
    voice, so autoplay rotates the voice on repeat. Long entries — example
    sentences, definitions, and story sentences — get only the sentence
    voice(s), since they are much larger and rotation on a whole sentence is
    barely audible.

    The sentence voice comes from sentence_voices when given (a
    "# sentence_voice:" header, or SENTENCE_VOICES), and only then falls
    back to voices[:LONG_ENTRY_VOICES]. That fallback is the historical
    behaviour and it couples every sentence to the first word voice, so
    changing the word voice selection re-synthesises all of them.
    """
    if len(entry) <= SHORT_ENTRY_MAX_CHARS:
        return voices
    if sentence_voices:
        return list(sentence_voices)
    return voices[:max(1, LONG_ENTRY_VOICES)]


def collect_missing(words, voices, existing, sentence_voices=None):
    """Return the list of (word, voice) pairs not present in `existing`."""
    missing = []
    for w in words:
        for v in voices_for(w, voices, sentence_voices):
            if (w, v) not in existing:
                missing.append((w, v))
    return missing


def synthesize_many(missing, api_key, model, new_gen):
    """Synthesise a batch of (word, voice) pairs with a small thread pool.

    Returns (clips_by_key, aborted). Never raises out of a worker: a
    SystemExit escaping a thread once skipped the pack write entirely and lost
    thousands of paid-for clips, so failures are counted, not thrown.
    """
    got              = {}
    done             = 0
    consecutive_fail = 0
    pool    = concurrent.futures.ThreadPoolExecutor(MAX_WORKERS)
    futures = {pool.submit(synthesize, w, v, api_key, model): (w, v)
               for w, v in missing}
    try:
        for fut in concurrent.futures.as_completed(futures):
            w, v = futures[fut]
            try:
                audio = fut.result()
            except Exception as exc:            # one clip must not kill the run
                audio = None
                print("  ! error on '%s' [%s]: %s" % (w, v, exc))
            done += 1
            if audio:
                got[(w, v)] = audio
                consecutive_fail = 0
            else:
                consecutive_fail += 1
                # A long unbroken run of failures means the API is
                # systematically rejecting requests (rate or quota wall).
                # Stop now and save, rather than burning an hour.
                if consecutive_fail >= ABORT_AFTER_FAILS:
                    _signal_abort("%d clip(s) failed in a row - the API is "
                                  "rejecting requests (rate-limit or "
                                  "quota/billing limit)" % consecutive_fail)
            if done % 25 == 0 or done == len(missing):
                print("      progress %d/%d  (%d ok)"
                      % (done, len(missing), len(got)))
            if _past_deadline():
                _budget_hit()
            if _abort.is_set():
                print("      ! stopping early - %s" % _abort_reason[0])
                break
    finally:
        # cancel_futures drops not-yet-started work, so an aborted run ends in
        # seconds instead of grinding through thousands of doomed retries (an
        # earlier run wasted ~50 minutes doing exactly that).
        pool.shutdown(wait=True, cancel_futures=True)
        # Breaking out of as_completed leaves behind futures that had already
        # finished but whose results were never read. That audio is bought and
        # paid for, so it is harvested here rather than thrown away — with
        # four workers, stopping on a budget used to discard up to three
        # finished clips every time.
        for fut, key in futures.items():
            if key in got or not fut.done() or fut.cancelled():
                continue
            try:
                audio = fut.result(timeout=0)
            except Exception:
                audio = None
            if audio:
                got[key] = audio
                print("      harvested a clip that finished during shutdown: "
                      "%s [%s]" % key)
    return got, _abort.is_set()


def run_build(dry_run=False, limit=0, cli_range=None, prune_voices=False):
    """Full build pipeline, one part at a time.

    The unit of work is a part, not the whole pack. For each part this run
    decides from the published manifest alone whether its clip set changed;
    an unchanged part is neither downloaded, rebuilt, nor re-uploaded, and its
    published asset simply stays where it is. So a run that adds twenty words
    moves one part instead of 1.4 GB, which is also what keeps a full build
    inside its time budget.
    """
    _budget_start()

    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    model   = os.environ.get("OPENAI_TTS_MODEL", DEFAULT_MODEL).strip() \
              or DEFAULT_MODEL
    repo    = os.environ.get("GITHUB_REPOSITORY", "").strip()
    token   = os.environ.get("GITHUB_TOKEN", "").strip()
    tag     = os.environ.get("PACK_RELEASE_TAG", "audio-pack").strip() \
              or "audio-pack"

    blocks  = read_wordlist(WORDLIST)
    cfg     = read_pack_config(WORDLIST)
    voices  = cfg.get("voices") or VOICES
    svoices = cfg.get("sentence_voices") or SENTENCE_VOICES
    stride  = int(cfg.get("part_blocks") or PART_BLOCK_STRIDE)

    # The client looks a clip up by iterating manifest["voices"], so a
    # sentence voice missing from that list would be invisible to the app even
    # though its bytes are in the pack. The manifest carries the union, while
    # `voices` stays the word-voice list the policy uses.
    manifest_voices = list(voices) + [v for v in svoices if v not in voices]

    if prune_voices or cfg.get("prune_voices"):
        prune_voices = True

    idx_lo = min((b["index"] for b in blocks), default=0)
    idx_hi = max((b["index"] for b in blocks), default=0)
    total_entries = len(entry_blocks(blocks))
    print("[words] %d block(s), index %d..%d, %d unique entr(ies) in %s"
          % (len(blocks), idx_lo, idx_hi, total_entries, WORDLIST))
    print("[voices] %s  (%s)" % (", ".join(voices),
          "from word list" if cfg.get("voices") else "default"))
    print("[voices] sentences: %s  (%s)"
          % (", ".join(voices_for("x" * (SHORT_ENTRY_MAX_CHARS + 1),
                                  voices, svoices)),
             "pinned by word list" if cfg.get("sentence_voices")
             else "pinned in source" if SENTENCE_VOICES
             else "UNPINNED - follows the first word voice"))
    if TIME_BUDGET_MINUTES > 0:
        print("[budget] %g minute(s); the run stops itself and publishes "
              "what it has" % TIME_BUDGET_MINUTES)
    else:
        print("[budget] none set (TIME_BUDGET_MINUTES); a runner timeout "
              "would lose this run's work")

    # --- Plan -----------------------------------------------------------
    planned = plan_parts(blocks, voices, svoices, stride)
    print("[parts] %d part(s) of up to %d block(s) each"
          % (len(planned), stride))

    # A range restricts which parts this run may touch. It is a pacing tool
    # only: an unselected part keeps its published asset untouched, so a
    # range build can never delete another range's audio.
    sel_range = cli_range or cfg.get("range")

    assets    = release_assets(repo, tag, token)
    prev_man  = read_previous_manifest(assets, token)
    prev_ver  = (prev_man or {}).get("version", 0)
    prev_gen  = (prev_man or {}).get("generation", 0)
    prev_part = {p["name"]: p for p in (prev_man or {}).get("parts", [])}

    # Coming from the pre-split pack: load it once as prior state, then split
    # it. Nothing is synthesised on that run, it is purely a re-shape.
    legacy_clips = {}
    if prev_ver != 2:
        _, legacy_clips = load_monolith(assets, token)
        if legacy_clips:
            prev_gen = max(prev_gen, 1)
        elif prev_man:
            print("[prev] manifest is v%s with no parts and no single-file "
                  "pack; treating as a first run" % prev_ver)

    # --- Decide what each part needs ------------------------------------
    to_build = []          # (span, keys) that must be rebuilt
    reused   = []          # previous part records carried over untouched
    for span, keys in planned:
        name = part_name(span)
        want = keys_hash(keys)
        prev = prev_part.get(name)
        in_range = (not sel_range
                    or not (span[1] < sel_range[0] or span[0] > sel_range[1]))
        if prev and prev.get("keysSha256") == want:
            reused.append(prev)
        elif not in_range:
            # Out of the selected range: leave the published part exactly as
            # it is. Dropping it from the manifest would orphan its audio.
            if prev:
                reused.append(prev)
        else:
            to_build.append((span, keys))

    # Brand-new parts first, parts that merely changed after. A run that
    # stops on its time budget then leaves the NEW material finished rather
    # than untouched: story blocks sort last by index, so under the plain
    # index order a run that also had to re-synthesise existing entries would
    # spend its whole budget on them and never reach the new stories - which
    # are exactly what the user is waiting to hear.
    to_build.sort(key=lambda t: (part_name(t[0]) in prev_part, t[0]))
    fresh_n = sum(1 for sp, _ in to_build if part_name(sp) not in prev_part)

    print("[plan] %d part(s) unchanged, %d to build (%d new, %d changed)"
          % (len(reused), len(to_build), fresh_n, len(to_build) - fresh_n))
    if sel_range:
        print("[range] limited to block %d..%d" % sel_range)

    if dry_run:
        for span, keys in to_build:
            prev  = prev_part.get(part_name(span))
            known = set()
            if prev:
                print("  would rebuild %s  (%d desired clip(s), was %d)"
                      % (part_name(span), len(keys), prev.get("clipCount", 0)))
            else:
                print("  would create  %s  (%d clip(s))"
                      % (part_name(span), len(keys)))
        chars = sum(len(w) for span, keys in to_build for w, _ in keys)
        print("[dry-run] %d part(s), up to %d clip(s), %d input character(s); "
              "no API calls and no downloads made"
              % (len(to_build), sum(len(k) for _, k in to_build), chars))
        return

    if to_build and not api_key and not legacy_clips:
        raise SystemExit("OPENAI_API_KEY is not set; cannot synthesise. "
                         "Use --dry-run to preview without it.")

    # --- Build the parts that changed -----------------------------------
    # dist/ is a build output directory, and the workflow publishes
    # tools/dist/*.empack by glob. Anything left there from an older build (or
    # committed to the repo by accident) would be uploaded as though this run
    # had produced it, so the slate is wiped first.
    os.makedirs(DIST_DIR, exist_ok=True)
    for stale in sorted(os.listdir(DIST_DIR)):
        if stale.endswith(".empack") or stale == "keep-assets.txt":
            os.remove(os.path.join(DIST_DIR, stale))
            print("[dist] cleared stale %s" % stale)
    new_gen   = prev_gen + 1
    aborted   = False
    written   = []
    synth_tot = 0

    for span, keys in to_build:
        name = part_name(span)
        want = set(keys)

        # Prior clips for this part: from its published predecessor, or from
        # the pre-split pack on the migration run.
        have = {}
        if legacy_clips:
            have = {k: v for k, v in legacy_clips.items() if k in want}
        elif prev_part.get(name):
            print("  [%s] fetching the published part as state" % name)
            try:
                have = {k: v for k, v in load_part(assets, token, name).items()
                        if k in want}
            except Exception as e:
                print("  ! could not read %s (%s); rebuilding it from scratch"
                      % (name, e))
                have = {}

        # A clip whose voice is no longer used for its entry is dead weight.
        # Because a part is rebuilt from `want`, that pruning happens for free
        # here; the flag only controls whether it is announced as a saving.
        missing = [k for k in keys if k not in have]
        if prune_voices:
            dropped = len(have) + len(missing) - len(want)
            if dropped > 0:
                print("  [%s] %d clip(s) for de-selected voices dropped"
                      % (name, dropped))

        if _past_deadline():
            _budget_hit()
        if _abort.is_set():
            # Starting a part means downloading it first, so there is no
            # point beginning one with no time left to synthesise into it.
            print("  [%s] skipped - %s" % (name, _abort_reason[0]))
            if prev_part.get(name):
                reused.append(prev_part[name])
            continue

        if missing:
            capped = missing
            if limit:
                seen_w = set()
                capped = []
                for w, v in missing:
                    if w not in seen_w:
                        if len(seen_w) >= limit:
                            break
                        seen_w.add(w)
                    capped.append((w, v))
                if len(capped) < len(missing):
                    print("  [%s] limit %d word(s): %d clip(s) deferred"
                          % (name, limit, len(missing) - len(capped)))
            print("  [%s] synthesising %d clip(s) at generation %d"
                  % (name, len(capped), new_gen))
            got, aborted = synthesize_many(capped, api_key, model, new_gen)
            synth_tot += len(got)
            for k, audio in got.items():
                have[k] = {"audio": audio, "gen": new_gen}

        clips = [{"word": w, "voice": v,
                  "gen": have[(w, v)]["gen"], "audio": have[(w, v)]["audio"]}
                 for (w, v) in keys if (w, v) in have]
        if not clips:
            print("  [%s] nothing to write" % name)
            continue

        # stamp=False: the bytes must depend only on the clips, or the sha256
        # would change on every run and the client would re-download
        # everything. keysSha256 records what was ACTUALLY written, so a part
        # left incomplete by the budget comes back as "changed" next run.
        part_bytes, _ = build_pack(clips, stamp=False, part=span)
        open(os.path.join(DIST_DIR, name), "wb").write(part_bytes)
        rec = {
            "name"      : name,
            "from"      : span[0],
            "to"        : span[1],
            "bytes"     : len(part_bytes),
            "sha256"    : sha256_hex(part_bytes),
            "clipCount" : len(clips),
            "keysSha256": keys_hash([(c["word"], c["voice"]) for c in clips]),
        }
        written.append(rec)
        short = "complete" if len(clips) == len(keys) \
                else "%d/%d clip(s) - will be finished next run" \
                     % (len(clips), len(keys))
        print("  [%s] %.1f MB, %s" % (name, len(part_bytes) / (1024 * 1024),
                                      short))
        if aborted:
            break

    # Parts skipped after an abort keep their published asset.
    if aborted:
        built = set(r["name"] for r in written)
        for span, keys in to_build:
            n = part_name(span)
            if n not in built and prev_part.get(n) \
                    and prev_part[n] not in reused:
                reused.append(prev_part[n])

    # --- Manifest -------------------------------------------------------
    parts = sorted(reused + written, key=lambda r: (r["from"], r["name"]))
    if not parts:
        raise SystemExit("no parts to write; the word list may be empty")

    if synth_tot == 0:
        new_gen = max(prev_gen, 1)

    manifest = {
        "format"    : "empack",
        "version"   : 2,
        "generation": new_gen,
        "createdAt" : (datetime.datetime.now(datetime.timezone.utc)
                       .strftime("%Y-%m-%dT%H:%M:%SZ")),
        "model"     : model,
        "voices"    : manifest_voices,
        "partBlocks": stride,
        "partCount" : len(parts),
        "clipCount" : sum(p["clipCount"] for p in parts),
        "parts"     : parts,
    }
    open(os.path.join(DIST_DIR, MANIFEST_NAME), "w", encoding="utf-8").write(
        json.dumps(manifest, ensure_ascii=False, indent=2))

    # The set of asset names that should exist after publishing. The workflow
    # deletes every other pack asset on the release, which is how parts for
    # deleted words, and the pre-split pack itself, get cleaned up.
    keep = [MANIFEST_NAME] + [p["name"] for p in parts]
    open(os.path.join(DIST_DIR, "keep-assets.txt"), "w",
         encoding="utf-8").write("\n".join(keep) + "\n")

    total_mb = sum(p["bytes"] for p in parts) / (1024 * 1024)
    print("[write] %d part(s), %d clip(s), %.1f MB total, generation %d"
          % (len(parts), manifest["clipCount"], total_mb, new_gen))
    print("[write] %d part file(s) in %s; %d unchanged part(s) stay published "
          "as they are" % (len(written), DIST_DIR, len(reused)))
    print("[write] %s" % MANIFEST_NAME)
    print("[done]  %d clip(s) synthesised this run" % synth_tot)

    if aborted:
        budget_stop = "time budget" in _abort_reason[0]
        if budget_stop:
            advice = (
                "  This is the planned checkpoint, not an error. Re-run the "
                "workflow to\n"
                "  continue: the next run reads the manifest, sees which "
                "parts are still\n"
                "  incomplete, and synthesises only those. Nothing is paid "
                "for twice.\n"
                "  Expect several re-runs on a first full build.")
        else:
            advice = (
                "  Most likely cause: the OpenAI account hit its usage / "
                "billing limit.\n"
                "  Check platform.openai.com -> Settings -> Limits and add "
                "credit or raise\n"
                "  the limit, then re-run. Parts already written are "
                "published and will\n"
                "  not be rebuilt.")
        raise SystemExit(
            "\n[INCOMPLETE] synthesis stopped early:\n"
            "  %s\n\n"
            "  %d part(s) were still written and will be published, so "
            "nothing already\n"
            "  generated is lost.\n\n"
            "%s" % (_abort_reason[0], len(written), advice))


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

    # --- v101: voice policy -------------------------------------------
    word = "manifest"
    sent = "his impatience began to manifest itself by july."
    assert len(word) <= SHORT_ENTRY_MAX_CHARS, "test word must be short"
    assert len(sent)  >  SHORT_ENTRY_MAX_CHARS, "test sentence must be long"

    vs = ["alloy", "ash", "nova"]
    assert voices_for(word, vs) == vs, "a short entry uses every voice"
    assert voices_for(sent, vs) == ["alloy"], \
        "unpinned, a long entry follows the FIRST word voice"
    # The bug this guards: dropping the alphabetically-first voice moves
    # every sentence to the next one and re-synthesises all of them.
    assert voices_for(sent, ["ash", "nova"]) == ["ash"], \
        "unpinned, de-selecting alloy moves every sentence to ash"
    assert voices_for(sent, ["ash", "nova"], ["nova"]) == ["nova"], \
        "pinned, the sentence voice ignores the word voice list"
    assert voices_for(sent, vs, ["nova"]) == ["nova"], \
        "pinned, and stays put when the word list changes"
    assert voices_for(word, vs, ["nova"]) == vs, \
        "pinning sentences must not touch short entries"

    # collect_missing must ask for the pinned voice, not the first word voice
    miss = collect_missing([word, sent], vs, {}, ["nova"])
    assert (sent, "nova") in miss, "the sentence is requested in nova"
    assert (sent, "alloy") not in miss, "and not in the first word voice"
    assert len([m for m in miss if m[0] == word]) == len(vs), \
        "the word is still requested in every voice"

    # --- v101: config headers -----------------------------------------
    import tempfile
    tmp = os.path.join(tempfile.mkdtemp(), "wordlist.txt")
    open(tmp, "w", encoding="utf-8").write(
        "# voices: nova, fable\n"
        "# sentence_voice: shimmer\n"
        "# prune_voices: on\n"
        "#@1 manifest\nmanifest\n")
    cfg = read_pack_config(tmp)
    assert cfg["voices"] == ["nova", "fable"], "voices header"
    assert cfg["sentence_voices"] == ["shimmer"], "sentence_voice header"
    assert cfg["prune_voices"] is True, "prune_voices header"

    # --- v101: time budget --------------------------------------------
    _abort.clear()
    _abort_reason[0] = ""
    _deadline[0] = 0.0
    assert not _past_deadline(), "no budget means no deadline"
    _deadline[0] = time.monotonic() - 1          # already spent
    assert _past_deadline(), "a spent budget is past its deadline"
    assert synthesize(word, "nova", "sk-not-used", "test-model") is None, \
        "a worker must not start a clip past the deadline"
    assert _abort.is_set(), "and it raises the abort flag"
    assert "time budget" in _abort_reason[0], \
        "the reason must say time budget so the log gives re-run advice"
    _abort.clear()
    _abort_reason[0] = ""
    _deadline[0] = 0.0

    # --- v102: split packs --------------------------------------------
    # Which part owns a block must be pure index arithmetic, or a size-greedy
    # split would cascade and one edit would re-download the whole pack.
    assert part_span(1, 80)     == (1, 80),        "block 1 -> first part"
    assert part_span(80, 80)    == (1, 80),        "block 80 -> first part"
    assert part_span(81, 80)    == (81, 160),      "block 81 -> second part"
    assert part_span(10001, 80) == (10001, 10080), "story blocks get their own"
    assert part_name((81, 160)) == \
        "empro-audio-pack.p00081-00160.empack", "part naming"

    # Growth must not move existing blocks between parts.
    for b in (1, 5, 80, 81, 562):
        assert part_span(b, 80) == part_span(b, 80), "span is deterministic"
    assert part_span(562, 80) == (561, 640), "the tail block sits in one part"
    assert part_span(563, 80) == (561, 640), \
        "adding word 563 lands in the SAME part - no other part is touched"

    # Determinism of the bytes. stamp=False must remove every trace of when
    # the run happened, or every part's sha256 would change on every build.
    pclips = [{"word": "manifest", "voice": "nova", "gen": 1, "audio": b"\x01\x02"},
              {"word": "testbed",  "voice": "nova", "gen": 3, "audio": b"\x03"}]
    a, _ = build_pack(pclips, stamp=False, part=(1, 80))
    time.sleep(1.05)                       # a different wall-clock second
    b_, _ = build_pack(list(reversed(pclips)), stamp=False, part=(1, 80))
    assert a == b_, "part bytes must not depend on clip order or on the clock"
    assert sha256_hex(a) == sha256_hex(b_), "so the sha256 is stable"
    stamped, _ = build_pack(pclips, voices=["nova"], generation=7,
                            model="m", stamp=True)
    assert stamped != a, "a stamped pack differs from a deterministic part"
    pm, pc = parse_pack(a)
    assert pm["part"] == [1, 80],  "the part carries its own block range"
    assert "createdAt" not in pm,  "and no timestamp"
    assert "generation" not in pm, "and no generation"
    assert pc[("testbed", "nova")]["gen"] == 3, \
        "per-clip gen survives, so delta accounting still works"

    # keysSha256 must describe what was written, not what was wanted.
    full = keys_hash([("a", "nova"), ("b", "nova")])
    half = keys_hash([("a", "nova")])
    assert full != half, \
        "an incomplete part must hash differently, or its gaps are never filled"
    assert keys_hash([("b", "nova"), ("a", "nova")]) == full, \
        "the hash is order-independent"

    # plan_parts groups desired keys by part, with the voice policy applied.
    blocks = [{"index": 1,     "entries": ["manifest", "x" * 60]},
              {"index": 81,    "entries": ["testbed"]},
              {"index": 10001, "entries": ["a story sentence that is long." * 2]}]
    plan = plan_parts(blocks, ["alloy", "nova"], ["shimmer"], 80)
    spans = [sp for sp, _ in plan]
    assert spans == [(1, 80), (81, 160), (10001, 10080)], "one part per span"
    first = dict.fromkeys(plan[0][1])
    assert ("manifest", "alloy") in first and ("manifest", "nova") in first, \
        "a short entry is wanted in every word voice"
    assert ("x" * 60, "shimmer") in first, \
        "a long entry is wanted in the pinned sentence voice"
    assert ("x" * 60, "alloy") not in first, "and not in the word voices"

    print("[selftest] OK - %d clips round-tripped, %d-byte pack, voice policy "
          "+ budget + split-pack determinism checked" % (len(fake), len(pack)))


# --- Extract (listen to clips) -------------------------------------------

def run_extract():
    """Unpack the built pack into individual MP3 files so the clips can be
    played and checked. Writes one MP3 per clip into tools/dist/clips/, named
    word__voice.mp3.

    Reads every part in dist/, and falls back to the pre-split single file, so
    it works whichever kind of pack the last build left behind.
    """
    sources = sorted(f for f in os.listdir(DIST_DIR)
                     if f.endswith(".empack")) if os.path.isdir(DIST_DIR) else []
    if not sources:
        raise SystemExit("no .empack file in %s; run a build first" % DIST_DIR)

    clips = {}
    for name in sources:
        raw = open(os.path.join(DIST_DIR, name), "rb").read()
        _, part_clips = parse_pack(raw)
        clips.update(part_clips)
        print("[extract] read %s (%d clip(s))" % (name, len(part_clips)))

    out_dir = os.path.join(DIST_DIR, "clips")
    os.makedirs(out_dir, exist_ok=True)
    for (word, voice), info in sorted(clips.items()):
        safe = "".join(ch if ch.isalnum() else "_" for ch in word)
        name = "%s__%s.mp3" % (safe, voice)
        open(os.path.join(out_dir, name), "wb").write(info["audio"])

    print("[extract] wrote %d MP3 file(s) to %s" % (len(clips), out_dir))
    print("[extract] open that folder and play a few to check the audio")


# --- Entry point ---------------------------------------------------------

_args = sys.argv[1:]


def _opt_value(flag):
    """Value following a CLI flag, or None if the flag is absent/last."""
    if flag in _args:
        i = _args.index(flag)
        if i + 1 < len(_args):
            return _args[i + 1]
    return None


def _parse_range_arg(spec):
    """Parse a --range value like '51-100' (or '51 100', '51..100')."""
    if not spec:
        return None
    nums = []
    for tok in str(spec).replace("..", " ").replace("-", " ") \
                   .replace(",", " ").split():
        if tok.isdigit():
            nums.append(int(tok))
    if len(nums) < 2:
        return None
    lo, hi = nums[0], nums[1]
    if lo > hi:
        lo, hi = hi, lo
    return (max(1, lo), hi)


# Guarded so the module can be imported by a test without building anything.
# Before this, `import generate_audio_pack` started a real build against the
# real word list, which made the split-pack behaviour impossible to test.
def main():
    if "--selftest" in _args:
        run_selftest()
    elif "--extract" in _args:
        run_extract()
    else:
        _limit = int(_opt_value("--limit") or 0)
        _range = _parse_range_arg(_opt_value("--range"))
        run_build(dry_run=("--dry-run" in _args), limit=_limit,
                  cli_range=_range,
                  prune_voices=("--prune-voices" in _args))


if __name__ == "__main__":
    main()
