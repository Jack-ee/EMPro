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
  empro-audio-pack.partNN.empack   part files (part01, part02, ...), each a
                                   complete EMPACK1 file holding a slice of
                                   the clips, cut along word-block boundaries
                                   at roughly PART_MAX_MB per part
  empro-audio-pack.manifest.json   top-level manifest (version 2): global
                                   generation plus, for every part, its name,
                                   clip count, byte size and sha256

Parts are cut in word-index order, so appending new words to the list only
changes the LAST part (or adds a new one). A part's bytes depend only on the
clips inside it - its embedded manifest carries no timestamp and no global
generation - so an untouched part is byte-identical across runs and keeps
the same sha256. The app compares each part's sha256 against what it has
already imported and downloads only the parts that changed, so a new batch
of vocabulary costs one small part download, not the whole pack again.

The old single empro-audio-pack.empack full pack and the .delta pack are no
longer produced; the workflow deletes their stale release assets.

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

# Delivery guidance passed to gpt-4o-mini-tts. The list now contains
# words, collocations, example sentences and definitions, so the prompt
# is phrased to suit any of them: a clear, learner-paced model reading.
TTS_INSTRUCTIONS = (
    "Read the following English text clearly and at a natural, unhurried "
    "pace, as a model for an English learner. Use a standard accent."
)

MAGIC          = b"EMPACK1\x00"           # 8 bytes, fixed
PACK_VERSION   = 1
OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech"
DEFAULT_MODEL  = "gpt-4o-mini-tts"

# Paths are resolved next to this script. It works whether the script sits
# in tools/ (the intended layout) or anywhere else, as long as wordlist.txt
# is in the same folder. The dist/ output folder is created beside it too.
SCRIPT_DIR    = os.path.dirname(os.path.abspath(__file__))
WORDLIST      = os.path.join(SCRIPT_DIR, "wordlist.txt")
DIST_DIR      = os.path.join(SCRIPT_DIR, "dist")
FULL_NAME     = "empro-audio-pack.empack"        # legacy single pack (state only)
DELTA_NAME    = "empro-audio-pack.delta.empack"  # legacy delta (state only)
MANIFEST_NAME = "empro-audio-pack.manifest.json"
PART_PREFIX   = "empro-audio-pack.part"
PART_SUFFIX   = ".empack"

# Size cap per part, in MB of audio payload. Parts are cut along word-block
# boundaries, so a part can run slightly over the cap to keep a block whole.
# Override per build with a "# part-size: N" header in the word list.
PART_MAX_MB   = 200

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
      part-size  size cap per output part in MB (default PART_MAX_MB)
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
        elif low.startswith("part-size:") or low.startswith("partsize:"):
            try:
                n = int(body.split(":", 1)[1].strip())
                if n > 0:
                    cfg["part_mb"] = n
            except ValueError:
                pass
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

