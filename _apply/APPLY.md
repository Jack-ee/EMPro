# EMPro v104 — autoplay stopping after the first card

Six files. Extract into `EMPro-main/` with 7-Zip or Expand-Archive, not
Explorer, so `.github` is not skipped.

```
app.js
sw.js
index.html
package.json
.github/workflows/tests.yml
test/test-speech-chain-v104.js
```

## The bug

Autoplay is a chain: a segment advances the session only when its onEnd
callback fires. `speakNative` could finish without firing anything at all, and
that does not lose one segment — it silently ends the session. The Chinese
meaning of a card always goes through this path, which is why playback stopped
right after the word and its explanation.

Three causes, all handled now:

1. `speak()` was called in the same tick as `cancel()`. The cancel is still
   settling, the new utterance is dropped, and neither `onend` nor `onerror`
   ever fires. The speak is deferred by 60 ms, well below anything audible.
2. The utterance was a local variable. Once `speak()` returned, the page held
   no reference and Chrome could collect it mid-speech, taking its events with
   it. A module-level reference now holds it until it finishes.
3. Chrome stops long utterances at roughly 15 seconds with no event. A
   `resume()` every 8 seconds keeps them going.

A watchdog covers whatever is left: if nothing has fired within the time the
text could plausibly take, onEnd fires anyway. Chinese is budgeted at about
three times the per-character time of Latin text, and the budget scales with
the speech rate. Ending one segment early costs little; ending the session
costs the feature.

`stopSpeak` also cancels a deferred speak, so pressing stop inside those 60 ms
cannot let a segment advance the chain afterwards.

Nothing in the autoplay code itself changed — my-words.js is untouched. This
was a latent race in the speech layer that a change in timing exposed.

## Verify and test

```powershell
Get-Content _apply\CHECKSUMS.txt | ForEach-Object {
    $hash, $path = $_ -split ' \*', 2
    if (Test-Path $path) {
        $actual = (Get-FileHash $path -Algorithm SHA256).Hash.ToLower()
        if ($actual -eq $hash) { "OK       $path" } else { "MISMATCH $path" }
    } else { "MISSING  $path" }
}
Remove-Item -Recurse -Force _apply

npm.cmd test
```

Expect 101 / 9 / 24 / 16 passed and "all DOM checks passed". The new suite
drives a fake speech engine through every silent-failure mode and asserts that
onEnd fires exactly once each time — twice would be as damaging as never, since
it would skip a card.

Reload the app twice for the new service worker, then run autoplay through a
group of several words.

## If it still stops

Open DevTools while it runs and watch the console. `[speak] no end event within
budget; advancing anyway` means the watchdog is doing its job and the engine is
the problem, which is useful to know. Anything else, send me the message.
