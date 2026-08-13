# v100 patch sheet — apply to your CURRENT tree

Do not copy `stale-tree-reference/app.js`, `index.html`, or `sw.js` over your
working copy. They were patched on the 2026-08-09 snapshot, which is **before**
the parts distribution work you shipped as emp-v99. Copying them would revert
parts. They are here only so you can diff my edits.

`stories.js` and `stories.css` are new files with no counterpart in your tree —
copy those straight in.

Below is every edit, as a find/replace against the current files. Six edits in
`app.js`, four in `index.html`, two in `sw.js`.

---

## sw.js

### 1. Cache name and asset list

```
const CACHE_NAME = 'emp-v99';   →   const CACHE_NAME = 'emp-v100';
```

Add two entries to `ASSETS`:

```js
    './stories.css',        // next to './expressions-coach.css'
    './stories.js',         // next to './reader.js'
```

### 2. Same-origin cache isolation (the guide's step 1)

FIND

```js
        const names = await caches.keys();
        await Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)));
```

REPLACE

```js
        // Only ever delete THIS app's own old caches. jack-ee.github.io also
        // serves VocabPeak (hsv-*), and a blanket "delete everything that is
        // not CACHE_NAME" wiped its offline copy on every EMPro deploy.
        // Same-origin isolation is a hard rule: touch the emp- prefix only.
        const names = await caches.keys();
        await Promise.all(names
            .filter(n => n.startsWith('emp-') && n !== CACHE_NAME)
            .map(n => caches.delete(n)));
```

---

## app.js

### 3. Story blocks into the word list

In `notebookSpeechBlocks()`, immediately before its `return blocks;`:

```js
        // v100: reading-material blocks (see stories.js). A story's block
        // index is offset by Stories.PACK_BASE (10000), so it can never
        // collide with a word's packIndex. Sentences already in the list — a
        // word's example that a story reuses — are dropped by the shared
        // `seen` set, and the pack key is the text itself, so playback still
        // finds the clip.
        (window.Stories?.speechBlocks?.() || []).forEach(b => {
            const entries = [];
            (b.entries || []).forEach(s => {
                const n = _normSpeak(s);
                if (!n || /[\u4e00-\u9fff]/.test(n) || seen.has(n)) return;
                seen.add(n);
                entries.push(n);
            });
            if (entries.length) {
                blocks.push({
                    index   : Number(b.index) || 0,
                    word    : String(b.word || 'story'),
                    entries : entries
                });
            }
        });
```

### 4. Story sentences into the coverage readout

In `notebookSpeechList()`, immediately before its `return out;`:

```js
        // v100: story sentences count toward coverage too.
        (window.Stories?.speechList?.() || []).forEach(add);
```

### 5. Split the exporter so the text can be published, not only downloaded

FIND

```js
    function exportWordList() {
        const blocks = notebookSpeechBlocks();
        if (!blocks.length) { showToast('No words to export.'); return; }
```

REPLACE

```js
    // v100: the text half of exportWordList, so the Stories module can
    // commit the very same bytes straight to the repo instead of routing a
    // download through the file system. Returns '' when there is nothing
    // to write.
    function buildWordListText() {
        const blocks = notebookSpeechBlocks();
        if (!blocks.length) return '';
```

Then, further down in the same function, FIND

```js
        const blob = new Blob([header.concat(lines).join('\n') + '\n'],
                              { type: 'text/plain' });
        const url  = URL.createObjectURL(blob);
```

REPLACE

```js
        return header.concat(lines).join('\n') + '\n';
    }

    function exportWordList() {
        const text = buildWordListText();
        if (!text) { showToast('No words to export.'); return; }

        const blocks    = notebookSpeechBlocks();
        const itemCount = blocks.reduce((n, b) => n + b.entries.length, 0);
        const range     = getPackRange();

        const blob = new Blob([text], { type: 'text/plain' });
        const url  = URL.createObjectURL(blob);
```

The rest of the old body (the anchor click and the toast) stays as it is and
now belongs to `exportWordList`.

### 6. Header line counts stories apart from words

FIND

```js
        header.push('# ' + blocks.length + ' word(s), ' + itemCount + ' item(s)');
```

REPLACE

```js
        // v100: story blocks sit above PACK_BASE, so they are counted apart
        // from the vocabulary in the header line.
        const packBase = (window.Stories && window.Stories.PACK_BASE) || 10000;
        const stCount  = blocks.filter(b => b.index >= packBase).length;
        header.push('# ' + (blocks.length - stCount) + ' word(s), '
                    + stCount + ' story block(s), ' + itemCount + ' item(s)');
```

### 7. Exports on window.App

In the `window.App = { ... }` literal, after `bindSwipe`:

```js
        // v100: the Stories module publishes the same word list.
        exportWordList,
        buildWordListText,
        getPackRange,
        setPackRange
```

### 8. Boot and tab switching

After the `safeCall('Reader', ...)` line:

```js
            safeCall('Stories',         () => window.Stories?.init?.());
```

In `bindTabs()`, inside the click handler, after
`window.SentenceDrill?.stopListen?.();`:

```js
            window.Stories?.stopPlay?.();
```

---

## index.html

### 9. Version bump

Replace `?v=99` with `?v=100` across the file, and update the
`Current version:` comment.

### 10. Stylesheet and script

```html
    <link rel="stylesheet" href="stories.css?v=100">   <!-- after expressions-coach.css -->
```

```html
<script src="stories.js?v=100"></script>               <!-- after reader.js, before app.js -->
```

### 11. Nav tab

After the `data-nav="reader"` button:

```html
        <button class="nav-tab" data-nav="stories"><span class="nav-icon">&#x1F4DD;</span><span class="nav-label">Stories</span></button>
```

### 12. The view

Copy the whole `<div class="app-view" id="view-stories"> … </div>` block from
`stale-tree-reference/index.html` (it sits between the Reader view and the
closing `</main>`). None of it exists in your tree, so there is nothing to
merge — it drops in whole.

---

## After applying

```
node test/test-stories-v100.js          # 92 assertions, no dependencies
npm install jsdom
node test/test-stories-dom-v100.js      # 32 assertions, drives the real markup
```

Then set the two cloud fields once in the Stories panel: the repo as
`owner/name`, and a fine-grained token whose only permission is
**Contents: Read and write** on that one repo. The token is written to
`empro_gh_token`, which sits outside every `emp_<profile>_` prefix, so the Gist
sync snapshot cannot pick it up.