def build_pack(clips, voices, generation, model, stamp=True):
    """Build a .empack byte string from a list of clip dicts.

    Each clip dict carries word, voice, gen, audio (bytes). Returns the tuple
    (pack_bytes, manifest_dict) so the caller can also emit the manifest alone.
    With stamp=False the createdAt field is omitted; part files are built this
    way so that a part whose clips did not change is byte-identical across
    runs and keeps a stable sha256 (the download-skip test on the client).
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
        "model"    : model,
        "voices"   : list(voices),
        "clipCount": len(entries),
        "clips"    : entries,
    }
    if stamp:
        manifest["createdAt"] = datetime.datetime.now(datetime.timezone.utc) \
                                        .strftime("%Y-%m-%dT%H:%M:%SZ")
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


def _is_pack_asset(name):
    """True for assets holding clip audio to reuse as incremental state:
    the part files, or the legacy single full pack (so the first parts
    build migrates seamlessly from the old layout). The legacy delta is
    excluded - it is a subset of the full pack."""
    if name == FULL_NAME:
        return True
    return name.startswith(PART_PREFIX) and name.endswith(PART_SUFFIX)


def download_previous_pack(repo, tag, token):
    """Download prior clips from the GitHub Release, if one exists.

    Reads every part asset (and/or the legacy full pack) and merges them.
    Returns (generation, clips_by_key), with generation 0 and {} when there
    is no prior release. The previous clips are the only incremental state
    the build needs.
    """
    if not repo:
        print("[prev] no GITHUB_REPOSITORY set; treating this as a first run")
        return 0, {}
    try:
        rel_json = _api_get(
            "https://api.github.com/repos/%s/releases/tags/%s" % (repo, tag),
            token, "application/vnd.github+json")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print("[prev] no '%s' release yet; first run" % tag)
            return 0, {}
        raise
    except urllib.error.URLError as e:
        print("[prev] could not reach GitHub API (%s); first run" % e)
        return 0, {}

    release = json.loads(rel_json)
    assets  = [a for a in release.get("assets", [])
               if _is_pack_asset(a["name"])]
    if not assets:
        print("[prev] release exists but has no pack assets; first run")
        return 0, {}

    prev_gen = 0
    clips    = {}
    for asset in sorted(assets, key=lambda a: a["name"]):
        raw = _api_get(asset["url"], token, "application/octet-stream")
        manifest, part_clips = parse_pack(raw)
        for key, info in part_clips.items():
            clips[key] = info
            prev_gen   = max(prev_gen, info.get("gen", 1))
        print("[prev] %s: %d clip(s)" % (asset["name"], len(part_clips)))
    print("[prev] loaded %d clip(s) total, generation %d" % (len(clips), prev_gen))
    return prev_gen, clips


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


def _signal_abort(reason):
    """Record the first fatal reason and raise the shared abort flag."""
    if not _abort.is_set():
        _abort_reason[0] = reason
        _abort.set()


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

def voices_for(entry, voices):
    """Voices to synthesise for one word-list entry.

    Words and short collocations (up to SHORT_ENTRY_MAX_CHARS) get every
    voice, so autoplay rotates the voice on repeat. Long entries — example
    sentences and definitions — get only LONG_ENTRY_VOICES voice(s), since
    they are much larger and rotation on a whole sentence is barely
    audible. See the constants near the top of the file to tune this.
    """
    if len(entry) <= SHORT_ENTRY_MAX_CHARS:
        return voices
    return voices[:max(1, LONG_ENTRY_VOICES)]


def collect_missing(words, voices, existing):
    """Return the list of (word, voice) pairs not present in `existing`."""
    missing = []
    for w in words:
        for v in voices_for(w, voices):
            if (w, v) not in existing:
                missing.append((w, v))
    return missing


def part_name(n):
    """File name of part n (1-based), e.g. empro-audio-pack.part03.empack."""
    return "%s%02d%s" % (PART_PREFIX, n, PART_SUFFIX)


def split_parts(blocks, clips_by_key, part_max_bytes):
    """Assign clips to size-capped parts along word-block boundaries.

    Blocks are taken in ascending index order and never split, so a part can
    slightly exceed the cap to keep a block's clips together. Because parts
    fill front to back, appending new words to the list only changes the
    last part (or adds one); earlier parts keep identical content and hash.
    Clips whose word is in no block (defensive; pruning should prevent it)
    go into the final part. Returns a list of clip-dict lists, empty parts
    removed.
    """
    by_word = {}
    for (w, v), info in clips_by_key.items():
        by_word.setdefault(w, []).append(
            {"word": w, "voice": v, "gen": info["gen"], "audio": info["audio"]})

    parts     = []
    current   = []
    cur_bytes = 0
    assigned  = set()

    def close():
        nonlocal current, cur_bytes
        if current:
            parts.append(current)
            current   = []
            cur_bytes = 0

    for b in sorted(blocks, key=lambda b: b["index"]):
        block_clips = []
        block_bytes = 0
        for e in b["entries"]:
            if e in assigned:
                continue
            assigned.add(e)
            for c in sorted(by_word.get(e, []), key=lambda c: c["voice"]):
                block_clips.append(c)
                block_bytes += len(c["audio"])
        if not block_clips:
            continue
        if current and cur_bytes + block_bytes > part_max_bytes:
            close()
        current.extend(block_clips)
        cur_bytes += block_bytes

    leftovers = [c for w, cs in sorted(by_word.items()) for c in cs
                 if w not in assigned]
    current.extend(leftovers)
    close()
    return parts


def run_build(dry_run=False, limit=0, cli_range=None):
    """Full build pipeline. Reads the word list, fills gaps, writes packs."""
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    model   = os.environ.get("OPENAI_TTS_MODEL", DEFAULT_MODEL).strip() \
              or DEFAULT_MODEL
    repo    = os.environ.get("GITHUB_REPOSITORY", "").strip()
    token   = os.environ.get("GITHUB_TOKEN", "").strip()
    tag     = os.environ.get("PACK_RELEASE_TAG", "audio-pack").strip() \
              or "audio-pack"

    blocks = read_wordlist(WORDLIST)
    cfg    = read_pack_config(WORDLIST)
    voices = cfg.get("voices") or VOICES

    # Every entry across all blocks. Used for PRUNING, so a range build
    # never deletes audio for words outside the current range.
    all_entries = []
    seen_all    = set()
    for b in blocks:
        for e in b["entries"]:
            if e not in seen_all:
                seen_all.add(e)
                all_entries.append(e)

    # Selected build set. An explicit range (the --range CLI flag, else
    # the "# range:" header) restricts the build to those word indices;
    # otherwise every block is built.
    sel_range = cli_range or cfg.get("range")
    if sel_range:
        lo, hi     = sel_range
        sel_blocks = [b for b in blocks if lo <= b["index"] <= hi]
    else:
        sel_blocks = blocks

    build_entries = []
    seen_build    = set()
    for b in sel_blocks:
        for e in b["entries"]:
            if e not in seen_build:
                seen_build.add(e)
                build_entries.append(e)

    idx_lo = min((b["index"] for b in blocks), default=0)
    idx_hi = max((b["index"] for b in blocks), default=0)
    print("[words] %d block(s), index %d..%d, %d unique entr(ies) in %s"
          % (len(blocks), idx_lo, idx_hi, len(all_entries), WORDLIST))
    print("[voices] %s  (%s)" % (", ".join(voices),
          "from word list" if cfg.get("voices") else "default"))
    if sel_range:
        print("[range] building word index %d..%d  ->  %d block(s), "
              "%d entr(ies)"
              % (sel_range[0], sel_range[1],
                 len(sel_blocks), len(build_entries)))

    prev_gen, existing = download_previous_pack(repo, tag, token)

    # Drop clips for entries no longer anywhere in the list. This uses the
    # FULL entry set, never the range, so building one range cannot delete
    # another range's audio.
    allset  = set(all_entries)
    kept    = {k: v for k, v in existing.items() if k[0] in allset}
    dropped = len(existing) - len(kept)
    if dropped:
        print("[prune] dropped %d clip(s) for entries removed from the list"
              % dropped)

    missing = collect_missing(build_entries, voices, kept)
    print("[plan] %d clip(s) already cached, %d to synthesise"
          % (len(kept), len(missing)))

    # The --limit / "# limit:" cap still works, but only when no range is
    # in effect — a range is already an explicit, deterministic selection,
    # so capping it further would be confusing. The cap counts whole
    # words: a word's clips stay together, never split across two runs.
    eff_limit = 0 if sel_range else (limit or cfg.get("limit", 0))
    if eff_limit:
        seen_w = set()
        capped = []
        for w, v in missing:
            if w not in seen_w:
                if len(seen_w) >= eff_limit:
                    break
                seen_w.add(w)
            capped.append((w, v))
        if len(capped) < len(missing):
            total_w = len(set(w for w, _ in missing))
            print("[plan] limit %d word(s) applied; %d word(s) and %d "
                  "clip(s) deferred to a later run"
                  % (eff_limit, total_w - len(seen_w),
                     len(missing) - len(capped)))
            missing = capped

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
    aborted   = False
    if missing:
        print("[synth] generating %d clip(s) at generation %d ..."
              % (len(missing), new_gen))
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
                except Exception as exc:        # never let one clip kill the run
                    audio = None
                    print("  ! error on '%s' [%s]: %s" % (w, v, exc))
                done += 1
                if audio:
                    new_clips[(w, v)] = audio
                    consecutive_fail = 0
                else:
                    consecutive_fail += 1
                    # A long unbroken run of failures means the API is
                    # systematically rejecting requests (rate or quota
                    # wall). Stop now and save, rather than burning an hour.
                    if consecutive_fail >= ABORT_AFTER_FAILS:
                        _signal_abort("%d clip(s) failed in a row - the API "
                                      "is rejecting requests (rate-limit or "
                                      "quota/billing limit)" % consecutive_fail)
                if done % 25 == 0 or done == len(missing):
                    print("  progress %d/%d  (%d ok)"
                          % (done, len(missing), len(new_clips)))
                if _abort.is_set():
                    aborted = True
                    print("  ! stopping early - %s" % _abort_reason[0])
                    break
        finally:
            # cancel_futures drops not-yet-started work, so an aborted run
            # ends in seconds instead of grinding through thousands of
            # doomed retries (an earlier run wasted ~50 minutes doing that).
            pool.shutdown(wait=True, cancel_futures=True)
        print("[synth] %d clip(s) synthesised, %d not done this run"
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

    # Cut the clip set into size-capped parts along word-block boundaries.
    combined = {}
    for c in all_clips:
        combined[(c["word"], c["voice"])] = {"gen": c["gen"], "audio": c["audio"]}
    part_mb    = cfg.get("part_mb", PART_MAX_MB)
    part_lists = split_parts(blocks, combined, part_mb * 1024 * 1024)

    # Write every part. Each part is a self-contained EMPACK1 file whose
    # embedded manifest depends only on its clips (stamp=False, generation =
    # the highest clip gen inside), so an unchanged part is byte-identical
    # across runs and the client's sha256 comparison can skip it.
    part_infos  = []
    total_clips = 0
    for i, plist in enumerate(part_lists, start=1):
        part_gen        = max(c["gen"] for c in plist)
        pbytes, pm      = build_pack(plist, voices, part_gen, model, stamp=False)
        name            = part_name(i)
        open(os.path.join(DIST_DIR, name), "wb").write(pbytes)
        total_clips    += pm["clipCount"]
        part_infos.append({
            "name"     : name,
            "clipCount": pm["clipCount"],
            "size"     : len(pbytes),
            "sha256"   : hashlib.sha256(pbytes).hexdigest(),
        })
        print("[write] %s  (%d clip(s), %.2f MB)"
              % (name, pm["clipCount"], len(pbytes) / (1024 * 1024)))

    manifest = {
        "format"    : "empack",
        "version"   : 2,
        "generation": new_gen,
        "createdAt" : datetime.datetime.now(datetime.timezone.utc)
                              .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "model"     : model,
        "voices"    : list(voices),
        "clipCount" : total_clips,
        "partSizeMB": part_mb,
        "partCount" : len(part_infos),
        "parts"     : part_infos,
    }
    open(os.path.join(DIST_DIR, MANIFEST_NAME), "w", encoding="utf-8").write(
        json.dumps(manifest, ensure_ascii=False, indent=2))

    # Remove stale dist files: the legacy full/delta packs and any part
    # numbered beyond this run's count. The workflow mirrors this cleanup
    # on the release assets, so stale assets disappear from GitHub too.
    stale_names = [FULL_NAME, DELTA_NAME]
    n = len(part_infos)
    while True:
        n += 1
        candidate = part_name(n)
        if os.path.exists(os.path.join(DIST_DIR, candidate)):
            stale_names.append(candidate)
        else:
            break
    for s in stale_names:
        p = os.path.join(DIST_DIR, s)
        if os.path.exists(p):
            os.remove(p)
            print("[write] removed stale %s" % s)

    print("[write] %s  (top-level manifest, %d part(s), %d clip(s), "
          "generation %d)" % (MANIFEST_NAME, len(part_infos),
                              total_clips, new_gen))
    print("[done]  pack ready in %s" % DIST_DIR)

    if aborted:
        # The pack containing everything synthesised SO FAR has already
        # been written above and will be published by the workflow, so no
        # work from this run is lost. Exit non-zero so the run is correctly
        # marked failed and the operator knows to re-run; the next run
        # downloads this saved pack and continues from where it stopped.
        raise SystemExit(
            "\n[INCOMPLETE] synthesis stopped early:\n"
            "  %s\n\n"
            "  Good news: the partial pack (generation %d, %d clip(s)) was "
            "still written\n"
            "  and will be published, so nothing already generated is lost.\n\n"
            "  Most likely cause: the OpenAI account hit its usage / billing "
            "limit.\n"
            "  Check platform.openai.com -> Settings -> Limits and add credit "
            "or raise\n"
            "  the limit, then re-run. The next run continues from the %d "
            "saved clip(s)\n"
            "  and only synthesises what is still missing."
            % (_abort_reason[0], new_gen,
               manifest["clipCount"], manifest["clipCount"]))


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

    # Part splitting. Blocks in index order, a small cap forcing several
    # parts; verify the union round-trips, blocks never split, and that
    # appending a new block leaves every earlier part byte-identical
    # (the stable-sha256 property the client's download-skip relies on).
    blocks = [{"index": i + 1, "entries": [w]} for i, w in enumerate(words)]
    combined = {}
    for c in fake:
        combined[(c["word"], c["voice"])] = {"gen": c["gen"], "audio": c["audio"]}

    cap        = 30000                      # bytes; forces multiple parts
    part_lists = split_parts(blocks, combined, cap)
    assert len(part_lists) > 1, "expected the small cap to force >1 part"

    def part_bytes(plist):
        gen = max(c["gen"] for c in plist)
        return build_pack(plist, VOICES, gen, "test-model", stamp=False)[0]

    seen_keys = set()
    for plist in part_lists:
        raw            = part_bytes(plist)
        pm, pclips     = parse_pack(raw)
        assert "createdAt" not in pm, "part manifest must carry no timestamp"
        for (w, v), info in pclips.items():
            assert (w, v) not in seen_keys, "clip present in two parts"
            seen_keys.add((w, v))
            assert info["audio"] == combined[(w, v)]["audio"], \
                "audio bytes differ after part round-trip"
        pwords = set(c["word"] for c in plist)
        for w in pwords:                    # block integrity: all voices together
            have = sum(1 for k in pclips if k[0] == w)
            want = sum(1 for k in combined if k[0] == w)
            assert have == want, "block split across parts for %s" % w
    assert seen_keys == set(combined.keys()), "parts do not cover all clips"

    hashes_before = [hashlib.sha256(part_bytes(p)).hexdigest()
                     for p in part_lists]

    extra_word = "perennial"
    blocks2    = blocks + [{"index": len(blocks) + 1, "entries": [extra_word]}]
    combined2  = dict(combined)
    for v in VOICES:
        combined2[(extra_word, v)] = {
            "gen": 4, "audio": bytes(random.getrandbits(8) for _ in range(2500))}
    part_lists2   = split_parts(blocks2, combined2, cap)
    hashes_after  = [hashlib.sha256(part_bytes(p)).hexdigest()
                     for p in part_lists2]
    assert hashes_after[:len(hashes_before) - 1] \
           == hashes_before[:len(hashes_before) - 1], \
        "appending a block changed an earlier part - sha256 stability broken"

    print("[selftest] OK - %d clips round-tripped, %d-byte pack, "
          "%d part(s) verified, earlier-part hashes stable"
          % (len(fake), len(pack), len(part_lists)))


# --- Extract (listen to clips) -------------------------------------------

def run_extract():
    """Unpack the built pack into individual MP3 files so the clips can be
    played and checked. Reads every part file in tools/dist/ (and the legacy
    full pack, if one is still present) and writes one MP3 per clip into
    tools/dist/clips/, named word__voice.mp3.
    """
    sources = []
    if os.path.isdir(DIST_DIR):
        for f in sorted(os.listdir(DIST_DIR)):
            if _is_pack_asset(f):
                sources.append(os.path.join(DIST_DIR, f))
    if not sources:
        raise SystemExit("no pack files in %s; run a build first" % DIST_DIR)

    clips = {}
    for path in sources:
        _, part_clips = parse_pack(open(path, "rb").read())
        clips.update(part_clips)
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


if "--selftest" in _args:
    run_selftest()
elif "--extract" in _args:
    run_extract()
else:
    _limit = int(_opt_value("--limit") or 0)
    _range = _parse_range_arg(_opt_value("--range"))
    run_build(dry_run=("--dry-run" in _args), limit=_limit, cli_range=_range)
