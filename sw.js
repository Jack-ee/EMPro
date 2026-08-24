// sw.js — English Master Pro Service Worker
// v12 — fixes PWA install on mobile:
//   • v11: removed phantom files (dictionary.js, vocab.js, stories.js,
//     i18n.js) that were breaking cache.addAll().
//   • v12: added maskable icon entries for proper Android webapk build.
//     The previous icons were JPEG-in-PNG files (wrong MIME and wrong
//     dimensions), which made Android silently fail the install-to-
//     launcher step after reporting "installed successfully".
//   • Resilient install: individual cache.put calls so any single missing
//     file is logged as a warning, not a fatal error.
//   • Network-first for local assets (picks up deploys without a hard reload).
// v15 — cache-busting version strings on asset URLs:
//   • index.html now references style.css?v=15, app.js?v=15, etc.
//   • Offline fallback uses { ignoreSearch: true } so a versioned request
//     like style.css?v=15 still matches the plain style.css entry cached
//     at install time. This keeps the app working offline across deploys.

// v94 — audio pack: diagnostic logging on the playback path
//   (tagged "[pack]", visible in the debug panel Log tab).

// v93 — audio pack playback:
//   • speak() now plays English words from the downloaded pack when a
//     clip exists — no key, proxy, or network for covered words —
//     falling back to the neural and then the device voice otherwise.
//   • each play picks a random voice from the chosen set, so a word
//     sounds different on repeat during autoplay.
//   • removing a notebook word also deletes its pack audio.

// v92 — audio pack: word limit and a more compact Voice panel:
//   • a "Words/build" field caps how many words each cloud build
//     generates; it is written into the exported word list and the
//     generator reads it from a "# limit:" header.
//   • Settings → Voice is tightened: two-column auto-pronounce, side
//     by side pack buttons, shorter help text.

// v91 — audio pack: voice picker, coverage, word-list export:
//   • Settings → Voice gains voice checkboxes, a coverage line
//     (how many words still lack pronunciation), and an Export word
//     list button that writes wordlist.txt with the chosen voices.
//   • the pack generator reads voices from a "# voices:" header in
//     the word list, so voices are chosen in the app, not source.

// v90 — pre-generated pronunciation pack:
//   • new module tts-pack.js: downloads a bundled pack of word audio
//     into a dedicated, never-evicted IndexedDB store ('emp-tts-pack').
//   • the pack is fetched through the existing Cloudflare Worker,
//     which now also relays the GitHub Release asset (Release assets
//     send no CORS header, so a direct browser fetch is blocked).
//   • Settings → Voice gains a "Download audio pack" button.

// v89 — stop syncing the OpenAI key:
//   • the OpenAI TTS key is a credential and is now excluded
//     from the Gist sync payload (like the AI provider key), so
//     it is never written to GitHub. Removes a key-exposure path.

// v88 — honest neural voice test:
//   • the Test button now uses a unique sentence each run so
//     the proxy edge cache can't serve a stale clip — a passing
//     test now genuinely means the OpenAI key works.

// v87 — OpenAI key sanitization:
//   • strip non-ASCII characters (zero-width spaces, smart
//     quotes, full-width letters) from the key before it is put
//     in the Authorization header — fixes the fetch() error
//     'String contains non ISO-8859-1 code point'.

// v86 — bilingual voice routing:
//   • Chinese text always uses the device's native Chinese
//     voice; the OpenAI neural voice is reserved for English.

// v85 — neural TTS via CORS proxy:
//   • OpenAI blocks direct browser calls; TTS requests now go
//     through a user-supplied proxy URL (a Cloudflare Worker).
//   • new 'TTS proxy URL' field in Settings → Voice.

// v84 — neural TTS debug output:
//   • [tts] console logs for voice resolution, HTTP status, and
//     byte size (auto-captured by the debug panel log).
//   • Test button shows a visible status line: voice + KB size.

