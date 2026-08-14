/**
 * test/test-stories-dom-v105.js — Stories UI flow (stories.js + index.html)
 * ============================================================
 * Run:  npm install jsdom  &&  node test/test-stories-dom-v105.js
 *
 * Loads the real index.html in jsdom, evaluates stories.js against it, and
 * clicks through one full cycle: preview -> reserve -> paste back -> read ->
 * play -> export -> delete. DB and App are stand-ins; everything else is the
 * shipped markup and module.
 *
 * Two bugs were found by this file and are now guarded in stories.js:
 *   • the token rule for single-word targets was ASCII-only, so a target
 *     with a digit or an accent was never highlighted
 *   • scrollIntoView with an options object threw here, which killed
 *     sequential playback after the first sentence; both scroll calls are
 *     best-effort now, which also protects the domestic Android WebViews
 * ============================================================
 */
'use strict';

try { require.resolve('jsdom'); }
catch (e) {
    console.log('jsdom is not installed - run:  npm install jsdom');
    process.exit(0);
}

const fs = require('fs');
const { JSDOM } = require('jsdom');
const R = require('path').join(__dirname, '..') + '/';

const dom = new JSDOM(fs.readFileSync(R + 'index.html', 'utf8'), { runScripts: 'outside-only' });
const w = dom.window;

// Minimal DB + App stand-ins (the real app.js needs config.js, sync, etc.)
const store = new Map();
const notebook = [];
for (let i = 1; i <= 562; i++) notebook.push({
    word: 'w' + String(i).padStart(3,'0'), meaning: '中' + i, phonetic: '/w/',
    packIndex: i, addedAt: 1000 + i
});
w.DB = {
    getPref: (n, f) => store.has('pref_'+n) ? store.get('pref_'+n) : f,
    setPref: (n, v) => store.set('pref_'+n, String(v)),
    loadNotebook: () => notebook,
    isInflectionOf: (a,b) => a === b + 's' || a === b + 'ed' || a === b + 'd'
};
const toasts = [];
let spoken = [];
w.App = {
    showToast: m => toasts.push(m),
    escHtml: s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'),
    escAttr: s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'),
    speak: (t, r, onEnd) => { spoken.push(t); if (onEnd) onEnd(); },
    stopSpeak: () => {}, beginSession: () => 'tok', endSession: () => {},
    setPackRange: v => store.set('pref_pack_range', v),
    exportWordList: () => toasts.push('EXPORT CALLED'),
    buildWordListText: () => '# voices: nova\n#@1 w001\nw001\n'
};
w.navigator.clipboard = { writeText: t => { w.__clip = t; return Promise.resolve(); } };
w.confirm = () => true;

w.eval(fs.readFileSync(R + 'stories.js', 'utf8'));
const S = w.Stories;
S.init();

const $ = id => w.document.getElementById(id);
let fail = 0;
const ok = (c, l) => { console.log((c ? '  ✓ ' : '  ✗ ') + l); if (!c) fail++; };

// 1. Preview renders from real inputs
// The library is the screen you land on, and it holds only material.
ok($('sy-library').className.indexOf('sy-hidden') < 0, 'the library is the default screen');
ok($('sy-gen').className.indexOf('sy-hidden') >= 0, 'the generator is out of the way');
ok($('sy-read').className.indexOf('sy-hidden') >= 0, 'and so is the reader');
ok(/Nothing here yet/.test($('sy-list').textContent), 'the empty state invites a first run');
ok(/No material yet/.test($('sy-lib-count').textContent), 'the header reports an empty library');
ok($('sy-pending').className.indexOf('sy-hidden') >= 0, 'no pending banner with nothing pending');

// Opening the generator brings up the controls and the preview.
$('sy-new').dispatchEvent(new w.Event('click'));
ok($('sy-gen').className.indexOf('sy-hidden') < 0, 'the New button opens the generator');
ok($('sy-library').className.indexOf('sy-hidden') >= 0, 'and the library steps aside');
ok(/5 pieces/.test($('sy-preview').textContent), 'preview: 5 pieces from the default 100/20');
ok(/462 unused/.test($('sy-preview').textContent), 'preview: 462 words left after this run');

// 2. Change the numbers → preview follows
$('sy-count').value = '60'; $('sy-group').value = '15';
$('sy-count').dispatchEvent(new w.Event('input'));
ok(/4 pieces/.test($('sy-preview').textContent), 'preview follows 60/15 → 4 pieces');

// 3. Copy prompt & reserve
$('sy-make').dispatchEvent(new w.Event('click'));
ok(S.load().length === 4, 'four pending pieces created');
ok($('sy-library').className.indexOf('sy-hidden') < 0,
   'reserving returns to the library, where Paste back lives');
