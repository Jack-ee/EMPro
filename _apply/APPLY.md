# EMPro v106 — the story sentences had no clips yet

Five files. This one is on top of v105; if v105 is not applied yet, apply it
first.

```
app.js
sw.js
index.html
tools/generate_audio_pack.py
test/test_audio_parts_v105.py
```

## What actually happened

The word list was correct: no range, `sentence_voice: nova`, 561 word blocks
and 2 story blocks. The lookup was correct too — export, playback and generator
all normalise text the same way.

The clips simply did not exist yet.

That word list was the first to carry `# sentence_voice:`. Before it, long
entries used `voices[0]`, which for a full selection is **alloy**. Naming nova
therefore moved all 1118 long entries in the word blocks to a voice they had
never been built in: about 134,000 characters, roughly $2, and far more than
one run's time budget. The build re-synthesised its way through the first part,
spent the budget, published a partial pack and exited INCOMPLETE — which is the
checkpoint design working, not a failure. The Actions run for it will be red
with `time budget` in the log.

Story blocks are indexed 10001 and up, so their part sorts **last**. It was
never reached. Their sentences had no clips, so playback fell back to the
device voice. "Part 1/1" was the first word part, not the story part.

## Two fixes

**The sentence voice now defaults to the first selected voice, not to nova.**
Pinning should be a no-op at the moment it is first pinned; it exists to stop
the word-voice selection from dragging sentence audio around later, not to
move it now. A fixed default did the exact thing the feature was meant to
prevent.

**Brand-new parts are built before parts that only changed.** New material
sorts last by index, so a run with re-synthesis to do would spend its whole
budget on old content and never reach what you are waiting to hear.

## What to do

1. Apply these files, reload the app twice.
2. Stories, New pieces, open "Audio and cloud build", set **Sentence voice** to
   **alloy**. That matches what your pack already holds, so nothing gets
   re-synthesised.
3. Publish the word list again (or export and commit it).
4. Run the workflow. It now has only the 29 story sentences to synthesise —
   one short run, a few cents.
5. Download the pack on the device and play a story sentence.

The nova clips already synthesised stay in the pack as dead weight. They are
harmless; a build with `prune_voices` ticked reclaims the space whenever you
feel like it.

If you would rather have nova read the sentences, that is a legitimate choice —
it just costs the $2 and needs the workflow re-run several times until it stops
reporting INCOMPLETE. Nothing is paid for twice across those runs.

## Verify

```powershell
Get-Content _apply\CHECKSUMS.txt | ForEach-Object {
    $hash, $path = $_ -split ' \*', 2
    if (Test-Path $path) {
        $actual = (Get-FileHash $path -Algorithm SHA256).Hash.ToLower()
        if ($actual -eq $hash) { "OK       $path" } else { "MISMATCH $path" }
    } else { "MISSING  $path" }
}
Remove-Item -Recurse -Force _apply
```

## If a sentence still plays in the device voice

Open DevTools while it plays. `tts-pack.js` logs every lookup:

```
[pack] HIT  "she pried the crate open."  — voice alloy (cached: alloy)
[pack] MISS "she pried the crate open."  — pack has 31234 clip(s) but not this word
```

A MISS with the exact text is the answer — send me that line.