// v83 — neural TTS diagnostics:
//   • 'Test neural voice' now reports the real outcome (works,
//     or the specific error) instead of silently downgrading.
//   • a neural failure during playback shows a one-time toast so
//     a silent fallback no longer looks like 'the switch does nothing'.

// v82 — neural TTS reliability:
//   • synthesised clips persist in IndexedDB — each text is
//     fetched from OpenAI at most once per device, then reused
//     across reloads and offline.
//   • transient failures (429 / network) retried with backoff
//     before falling back, fixing the mixed-voice autoplay.

// v81 — settings redesign:
//   • Settings split into 5 tabs (General / Voice / AI / Sync /
//     Data) so it no longer scrolls as one long page.

// v80 — multi-user:
//   • per-install PROFILE_ID (no data / Gist collision between
//     users); first run asks for a display name.
//   • non-owner installs see only a demo subset of Expressions;
//     the Ref tab stays shared in full.

// v79 — neural TTS:
//   • optional OpenAI gpt-4o-mini-tts voice engine for far less
//     robotic sentence playback; device voice remains the offline
//     fallback. Settings → Voice → Voice engine.

// v78 — batch paste-back fix:
//   • enriched entries now carry an INPUT field echoing the original
//     word, so an inflected word ('squeezed') updates its own row
//     instead of leaving an orphan when the AI returns the lemma.
//   • wider irregular-verb / Latin-plural lemma table.

// v95 — fix \"app stuck on an old version\":
//   • the network-first fetch handler now passes { cache: 'no-cache' }
//     so a request really goes to the server instead of being satisfied
//     by the browser / CDN HTTP cache. GitHub Pages sends a max-age, so
//     plain fetch(e.request) could return a stale document that still
//     referenced the previous ?v= assets — the app then loaded an old
//     build even though a new one was deployed.
//   • index.html registers the SW with updateViaCache:'none' so the
//     worker script itself is never served stale either.

// v96 — redeploy of the audio-pack Range UI (app.js / index.html / db.js)
//        after an older copy was accidentally republished; cache bumped so
//        the corrected files refresh cleanly on every device.

