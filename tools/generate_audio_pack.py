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
SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
WORDLIST     = os.path.join(SCRIPT_DIR, "wordlist.txt")
DIST_DIR     = os.path.join(SCRIPT_DIR, "dist")
FULL_NAME    = "empro-audio-pack.empack"
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

    prev_manifest, existing = download_previous_pack(repo, tag, token)
    prev_gen = prev_manifest.get("generation", 0) if prev_manifest else 0

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