ok($('sy-pending').className.indexOf('sy-hidden') < 0, 'and the pending banner appears');
ok(/4 pieces waiting/.test($('sy-pending').textContent), 'naming how many are waiting');
ok(/seq 1 \(15 words\)/.test(w.__clip || ''), 'clipboard holds the prompt');
ok(/w001 \[中1\]/.test(w.__clip || ''), 'prompt carries the Chinese sense');
ok($('sy-copy-pending').style.display === '', '"copy prompt for waiting" appears');
ok(/#1/.test($('sy-list').textContent) && /pending/.test($('sy-list').textContent), 'list shows pending cards');

// 4. Preview now excludes reserved words
$('sy-new').dispatchEvent(new w.Event('click'));
$('sy-count').dispatchEvent(new w.Event('input'));
ok(/442 unused/.test($('sy-preview').textContent), 'preview: reserved words left the pool');

// 5. Paste back
$('sy-gen-back').dispatchEvent(new w.Event('click'));
w.document.getElementById('sy-pending-paste')
    .dispatchEvent(new w.Event('click', { bubbles: true }));
const reply = JSON.stringify({ stories: [
  { seq: 1, title: 'The Wax Apple Stand', level: 'C1',
    sentences: [ {en:'She w001 the crate open.', zh:'她打开了箱子。'},
                 {en:'The w002 rolled out.',     zh:'果子滚了出来。'} ],
    questions: [ {q:'What rolled out?', a:'The fruit.'} ] } ] });
$('sy-paste-input').value = '```json\n' + reply + '\n```';
$('sy-paste-apply').dispatchEvent(new w.Event('click'));
ok(S.load()[0].status === 'ready', 'piece 1 became ready');
ok(/The Wax Apple Stand/.test($('sy-list').textContent), 'list shows the new title');
ok(/2 sentences/.test($('sy-list').textContent), 'list shows the sentence count');
ok(/1 finished piece/.test($('sy-audio-line').textContent), 'audio line counts the finished piece');

// 6. Reader
const readBtn = w.document.querySelector('.sy-act[data-act="read"]');
readBtn.dispatchEvent(new w.Event('click', { bubbles: true }));
ok($('sy-read').className.indexOf('sy-hidden') < 0, 'reader opened');
ok($('sy-library').className.indexOf('sy-hidden') >= 0, 'library hidden while reading');
ok(/The Wax Apple Stand/.test($('sy-read-body').textContent), 'reader shows the title');
ok($('sy-read-body').innerHTML.indexOf('sy-hit') > 0, 'a target word is highlighted');
ok(/她打开了箱子/.test($('sy-read-body').textContent), 'Chinese line rendered');
ok(/Show answer/.test($('sy-read-body').textContent), 'question block rendered');
ok(/w001/.test($('sy-read-body').textContent), 'glossary lists the target words');

// 7. Playback
spoken = [];
$('sy-play-all').dispatchEvent(new w.Event('click', { bubbles: true }));
ok(spoken.length >= 1 && spoken[0] === 'She w001 the crate open.', 'play all speaks sentence 1');
const mark = w.document.querySelector('.sy-hit');
mark.dispatchEvent(new w.Event('click', { bubbles: true }));
ok(spoken.indexOf('w001') >= 0, 'tapping a highlight speaks that word');
ok(toasts.some(t => /w001 — 中/.test(t)), 'and toasts its Chinese meaning');

// 8. Chinese toggle
$('sy-toggle-zh').dispatchEvent(new w.Event('click', { bubbles: true }));
ok($('sy-sents').className.indexOf('sy-hide-zh') >= 0, 'Chinese toggles off');

// 9. Back, export, delete
$('sy-back').dispatchEvent(new w.Event('click'));
ok($('sy-library').className.indexOf('sy-hidden') < 0, 'back returns to the library');
$('sy-new').dispatchEvent(new w.Event('click'));
// A leftover range must never survive a publish, and with no repo set
// publishing falls back to the download path.
store.set('pref_pack_range', '1-50');
$('sy-publish').dispatchEvent(new w.Event('click'));
setTimeout(() => {
    ok(store.get('pref_pack_range') === '', 'publishing clears any leftover build range');
    ok(toasts.indexOf('EXPORT CALLED') >= 0, 'with no repo configured it downloads instead');
    ok(!/pack range/.test($('sy-audio-line').textContent), 'the status line no longer mentions a range');
    ok(/no repo set/.test($('sy-audio-line').textContent), 'and says publishing needs a repo');
    const del = w.document.querySelector('.sy-act[data-act="del"]');
    del.dispatchEvent(new w.Event('click', { bubbles: true }));
    ok(S.load().length === 3, 'delete removed the piece');
    ok(toasts.some(t => /15 word\(s\) released/.test(t)), 'and released its words');
    console.log('\n' + (fail ? fail + ' FAILED' : 'all DOM checks passed'));
    process.exit(fail ? 1 : 0);
}, 50);