// v106 — FIX: pinning the sentence voice re-synthesised a whole pack.
//   The sentence voice added in v101 defaulted to 'nova'. Every long entry
//   in an existing pack had been built with voices[0] instead, which for a
//   full selection is 'alloy' - so the first export carrying the pin moved
//   1118 long entries to a voice they were not built in. Roughly $2 of
//   synthesis and several budget-capped runs, to change nothing anyone
//   asked to change, and the new story part (sorted last by index) never
//   got built at all: its sentences fell back to the device voice, which
//   is how this surfaced. The default is now the first SELECTED voice, so
//   pinning is a no-op at the moment it is first pinned and only takes
//   effect when deliberately changed.
//   generator: brand-new parts are built before parts that merely changed.
//   Story blocks sort last by index, so a run that also had re-synthesis to
//   do would spend its whole budget on old material and never reach the
//   material the user is actually waiting to hear.
//
// v105 — the Stories tab is a library first, machinery second.
//   Opening the tab used to mean meeting six inputs, two checkboxes, four
//   buttons and a repo/token form before reaching a single piece of
//   reading. The order was backwards: reading happens daily, generating
//   occasionally, cloud setup once. The tab now holds three screens and
//   shows one at a time.
//     • Library (default): the material, and nothing else. A header line
//       counts what there is to read, and a banner appears only when
//       pieces are waiting for text.
//     • Generate: parameters and the prompt, behind "New pieces". The
//       cloud build settings are folded into a <details> inside it, since
//       they are set once and then forgotten.
//     • Read: unchanged.
//   Paste back sits on the LIBRARY banner as well as in the generator: the
//   loop is copy a prompt, leave for the AI, come back later, and that
//   return trip usually starts a fresh session.
//
// v104 — FIX: autoplay stopped after the first card.
//   Autoplay is a chain: a segment advances the session only when its
//   onEnd fires. speakNative could finish without firing anything at all,
//   which did not lose one segment, it silently ended the session. Three
//   causes, all now handled:
//     1. speak() was issued in the same tick as cancel(). The cancel is
//        still settling, the utterance is dropped, and NEITHER onend nor
//        onerror fires. The speak is now deferred by 60 ms.
//     2. the utterance was a local variable, so once speak() returned the
//        page held no reference and Chrome could collect it mid-speech,
//        taking its events with it. A module-level reference now holds it.
//     3. Chrome stops long utterances at about 15 seconds with no event.
//        A resume() tick every 8 seconds keeps them going.
//   A watchdog covers anything left: if nothing has fired within the time
//   the text could plausibly take (Chinese budgeted per character at three
//   times the Latin rate, and scaled by speech rate), onEnd fires anyway.
//   Ending a segment early costs little; ending the session costs the
//   whole feature. stopSpeak now also cancels a deferred speak, so a stop
//   during those 60 ms cannot advance the chain afterwards.
//
// v103 — reading material reads as prose, and at a workable density:
//   • the reader now renders a piece as continuous paragraphs by default,
//     with each sentence an inline span. Sentences remain the audio pack's
//     unit and stay individually playable and highlightable, they just no
//     longer LOOK like a list. A toggle switches to the old
//     sentence-per-row layout, which is still better for checking a
//     translation.
//   • "br": true on a sentence starts a new paragraph. Absent on anything
//     written before v103, which renders as one paragraph as before.
//   • density: the length control was a fixed list topping out at 250
//     words, and defaulted to 120. With 20 target words that is one
//     target every six words, which no narrative can absorb - the model
//     had no option but to write one sentence per word. Length is now a
//     number that follows the words-per-piece (about 18 words of prose per
//     target word), the preview states the density it implies and warns
//     below 8, and the prompt names both the figure and the failure mode.
//
// v102 — split audio pack (parts model), end to end:
//   • generator: the pack is published as several parts plus a small
//     manifest listing each part's sha256. Parts are cut on word-block
//     boundaries by pure index arithmetic — block b belongs to the part
//     covering [k*stride+1 .. (k+1)*stride], k = (b-1)//stride — because a
//     size-greedy split would cascade: one early edit would push blocks
//     across every later boundary and re-download the whole pack.
//   • generator: part bytes are built with stamp=False, so they depend only
//     on the clips. With a timestamp inside, every part's sha256 would
//     change every run and the split would buy nothing. Each part also
//     records keysSha256 of what it ACTUALLY holds, so a part left
//     incomplete by the time budget comes back as "changed" next run
//     instead of being mistaken for finished.
//   • generator: a run now reads the published manifest and rebuilds only
//     the parts whose clip set changed. An unchanged part is not
//     downloaded, not rebuilt, and not re-uploaded — adding twenty words
//     moves one part instead of 1.4 GB.
//   • generator: the first v2 run finds the old single-file pack and
//     re-emits it as parts, synthesising nothing.
//   • generator: futures that finished while the run was stopping are now
//     harvested instead of discarded — stopping on a budget was throwing
//     away up to MAX_WORKERS clips that had already been paid for.
//   • generator: _budget_start clears the abort flag, so a second build in
//     one process cannot inherit the first one's abort and silently skip
//     every part. Also guards the entry point behind __main__ so the module
//     can be imported by a test without starting a real build.
//   • client: only parts whose sha256 differs are fetched, each is verified
//     against that hash, and each is recorded the moment it imports — so an
//     interrupted download resumes at the next part instead of restarting.
//     A quota failure names the part that stopped it and keeps the rest.
//     A v1 manifest still works, so no device is stranded mid-migration.
//   • worker: the manifest is served no-store (a cached manifest makes the
//     app decide "up to date" when it is not, silently, until the next
//     build), while a part requested with its ?v=<sha256> is immutable.
//   • workflow: publishes tools/dist/*.empack, then deletes release assets
//     not named in keep-assets.txt, which is how parts for deleted words and
//     the pre-split pack get cleaned up. Skipped when no manifest was
//     produced, so a failed run can never delete a working pack.
//
// v101 — audio build: no run can lose its work; sentence audio is pinned:
//   • generator: TIME_BUDGET_MINUTES (env) stops the run before the runner
//     kills it, writes the partial pack, and exits [INCOMPLETE] with
//     re-run advice. The workflow publishes it anyway (publish is
//     if: always()), so the next run continues from it and no clip is ever
//     paid for twice. Three nested limits, 320 / 330 / 350, each leaving
//     10 minutes for the next layer to hand over.
//   • generator: "# sentence_voice:" pins the voice that reads long
//     entries. Without it a long entry used voices[0] — the FIRST of the
//     selected voices, alphabetically — so un-ticking "alloy" moved every
//     sentence to "ash" and re-synthesised thousands of clips, while the
//     alloy ones stayed in the pack forever. The manifest now carries the
//     union of word and sentence voices, because the client only looks up
//     clips in voices listed there.
//   • generator: --prune-voices (opt-in) drops clips whose voice is no
//     longer used and reports the space reclaimed; without it the run just
//     names the idle voices. The old prune matched on text alone, so
//     de-selected voices accumulated forever.
//   • sync: the Gist API truncates a file near 1 MB (well under that for
//     Chinese) and sets `truncated`. Reads now refetch from raw_url —
//     with NO Authorization header, which would trigger a CORS preflight
//     the raw host refuses. Before this, a truncated read was silently
//     treated as the whole document. Pushes warn above 600 KB of real
//     UTF-8 bytes, not UTF-16 code units.
//
// v100 — reading material from the word bank (new module stories.js):
//   • Stories tab: takes N unused notebook words, splits them into
//     groups of M, and reserves each group as a "pending" piece the
//     moment its prompt is copied — so the next run always works on
//     the words that have not been used yet. Deleting a piece releases
//     its words back into the pool.
//   • paste the AI's JSON reply back and each piece is matched by its
//     seq number: title, sentences, per-sentence Chinese. Target words
//     are highlighted through the notebook's inflection matcher, so
//     "proved" lights up for "prove".
//   • audio: a piece's wordlist.txt block index is 10000 + seq, above
//     every word's packIndex. The export writes words AND sentences in
//     one file — the generator prunes clips missing from the WHOLE list,
//     so a stories-only file would have deleted every word clip.
//   • publishing is automatic: the app commits tools/wordlist.txt through
//     the contents API and the push starts the build. It compares the git
//     blob sha first, so an unchanged list is never pushed and never
//     builds. No build range is set and none has to be cleared — the
//     build is differential by (text, voice), so nothing is ever remade
//     and adding a voice synthesises only that voice.
//   • app.js: notebookSpeechBlocks / notebookSpeechList feed the story
//     sentences into the existing export and coverage readout;
//     exportWordList, buildWordListText, getPackRange, setPackRange are
//     now on window.App.
//   • FIX (same-origin isolation): the activate handler deleted every
//     cache whose name was not CACHE_NAME, which wiped VocabPeak's hsv-*
//     caches on this shared origin. It now only deletes emp- caches.

