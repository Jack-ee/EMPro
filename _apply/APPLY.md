# EMPro v105 — the Stories tab is a library first

Thirteen files. Extract into `EMPro-main/` with 7-Zip or Expand-Archive, not
Explorer, so `.github` is not skipped.

Delete the older test generations afterwards — same suites, renamed:

```powershell
Remove-Item test\test-stories-v103.js, test\test-stories-dom-v103.js,
            test\test-sync-truncation-v103.js, test\test-pack-parts-v103.js,
            test\test_audio_parts_v103.py, test\test-speech-chain-v104.js
```

## What changed

Opening the tab meant meeting six inputs, two checkboxes, four buttons and a
repo/token form before reaching a single piece of reading. That order was
backwards: reading happens daily, generating occasionally, cloud setup once.

The tab now holds three screens and shows one at a time.

**Library** is where you land. A header line counts what there is to read, then
the material. Nothing else. One button, "New pieces", leads to the generator.

**Generate** holds the parameters, the preview, and the prompt buttons. The
cloud build settings — repo, token, sentence voice, publish — are folded into a
collapsed section inside it, because they are set once and then forgotten.

**Read** is unchanged.

Paste back appears on the library too, in a banner that shows only while pieces
are waiting for text. The loop is: copy a prompt, leave for the AI, come back
and paste — and that return trip usually starts a fresh session, so the way to
finish it has to be on the first screen rather than two taps inside the
generator. Reserving a batch now returns to the library for the same reason.

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

Expect 101 / 9 / 24 / 16 passed and "all DOM checks passed" (42 assertions, up
from 32: the new ones drive the three screens through the real markup).

Nothing in the audio pipeline changed, so no rebuild is needed. Reload twice for
the service worker.
