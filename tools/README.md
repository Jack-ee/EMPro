# EMPro pronunciation packs

Pre-generated word pronunciations, built in bulk from a reliable network and
downloaded into the app, so playback of covered words needs no API key, no
proxy, and no live network.

This folder is the generation side of the feature. The app side (the download
button and playback) is built separately and consumes the pack format
described below.

## How it works

A Python script reads `wordlist.txt`, calls OpenAI TTS for each word in
several voices, and bundles the audio into one pack file. It runs as a GitHub
Action, so the OpenAI key lives only in an encrypted Action secret and never
reaches the app. The pack is published as a GitHub Release asset, which is
served through a CDN.

Generation is incremental. Each run downloads the previous pack from the
Release and reuses it, so only words that do not yet have audio are sent to
OpenAI. The previous pack is the only state the build needs.

## One-time setup

1. Add the OpenAI key as a repository secret.
   Repository Settings, then Secrets and variables, then Actions, then New
   repository secret. Name it `OPENAI_API_KEY` and paste your key as the
   value. The key stays encrypted and is never written to the app or the
   pack.

2. Confirm Actions may write releases.
   Repository Settings, then Actions, then General, then Workflow
   permissions. Select Read and write permissions. The workflow also
   declares this itself, so this is just a fallback check.

3. Put your vocabulary in `wordlist.txt`.
   One entry per line. An entry can be a word, a collocation, an example
   sentence, or a definition. The EMPro app's "Export word list" button
   writes all of these from your notebook, so normally you just replace
   this file with that export rather than editing it by hand.

## Running a build

Either commit a change to `wordlist.txt` (a push that touches that file
triggers a build), or open the Actions tab, choose Build audio pack, and
click Run workflow.

The build publishes three assets to a Release tagged `audio-pack`. The
download URLs are stable, so the app can always fetch the latest pack from
the same address:

```
https://github.com/<owner>/EMPro/releases/download/audio-pack/empro-audio-pack.empack
https://github.com/<owner>/EMPro/releases/download/audio-pack/empro-audio-pack.delta.empack
https://github.com/<owner>/EMPro/releases/download/audio-pack/empro-audio-pack.manifest.json
```

## Running it locally

The script needs only Python 3 and the standard library.

```
python tools/generate_audio_pack.py --selftest   verify the pack format only
python tools/generate_audio_pack.py --dry-run     list missing clips, no API calls
python tools/generate_audio_pack.py --limit 20    cap API calls for a test run
OPENAI_API_KEY=sk-... python tools/generate_audio_pack.py    real local run
```

A local run with no `GITHUB_REPOSITORY` set treats every run as a first run
and rebuilds from scratch, since it cannot reach the previous Release pack.

## Voices

The voices are listed in `VOICES` at the top of `generate_audio_pack.py`,
currently `alloy`, `nova`, and `fable`. The count is not hardcoded anywhere.
Adding a voice to that list makes every existing word missing that voice, so
the next run backfills it for the whole word list automatically.

## Pack format

The pack is a single binary file. It uses no base64 and no zip, so the app
needs no extra library and no build step to read it. MP3 is already
compressed, so a zip would add a dependency for almost no size saving; raw
concatenation avoids both the dependency and the base64 size penalty.

```
bytes  0..7      ASCII magic, exactly  EMPACK1\0
bytes  8..11     uint32 little-endian, the manifest length M in bytes
bytes 12..12+M   UTF-8 JSON manifest
bytes 12+M..end  raw audio payload, every clip's MP3 bytes concatenated
```

The manifest is a JSON object:

```
{
  "format"    : "empack",
  "version"   : 1,
  "generation": 3,
  "createdAt" : "2026-05-26T08:00:00Z",
  "model"     : "gpt-4o-mini-tts",
  "voices"    : ["alloy", "nova", "fable"],
  "clipCount" : 1287,
  "clips"     : [
    { "word": "ubiquitous", "voice": "alloy", "gen": 1,
      "offset": 0, "length": 8421 }
  ]
}
```

Each clip entry locates its MP3 bytes inside the audio payload. `offset` is
measured from the start of the payload, that is from byte `12+M` of the file.
`word` is always lowercased. `gen` records the generation the clip was added
in. The app keys its IndexedDB store by `voice + "|" + word`, the same key
shape as the existing live TTS cache.

Reading a pack in the browser is a few lines:

```
const buf  = await response.arrayBuffer();
const dv   = new DataView(buf);
const mLen = dv.getUint32(8, true);
const manifest  = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buf, 12, mLen)));
const dataStart = 12 + mLen;
for (const c of manifest.clips) {
    const slice = buf.slice(dataStart + c.offset,
                            dataStart + c.offset + c.length);
    const blob  = new Blob([slice], { type: "audio/mpeg" });
    // store blob under `${c.voice}|${c.word}`
}
```

## The three output files

empro-audio-pack.empack
The full pack, every word in every voice. The app downloads this once, then
imports clips it does not already have. Re-downloading after a small change
is wasteful on bandwidth but cheap on work, since the import skips clips that
are already stored.

empro-audio-pack.delta.empack
Only the clips added in the most recent run. Same format as the full pack. If
the app is exactly one generation behind the Release, it can fetch this
instead of the whole pack. If it is further behind, it should fetch the full
pack. A run that adds nothing produces no delta file.

empro-audio-pack.manifest.json
The full pack manifest on its own, without audio. It is tiny. The app can
fetch it first to learn the current generation and which words are covered,
then decide whether a download is needed at all.

## Scope notes

The pack covers whatever is in `wordlist.txt`. When exported from the app
that means single words plus their collocations, example sentences, and
English definitions, so My Words autoplay can read all of them offline
with no key, proxy, or network.

To keep the pack from ballooning, words and short collocations are
synthesised in every voice (so autoplay can vary the voice on repeat),
while long entries — example sentences and definitions — are synthesised
in only one voice, since rotation on a whole sentence is barely audible
and these clips are much larger. The cut-off and the long-entry voice
count are the `SHORT_ENTRY_MAX_CHARS` and `LONG_ENTRY_VOICES` constants
near the top of `generate_audio_pack.py`. A list of a few hundred words
with their phrases and sentences still produces a pack on the order of a
couple of hundred megabytes; use the `# limit:` header (set in the app,
Settings, Voice) to build it across several incremental runs, or pick
fewer voices to shrink it further.

Chinese meanings and translations are never packed: the app always reads
Chinese with the device's native voice, so packing it would add size for
audio that is never used. The exporter drops any entry containing Chinese
characters automatically.

Words removed from `wordlist.txt` are pruned from the pack on the next
build, so audio for deleted vocabulary does not accumulate. The app
performs the same cleanup on its own store when a word is deleted from
the notebook.