// v107 — Daily Reading (reading-feeds.js), restored on the v106 base:
//   • live sources in the Reader tab: NPR News Now / Up First and the
//     BBC Global News Podcast (native speed, per-episode MP3), the
//     Guardian via the Worker-held API key, and two frozen VOA feeds
//     kept as public-domain archive. List fetched fresh; an article
//     and its audio download on tap into the emp-reading IndexedDB
//     with a soft cache cap; tap a word to save it to the notebook.
//   • the v100–v102 uploads had been built on a stale v98 snapshot
//     and overwrote v99–v106 (Stories, split packs, speech chain);
//     this release re-grafts Daily Reading onto the real v106 tree.

// v108 — cloud build un-bricked (run 4f1740c, exit 1 in 17 s):
//   • the wordlist's "# sentence_voice: alloy (long entries ...)"
//     explainer was parsed as fifteen voice names; "(long" reached
//     OpenAI as a voice and aborted the run before any part was
//     built, which is also why the story part p10001+ never existed
//     and Stories fell back to the device voice.
//   • header parsing now cuts at '(' / '#' and filters against
//     KNOWN_VOICES with a warning; the app's export writes the
//     explainer on its own comment line; selftest covers the case.

// v109 — NPR audio unblocked:
//   • NPR enclosures now start on prfx.byspotify.com (then podtrac,
//     then npr.simplecastaudio.com); the Worker's media whitelist only
//     knew the older tracking hosts, so the first hop got a 400 and
//     Daily Reading fell back to text-only without saying why. Both
//     hosts whitelisted; an audio download failure now shows a toast
//     with the HTTP status instead of failing silently.

// v110 — three feed-parsing fixes from live testing:
//   • NPR News Now newscasts carry no <link>; items now key on
//     link -> guid -> audio URL instead of being dropped (the list
//     had shown 0 articles).
//   • BBC enclosures still use http://; the audio detector now
//     accepts both schemes (the Worker relays server-side).
//   • a record saved text-only re-downloads automatically when the
//     feed declares audio for it; feeds are capped at 100 items.

// v111 — lock-screen (background) playback:
//   • tts-pack keeps ONE persistent <audio> element and only swaps
//     src per clip, so the browser treats autoplay as one continuous
//     media session and ended->play() keeps working with the screen
//     off (a fresh new Audio() in the background is refused).
//   • My Words autoplay: with the tab hidden, the queue plays pack
//     clips only - Chinese meaning and pack misses are skipped, since
//     speechSynthesis is suspended on lock; the full chain resumes
//     when the screen comes back. Media Session puts the current word
//     and prev/pause/next on the lock screen.
//   • Daily Reading's podcast player gets a lock-screen card with
//     play/pause and 15 s seek.
//   MIUI note: give the browser unrestricted background battery use,
//   or the system may still kill it minutes after locking.

// v112 — configurable tab order:
//   • Settings -> Study gains a "Tab order" list with up/down arrows;
//     the order persists in the 'tab_order' preference and is applied
//     at boot by reordering the nav buttons in place, so views and
//     handlers are untouched. Tabs added by future versions slot in
//     at the end until reordered.

// v113 — VOA retired from Daily Reading:
//   • frozen since 2025-03-15, its newscast pages carry neither text
//     nor working audio, so a tap could only fail; VOA is gone from
//     the default sources and its dedicated machinery ("likely"
//     badge, article-page audio hunt, .wsw extractor) is removed.
//     The Worker still whitelists voanews.com for manual re-adds.
//   • a failed article download now leaves its reason in the status
//     line instead of only a transient toast; the repo copy of the
//     Worker is synced with the deployed manual-redirect version.

// v114 — Reader / Daily Reading UI polish:
//   • the source <select> becomes a horizontal brand-chip bar: each of
//     the five sources shows a colour monogram (NPR red, BBC black,
//     Guardian blue; user-added sources get initials on a derived
//     colour) - one tap to switch, active chip highlighted.
//   • podcast items show their real episode length from
//     <itunes:duration> ("24 min") instead of a misleading "~1 min"
//     read-time computed from the description; read-time badges are
//     reserved for text articles. Dates humanise to Today/Yesterday.
//   • Downloaded rows carry the source monogram.

// v115 — the Reader tab becomes News:
//   • nav tab renamed Reader -> News (newspaper icon); Daily Reading
//     is now the default sub-view so the live sources appear the
//     moment the tab opens, with Extract one tap away. The tab's
//     data-nav id is unchanged, so tab order, views and modules are
//     untouched.
//   • source chips wrap onto multiple lines instead of clipping.
//   • text-only sources (Guardian) are exempt from the Audio-only
//     filter: their articles always show, with a note, instead of a
//     confusing empty list.

const CACHE_NAME = 'emp-v115';
const ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './style.css',
    './expressions-coach.css',
    './stories.css',
    './config.js',
    './db.js',
    './ai-engine.js',
    './my-words.js',
    './writing-lab.js',
    './vocab-drill.js',
    './reader.js',
    './stories.js',
    './speaking-coach.js',
    './expressions-data.js',
    './expressions-coach.js',
    './sentence.js',
    './sentence-drill.js',
    './sync.js',
    './tts-pack.js',
    './reading-feeds.js',
    './app.js',
    './debug-panel.js',
    './icon-192.png',
    './icon-512.png',
    './icon-maskable-192.png',
    './icon-maskable-512.png'
];

// Install — cache assets individually so a single failure doesn't kill install.
// This is essential for PWA installability: if install fails, the SW never
// activates, and Chrome on Android won't offer the "Install" prompt.
self.addEventListener('install', (e) => {
    e.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        await Promise.all(ASSETS.map(async (url) => {
            try {
                const resp = await fetch(url, { cache: 'reload' });
                if (resp && resp.ok) {
                    await cache.put(url, resp);
                } else {
                    console.warn('[SW] Skipped (bad response):', url, resp && resp.status);
                }
            } catch (err) {
                console.warn('[SW] Skipped (fetch failed):', url, err && err.message);
            }
        }));
    })());
    self.skipWaiting();
});

// Activate — clean old caches, take control immediately
self.addEventListener('activate', (e) => {
    e.waitUntil((async () => {
        // Only ever delete THIS app's own old caches. jack-ee.github.io also
        // serves VocabPeak (hsv-*), and a blanket "delete everything that is
        // not CACHE_NAME" wiped its offline copy on every EMPro deploy.
        // Same-origin isolation is a hard rule: touch the emp- prefix only.
        const names = await caches.keys();
        await Promise.all(names
            .filter(n => n.startsWith('emp-') && n !== CACHE_NAME)
            .map(n => caches.delete(n)));
        await self.clients.claim();
    })());
});

// Fetch — network-first for local GETs, fall back to cache when offline.
// Cross-origin requests (API providers, GitHub Gist, Google Fonts, Google TTS)
// pass straight through — never cached, never intercepted.
self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);

    // Cross-origin: pass through untouched
    if (url.hostname !== location.hostname) {
        return;  // let browser handle it
    }

    // Any non-GET (or sync file): never cache
    if (e.request.method !== 'GET' || url.pathname.includes('emp-sync')) {
        e.respondWith(fetch(e.request));
        return;
    }

    // Local GETs: network-first, fall back to cache when offline.
    // { cache: 'no-cache' } forces the browser to revalidate with the
    // server instead of returning a stale HTTP-cached copy. This is the
    // fix for \"a new deploy never shows up\": without it, network-first
    // could still hand back an old document from the CDN/browser cache.
    e.respondWith((async () => {
        try {
            const fresh = await fetch(e.request, { cache: 'no-cache' });
            if (fresh && fresh.ok && fresh.type !== 'opaque') {
                const cache = await caches.open(CACHE_NAME);
                cache.put(e.request, fresh.clone()).catch(() => {});
            }
            return fresh;
        } catch {
            // Offline fallback: ignore ?v=N query strings so a request for
            // style.css?v=15 still matches the plain style.css entry cached
            // at install time. Without ignoreSearch we'd miss every asset
            // after the first cache-bust and break offline mode.
            const cached = await caches.match(e.request, { ignoreSearch: true });
            if (cached) return cached;
            if (e.request.destination === 'document') {
                return (await caches.match('./index.html')) || new Response('Offline', { status: 504 });
            }
            return new Response('Offline', { status: 504 });
        }
    })());
});

// Support a manual "activate new SW" message from the page
self.addEventListener('message', (e) => {
    if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
