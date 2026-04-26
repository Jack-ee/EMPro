// ============================================================
// sentence-drill.js — Sentence Fill-in-the-Blank Practice
// Reads from window.CUSTOM_SENTENCES (sentence.js)
// Reuses click-based word bank UI pattern
// ============================================================

window.SentenceDrill = (function() {

    let container      = null;
    let sentences      = [];
    let currentIdx     = 0;
    let filledSlots    = [];
    let answered       = false;
    let score          = 0;
    let total          = 0;

    // ─── Listen-mode state ───────────────────────────────────
    // Listen mode is an independent playback loop that auto-pronounces
    // each sentence (English normal → English slow → Chinese → next).
    // It reuses window.App.speak() for TTS. Driven by a monotonically
    // increasing token so async onEnd callbacks from old utterances
    // can detect cancellation.
    let listenActive   = false;
    let listenPaused   = false;
    let listenToken    = 0;
    let listenTimer    = null;
    let listenIdx      = 0;
    let listenPhase    = '';  // 'en-normal' | 'en-slow' | 'zh' | 'idle'
    let wakeLock       = null;  // Screen wake lock during listen mode

    // A-Z range filter for Mine grid. null = show all, 'A-D' etc for ranges.
    let mwAZFilter     = null;
    // Currently displayed word in the Mine floating detail panel (null = hidden)
    let mwDetailWord   = null;
    // Currently displayed sentence index in the Curated floating detail panel
    let cDetailIdx     = null;

    // ─── Storage (profile-scoped) ────────────────────────────
    function loadState() {
        try {
            const raw = window.DB?.getPref?.('sd_state', '{}');
            return JSON.parse(raw);
        } catch { return {}; }
    }
    function saveState() {
        window.DB?.setPref?.('sd_state', JSON.stringify({
            idx: currentIdx, score, total
        }));
    }
    function loadProgress() {
        try {
            const raw = window.DB?.getPref?.('sd_progress', '{}');
            return JSON.parse(raw);
        } catch { return {}; }
    }
    function saveProgress(progress) {
        window.DB?.setPref?.('sd_progress', JSON.stringify(progress));
    }
    function getSentenceProgress(id) {
        const p = loadProgress();
        return p[id] || { attempts: 0, correct: 0, lastDate: null };
    }
    function markSentenceResult(id, isCorrect) {
        const p    = loadProgress();
        const item = p[id] || { attempts: 0, correct: 0, lastDate: null };
        item.attempts++;
        if (isCorrect) item.correct++;
        item.lastDate = new Date().toISOString().slice(0, 10);
        p[id] = item;
        saveProgress(p);
    }

    // ─── Init ────────────────────────────────────────────────
    // Two mount points now: Curated (40 hand-curated sentences) and
    // Mine (sentences pulled from enriched My Words entries). They
    // share listen-mode, drill state, and the floating detail panel.
    let curatedContainer = null;
    let mineContainer    = null;

    function initCurated(el) {
        curatedContainer = el;
        container        = el;  // default "active" container for drill/listen fallback
        sentences        = window.CUSTOM_SENTENCES || [];
        const state = loadState();
        if (state.idx != null)   currentIdx = Math.min(state.idx, sentences.length - 1);
        if (state.score != null) score = state.score;
        if (state.total != null) total = state.total;
        renderCuratedPanel();
    }

    function initMine(el) {
        mineContainer = el;
        renderMinePanel();
    }

    // When drill/listen logic needs to target "the active panel," this
    // returns whichever panel is currently visible (has class .active).
    // Falls back to curated if neither is clearly active.
    function activeContainer() {
        if (curatedContainer?.classList.contains('active')) return curatedContainer;
        if (mineContainer?.classList.contains('active'))    return mineContainer;
        return curatedContainer || mineContainer;
    }

    // Show/hide helpers for the fixed bottom detail panel. Toggles both
    // the panel's own .sd-float-detail-visible class AND a matching class
    // on the parent sub-panel so CSS can add bottom padding to the grid
    // area, keeping the last few rows visible above the overlay.
    function showDetailPanel(panel) {
        if (!panel) return;
        panel.classList.add('sd-float-detail-visible');
        const parent = panel.closest('.sc-panel');
        if (parent) parent.classList.add('sd-panel-with-detail');
        // Scroll the panel into view in case the user's viewport is short
        // and the panel would otherwise be below the fold. Small delay so
        // the layout has applied the new flex sizing first.
        setTimeout(() => {
            try { panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
            catch {}
        }, 50);
    }
    function hideDetailPanel(panel) {
        if (!panel) return;
        panel.classList.remove('sd-float-detail-visible');
        panel.innerHTML = '';
        const parent = panel.closest('.sc-panel');
        if (parent) parent.classList.remove('sd-panel-with-detail');
    }

    // Pull sentences from enriched MyWords entries. A word is eligible only
    // when it has BOTH a phonetic AND a context — those are the signals that
    // the AI enrichment completed, so the entry is safe to display as a
    // full-fledged "sentence with context" without missing pieces.
    function getMyWordsSentences() {
        const nb = window.DB?.loadNotebook?.() || [];
        return nb.filter(w => w.phonetic && w.context)
                 .map(w => ({
                     id       : `mw_${w.word}`,
                     word     : w.word,
                     phonetic : w.phonetic,
                     meaning  : w.meaning || '',
                     context  : w.context,
                     contextCn: w.contextCn || '',
                     // v73: surface focus tags so the Mine detail panel can
                     // render the per-word focus toggles in their correct
                     // active/inactive state without a second DB lookup.
                     focus    : Array.isArray(w.focus) ? [...w.focus] : []
                 }))
                 .sort((a, b) => a.word.localeCompare(b.word));
    }

    // ─── Render: Curated panel (40 hand-curated sentences) ───
    function renderCuratedPanel() {
        if (!curatedContainer) return;
        const progress  = loadProgress();
        const practiced = Object.keys(progress).length;
        const mastered  = Object.values(progress).filter(p => p.correct >= 2).length;

        curatedContainer.innerHTML = `
        <div class="ec-wrapper">
            <div class="sd-az-header-row sd-az-header-curated">
                <span class="sd-az-count-badge">${sentences.length}</span>
                <div class="sd-az-stats-inline">
                    <span class="ec-ts"><span class="ec-ts-num ec-practiced">${practiced}</span>&#x2705;</span>
                    <span class="ec-ts"><span class="ec-ts-num ec-mastered">${mastered}</span>&#x2B50;</span>
                    ${total > 0 ? `<span class="ec-ts">${score}/${total}</span>` : ''}
                </div>
                <button class="ec-btn-ghost sd-az-listen-btn" id="sd-c-listen-btn" title="Listen \u2014 auto-pronounce each sentence">&#x1F3A7;</button>
                <button class="ec-btn-primary sd-az-drill-btn" id="sd-c-drill-btn" title="Drill">&#x25B6;<span class="sd-btn-label"> Drill</span></button>
            </div>
            <div id="sd-c-exercise-area">
                ${renderCuratedGrid()}
            </div>
        </div>
        <div class="sd-float-detail" id="sd-c-float-detail"></div>`;

        curatedContainer.querySelector('#sd-c-drill-btn')?.addEventListener('click', () => {
            container = curatedContainer;
            stopListen();
            renderExercise();
        });
        curatedContainer.querySelector('#sd-c-listen-btn')?.addEventListener('click', () => {
            container = curatedContainer;
            setListenSource('curated');
            startListen();
        });
        bindCuratedEvents();
    }

    // Renders the 40 curated sentences as a grid of short excerpts
    // (first ~50 chars each). Tap a tile \u2192 bottom floating detail.
    function renderCuratedGrid() {
        if (sentences.length === 0) {
            return '<div class="sd-list-empty">(no curated sentences loaded)</div>';
        }
        const items = sentences.map((s, idx) => {
            const sp       = getSentenceProgress(s.id);
            const mastered = sp.correct >= 2;
            const preview  = truncate(s.sentence_en, 60);
            const active   = cDetailIdx === idx ? 'sd-c-tile-active' : '';
            return `
            <button class="sd-c-tile ${active}" type="button" data-idx="${idx}">
                <span class="sd-c-tile-num">${idx + 1}</span>
                <span class="sd-c-tile-text">${escHtml(preview)}</span>
                ${mastered ? '<span class="sd-c-tile-badge">\u2B50</span>' : ''}
            </button>`;
        }).join('');
        return `<div class="sd-c-grid">${items}</div>`;
    }

    function truncate(s, n) {
        if (!s) return '';
        return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
    }

    let curatedEventsBound = false;
    function bindCuratedEvents() {
        // v72: guard against duplicate listener accumulation. Without this,
        // every renderCuratedPanel() call (which can fire repeatedly when
        // navigating in/out of Listen/Drill) added a new click listener,
        // so a single tile tap fired N handlers in parallel.
        if (curatedEventsBound) return;
        curatedEventsBound = true;
        curatedContainer.addEventListener('click', (e) => {
            const tile = e.target.closest('.sd-c-tile');
            if (tile) {
                showCuratedDetail(parseInt(tile.dataset.idx, 10));
            }
        });
    }

    function showCuratedDetail(idx) {
        const s = sentences[idx];
        const panel = curatedContainer.querySelector('#sd-c-float-detail');
        const wasActive = cDetailIdx === idx;

        // Clear active tile states
        curatedContainer.querySelectorAll('.sd-c-tile.sd-c-tile-active').forEach(t => {
            t.classList.remove('sd-c-tile-active');
        });

        if (wasActive) {
            cDetailIdx = null;
            hideDetailPanel(panel);
            return;
        }
        cDetailIdx = idx;
        const tile = curatedContainer.querySelector(`.sd-c-tile[data-idx="${idx}"]`);
        tile?.classList.add('sd-c-tile-active');
        if (!s || !panel) return;

        const targetPills = (s.targets || []).map(t =>
            `<span class="sd-list-target">${escHtml(t.word)}</span>`
        ).join('');
        const total       = sentences.length;
        const prevDisabled = idx <= 0          ? 'disabled' : '';
        const nextDisabled = idx >= total - 1  ? 'disabled' : '';
        panel.innerHTML = `
            <div class="sd-mw-detail-inner">
                <button class="sd-float-close" type="button" title="Close">&#x2715;</button>
                <div class="sd-mw-detail-head">
                    <button class="sd-detail-nav sd-detail-prev" type="button" ${prevDisabled} title="Previous sentence">&#x25C0;</button>
                    <span class="sd-mw-detail-word">${idx + 1}/${total}</span>
                    <button class="sd-detail-nav sd-detail-next" type="button" ${nextDisabled} title="Next sentence">&#x25B6;</button>
                </div>
                <div class="sd-list-context">${escHtml(s.sentence_en)}</div>
                ${s.sentence_cn ? `<div class="sd-list-cn">${escHtml(s.sentence_cn)}</div>` : ''}
                ${targetPills ? `<div class="sd-list-targets">${targetPills}</div>` : ''}
                <div class="sd-list-actions">
                    <button class="sd-list-play ec-btn-ghost" data-text="${escAttr(s.sentence_en)}" type="button">\u{1F50A} Play</button>
                    <button class="sd-list-drill ec-btn-ghost" data-idx="${idx}" type="button">\u270F\uFE0F Drill this</button>
                </div>
            </div>`;
        showDetailPanel(panel);

        // Detail-pane navigation: jump to prev/next sentence without
        // returning to the list. The grid above also re-highlights so
        // the user can see where they are.
        panel.querySelector('.sd-detail-prev')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (idx > 0) navigateCuratedDetail(idx - 1);
        });
        panel.querySelector('.sd-detail-next')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (idx < total - 1) navigateCuratedDetail(idx + 1);
        });

        panel.querySelector('.sd-list-play')?.addEventListener('click', (e) => {
            e.stopPropagation();
            window.App?.speak?.(e.currentTarget.dataset.text);
        });
        panel.querySelector('.sd-list-drill')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const i = parseInt(e.currentTarget.dataset.idx, 10);
            if (isFinite(i)) {
                currentIdx = i;
                container = curatedContainer;
                saveState();
                stopListen();
                renderExercise();
            }
        });
        panel.querySelector('.sd-float-close')?.addEventListener('click', (e) => {
            e.stopPropagation();
            cDetailIdx = null;
            curatedContainer.querySelectorAll('.sd-c-tile.sd-c-tile-active').forEach(t => t.classList.remove('sd-c-tile-active'));
            hideDetailPanel(panel);
        });
    }

    // Helper: jump to a different sentence's detail without toggling off
    // first. Used by the detail-panel nav arrows. Updates active tile
    // highlight and re-renders the panel.
    function navigateCuratedDetail(newIdx) {
        if (newIdx < 0 || newIdx >= sentences.length) return;
        // Force re-render: reset cDetailIdx so showCuratedDetail's
        // "wasActive" guard treats this as a new selection.
        cDetailIdx = null;
        showCuratedDetail(newIdx);
        // Scroll the new active tile into view in the grid above so
        // the user can see where they are in the list.
        const newTile = curatedContainer.querySelector(`.sd-c-tile[data-idx="${newIdx}"]`);
        newTile?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // ─── Render: Mine panel (MyWords enriched sentences) ──────
    function renderMinePanel() {
        if (!mineContainer) return;
        const mwSentences = getMyWordsSentences();
        const count       = mwSentences.length;

        if (count === 0) {
            mineContainer.innerHTML = `
            <div class="ec-wrapper">
                <div class="sd-list-empty">Add enriched words (phonetic + example) in My Words to see them here.</div>
            </div>`;
            return;
        }

        const rangeCounts = buildRangeCounts(mwSentences);

        mineContainer.innerHTML = `
        <div class="ec-wrapper">
            <div class="sd-az-header-row">
                <span class="sd-az-count-badge" id="sd-m-count">${count}</span>
                <div class="sd-az-filter-inline">${renderRangeButtons(rangeCounts)}</div>
                <button class="ec-btn-ghost sd-az-listen-btn" id="sd-m-listen-btn" title="Listen \u2014 auto-pronounce each sentence">&#x1F3A7;</button>
            </div>
            <div class="sd-mw-grid" id="sd-m-grid">${renderMineGridItems(mwSentences)}</div>
        </div>
        <div class="sd-float-detail" id="sd-m-float-detail"></div>`;

        mineContainer.querySelector('#sd-m-listen-btn')?.addEventListener('click', () => {
            container = mineContainer;
            setListenSource('mywords');
            startListen();
        });
        bindMineEvents();
    }

    function renderMineGridItems(mwSentences) {
        const filtered = filterMWByRange(mwSentences);
        if (!filtered.length) {
            return `<div class="sd-list-empty">No words in range "${mwAZFilter || 'all'}".</div>`;
        }
        return filtered.map(w => `
            <button class="sd-mw-tile ${mwDetailWord === w.word ? 'sd-mw-tile-active' : ''}" type="button" data-word="${escAttr(w.word)}">
                ${escHtml(w.word)}
            </button>`).join('');
    }

    // Range filter (A-D, E-H, I-L, M-P, Q-T, U-Z).
    // mwAZFilter holds the range KEY (e.g. 'A-D') or null for "all".
    const LETTER_RANGES = [
        { key: 'A-D', letters: 'ABCD' },
        { key: 'E-H', letters: 'EFGH' },
        { key: 'I-L', letters: 'IJKL' },
        { key: 'M-P', letters: 'MNOP' },
        { key: 'Q-T', letters: 'QRST' },
        { key: 'U-Z', letters: 'UVWXYZ' }
    ];

    function buildRangeCounts(mwSentences) {
        const counts = { '#': 0 };
        LETTER_RANGES.forEach(r => counts[r.key] = 0);
        mwSentences.forEach(w => {
            const first = (w.word || '').charAt(0).toUpperCase();
            const r = LETTER_RANGES.find(r => r.letters.includes(first));
            if (r) counts[r.key]++;
            else   counts['#']++;
        });
        return counts;
    }

    function renderRangeButtons(counts) {
        const allActive = mwAZFilter == null ? 'sd-az-active' : '';
        let html = `<button class="sd-az-btn sd-az-all ${allActive}" data-range="" type="button">All</button>`;
        LETTER_RANGES.forEach(r => {
            const n = counts[r.key] || 0;
            const active = mwAZFilter === r.key ? 'sd-az-active' : '';
            const empty  = n === 0 ? 'sd-az-empty' : '';
            html += `<button class="sd-az-btn ${active} ${empty}" data-range="${r.key}" type="button" ${n === 0 ? 'disabled' : ''}>${r.key}<span class="sd-az-count">${n}</span></button>`;
        });
        if ((counts['#'] || 0) > 0) {
            const active = mwAZFilter === '#' ? 'sd-az-active' : '';
            html += `<button class="sd-az-btn ${active}" data-range="#" type="button">#<span class="sd-az-count">${counts['#']}</span></button>`;
        }
        return html;
    }

    // Back-compat wrapper — still used by rerenderMineGrid's outerHTML swap.
    function renderRangeFilter(counts) {
        return `<div class="sd-az-filter sd-az-ranges">${renderRangeButtons(counts)}</div>`;
    }

    function filterMWByRange(mwSentences) {
        if (!mwAZFilter) return mwSentences;
        if (mwAZFilter === '#') {
            return mwSentences.filter(w => {
                const c = (w.word || '').charAt(0).toUpperCase();
                return !(c >= 'A' && c <= 'Z');
            });
        }
        const r = LETTER_RANGES.find(r => r.key === mwAZFilter);
        if (!r) return mwSentences;
        return mwSentences.filter(w => r.letters.includes((w.word || '').charAt(0).toUpperCase()));
    }

    let mineEventsbound = false;
    function bindMineEvents() {
        // Avoid binding multiple click listeners. renderMinePanel runs every
        // time the user switches into Mine; without this guard, listeners
        // accumulate and click handlers fire multiple times.
        if (mineEventsbound) return;
        mineEventsbound = true;
        mineContainer.addEventListener('click', (e) => {
            const rangeBtn = e.target.closest('.sd-az-btn');
            if (rangeBtn && !rangeBtn.disabled) {
                mwAZFilter = rangeBtn.dataset.range || null;
                mwDetailWord = null;
                rerenderMineGrid();
                return;
            }
            const tile = e.target.closest('.sd-mw-tile');
            if (tile) {
                console.log('[SentenceDrill] Mine tile clicked:', tile.dataset.word);
                showMineDetail(tile);
            }
        });
    }

    function rerenderMineGrid() {
        const mwSentences = getMyWordsSentences();
        // Update just the A-Z filter buttons (preserve the inline header row)
        const bar = mineContainer.querySelector('.sd-az-filter-inline');
        if (bar) bar.innerHTML = renderRangeButtons(buildRangeCounts(mwSentences));
        // Update count badge to reflect current filter
        const countEl = mineContainer.querySelector('#sd-m-count');
        if (countEl) countEl.textContent = String(mwSentences.length);
        // Update the grid
        const grid = mineContainer.querySelector('#sd-m-grid');
        if (grid) grid.innerHTML = renderMineGridItems(mwSentences);
        // Close any open detail since the shown word may no longer be visible
        const panel = mineContainer.querySelector('#sd-m-float-detail');
        hideDetailPanel(panel);
    }

    function showMineDetail(tile) {
        const word  = tile.dataset.word;
        const panel = mineContainer.querySelector('#sd-m-float-detail');
        const wasActive = tile.classList.contains('sd-mw-tile-active');
        console.log('[SentenceDrill] showMineDetail:', word, 'panel found:', !!panel, 'wasActive:', wasActive);

        mineContainer.querySelectorAll('.sd-mw-tile.sd-mw-tile-active').forEach(t => {
            t.classList.remove('sd-mw-tile-active');
        });

        if (wasActive) {
            mwDetailWord = null;
            hideDetailPanel(panel);
            return;
        }

        tile.classList.add('sd-mw-tile-active');
        mwDetailWord = word;

        // v70: auto-pronounce the word on click. Fires only on OPEN
        // (the wasActive early-return above already covered toggling
        // off, and navigateMineDetail clears the active class before
        // re-entering this function so prev/next nav also lands here
        // and pronounces the new word).
        try { window.App?.speak?.(word); } catch {}

        if (!panel) {
            console.warn('[SentenceDrill] #sd-m-float-detail not found in mineContainer!');
            return;
        }

        const mwSentences = getMyWordsSentences();
        const w   = mwSentences.find(x => x.word === word);
        const idx = mwSentences.findIndex(x => x.word === word);
        if (!w) return;

        const total = mwSentences.length;
        const prevDisabled = idx <= 0         ? 'disabled' : '';
        const nextDisabled = idx >= total - 1 ? 'disabled' : '';
        // v73: focus state for the per-word group toggles in the action row.
        const wFocus = Array.isArray(w.focus) ? w.focus : [];
        const focusActive = (t) => wFocus.includes(t) ? 'sd-mw-focus-active' : '';
        panel.innerHTML = `
            <div class="sd-mw-detail-inner">
                <button class="sd-float-close" type="button" title="Close">&#x2715;</button>
                <div class="sd-mw-detail-head">
                    <button class="sd-detail-nav sd-detail-prev" type="button" ${prevDisabled} title="Previous word">&#x25C0;</button>
                    <span class="sd-mw-detail-counter">${idx + 1}/${total}</span>
                    <button class="sd-detail-nav sd-detail-next" type="button" ${nextDisabled} title="Next word">&#x25B6;</button>
                </div>
                <div class="sd-mw-detail-title">
                    <span class="sd-mw-detail-word">${escHtml(w.word)}</span>
                    <span class="sd-mw-detail-phon">${escHtml(w.phonetic)}</span>
                </div>
                ${w.meaning ? `<div class="sd-list-meaning">${escHtml(w.meaning)}</div>` : ''}
                <div class="sd-list-context">
                    <button class="speak-btn sd-context-speak" data-text="${escAttr(w.context)}" type="button" title="Play sentence">&#x1F50A;</button><span class="sd-context-text">${escHtml(w.context)}</span>
                </div>
                ${w.contextCn ? `<div class="sd-list-cn">${escHtml(w.contextCn)}</div>` : ''}
                <div class="sd-list-actions">
                    <button class="sd-mw-focus-btn ${focusActive('core')}"          data-focus="core"          data-word="${escAttr(w.word)}" type="button" title="Mark as Core focus">\u2B50 Core</button>
                    <button class="sd-mw-focus-btn ${focusActive('pronunciation')}" data-focus="pronunciation" data-word="${escAttr(w.word)}" type="button" title="Mark as Pronunciation focus">\u{1F50A} Pron</button>
                    <button class="sd-mw-focus-btn ${focusActive('spelling')}"      data-focus="spelling"      data-word="${escAttr(w.word)}" type="button" title="Mark as Spelling focus">\u270F\uFE0F Spell</button>
                </div>
            </div>`;
        showDetailPanel(panel);

        // Detail nav: jump to next/prev word's detail without returning
        // to the grid. Uses the mwSentences array index, which is a
        // flat list of MyWords words that have phonetic+context.
        panel.querySelector('.sd-detail-prev')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (idx > 0) navigateMineDetail(mwSentences[idx - 1].word);
        });
        panel.querySelector('.sd-detail-next')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (idx < total - 1) navigateMineDetail(mwSentences[idx + 1].word);
        });

        // v74: the inline .speak-btn before the sentence is handled by the
        // global delegated handler in app.js (.speak-btn[data-text]), so we
        // no longer need a per-panel binding for the playback buttons. The
        // word itself auto-pronounces when the tile is tapped (see v70).

        // v73: per-word focus toggles. Tap to add/remove the current word
        // from a study group (Core / Pron / Spell). The filter pill counts
        // in the My Words tab refresh next time that view renders, so we
        // only need to flip the local visual state here.
        panel.querySelectorAll('.sd-mw-focus-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tWord = e.currentTarget.dataset.word;
                const tType = e.currentTarget.dataset.focus;
                if (!tWord || !tType) return;
                const isOn = window.DB?.toggleFocus?.(tWord, tType);
                e.currentTarget.classList.toggle('sd-mw-focus-active', !!isOn);
                const labels = { core: '\u2B50 Core', pronunciation: '\u{1F50A} Pron', spelling: '\u270F\uFE0F Spell' };
                window.App?.showToast?.(isOn
                    ? `"${tWord}" added to ${labels[tType] || tType}.`
                    : `"${tWord}" removed from ${labels[tType] || tType}.`);
                // Push the change through to the My Words view so its filter
                // pill counts and study list pick up the new state on next
                // activation. Safe-call because My Words may not be ready.
                try { window.MyWords?.refreshStudyList?.(); } catch {}
            });
        });
        panel.querySelector('.sd-float-close')?.addEventListener('click', (e) => {
            e.stopPropagation();
            mwDetailWord = null;
            mineContainer.querySelectorAll('.sd-mw-tile.sd-mw-tile-active').forEach(t => t.classList.remove('sd-mw-tile-active'));
            hideDetailPanel(panel);
        });
    }

    // Helper for Mine detail nav. Find the tile for the new word and
    // call showMineDetail on it. Resets active class so the toggle
    // logic doesn't treat the new word as a re-tap on the same tile.
    function navigateMineDetail(newWord) {
        if (!mineContainer || !newWord) return;
        const newTile = mineContainer.querySelector(`.sd-mw-tile[data-word="${cssEscape(newWord)}"]`);
        if (!newTile) return;
        // Clear active state so showMineDetail's "wasActive" guard
        // treats this as a fresh selection.
        mineContainer.querySelectorAll('.sd-mw-tile.sd-mw-tile-active').forEach(t => t.classList.remove('sd-mw-tile-active'));
        mwDetailWord = null;
        showMineDetail(newTile);
        newTile.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // CSS.escape with a simple fallback for older WebViews.
    function cssEscape(s) {
        if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
        return String(s).replace(/[^a-zA-Z0-9_-]/g, c => '\\' + c);
    }

    // ─── Render exercise card ────────────────────────────────
    function renderExercise() {
        // Drill lives in the Curated panel, not Mine
        container = curatedContainer;
        const area = container?.querySelector('#sd-c-exercise-area');
        if (!area || sentences.length === 0) return;

        const s       = sentences[currentIdx];
        if (!s) return;
        const targets = s.targets || [];
        const sp      = getSentenceProgress(s.id);
        answered      = false;
        filledSlots   = new Array(targets.length).fill(null);

        // Build sentence with blanked targets
        let sentenceHtml = escHtml(s.sentence_en);
        // Replace target words with slots (case-insensitive, whole word)
        const slotMap = []; // track which slot index maps to which target
        targets.forEach((t, i) => {
            // Escape regex special chars in the word
            const escaped = t.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex   = new RegExp(`\\b${escaped}\\b`, 'i');
            const match   = sentenceHtml.match(regex);
            if (match) {
                const slot = `<span class="ec-slot" data-slot="${i}"><span class="ec-slot-num">${i + 1}</span></span>`;
                sentenceHtml = sentenceHtml.replace(regex, slot);
                slotMap.push(i);
            }
        });

        // Word bank from options_pool (already includes correct + distractors)
        const pool      = s.options_pool || targets.map(t => t.word);
        const bankWords = shuffle([...pool]).map((w, i) => ({
            word : w,
            id   : `sd-chip-${i}`
        }));

        area.innerHTML = `
        <div class="ec-card">
            <div class="ec-card-top">
                <span class="ec-card-cat" style="background:var(--accent-bg);color:var(--accent)">
                    &#x1F4DD; Sentence ${currentIdx + 1}/${sentences.length}
                </span>
                <div class="ec-card-nav-inline">
                    <button class="ec-nav-btn" id="sd-prev" ${currentIdx <= 0 ? 'disabled' : ''}>&#x25C0;</button>
                    <span class="ec-nav-counter">${currentIdx + 1}/${sentences.length}</span>
                    <button class="ec-nav-btn" id="sd-next">&#x25B6;</button>
                </div>
                <span class="ec-card-progress">
                    ${sp.correct >= 2 ? '&#x2B50;' : sp.attempts > 0 ? `${sp.correct}/${sp.attempts}` : ''}
                </span>
                <button class="ec-nav-btn sd-drill-exit" id="sd-drill-exit" title="Back to list">&#x2715;</button>
            </div>

            <div class="ec-exercise ec-fill">
                <div class="ec-prompt-label">Fill in the blanks (${targets.length} words):</div>
                <div class="ec-fill-sentence" id="sd-sentence">${sentenceHtml}</div>
                <div class="ec-word-bank" id="sd-word-bank">
                    ${bankWords.map(w => `
                        <button class="ec-chip" data-chip-id="${w.id}" data-word="${escAttr(w.word)}">${escHtml(w.word)}</button>
                    `).join('')}
                </div>
                <button class="ec-btn-primary ec-check-btn" id="sd-check">Check</button>
                <div class="ec-result" id="sd-result"></div>
            </div>

            <div class="ec-context-hint">
                <div class="ec-hint-label">&#x1F4A1; Chinese:</div>
                <div class="ec-hint-text">${escHtml(s.sentence_cn)}</div>
            </div>

            <div class="ec-card-nav">
                <button class="ec-btn-ghost" id="sd-reveal">&#x1F441; Show Answer</button>
            </div>
        </div>`;

        // Bind events
        area.querySelectorAll('.ec-chip').forEach(chip => {
            chip.addEventListener('click', () => handleChip(chip, area));
        });
        area.querySelector('#sd-sentence')?.addEventListener('click', (e) => {
            const slot = e.target.closest('.ec-slot-filled');
            if (slot && !answered) handleSlotRemove(slot, area);
        });
        area.querySelector('#sd-check')?.addEventListener('click', () => checkAnswer(area));
        area.querySelector('#sd-reveal')?.addEventListener('click', () => revealAnswer(area));
        area.querySelector('#sd-prev')?.addEventListener('click', () => { currentIdx = Math.max(0, currentIdx - 1); saveState(); renderExercise(); });
        area.querySelector('#sd-next')?.addEventListener('click', () => { currentIdx = Math.min(sentences.length - 1, currentIdx + 1); saveState(); renderExercise(); });
        area.querySelector('#sd-drill-exit')?.addEventListener('click', () => {
            renderCuratedPanel();
        });
    }

    // ─── Chip click → fill slot ──────────────────────────────
    function handleChip(chip, area) {
        if (chip.disabled || answered) return;
        const word     = chip.dataset.word;
        const emptyIdx = filledSlots.indexOf(null);
        if (emptyIdx === -1) return;

        filledSlots[emptyIdx] = { word, chipId: chip.dataset.chipId };
        chip.classList.add('ec-chip-used');
        chip.disabled = true;

        const slot = area.querySelector(`.ec-slot[data-slot="${emptyIdx}"]`);
        if (slot) {
            slot.innerHTML = `<span class="ec-slot-word">${escHtml(word)}</span>`;
            slot.classList.add('ec-slot-filled');
        }
        area.querySelectorAll('.ec-slot-wrong').forEach(s => s.classList.remove('ec-slot-wrong'));
    }

    // ─── Slot click → return chip ────────────────────────────
    function handleSlotRemove(slot, area) {
        const idx = parseInt(slot.dataset.slot);
        if (filledSlots[idx] === null) return;

        const chipId = filledSlots[idx].chipId;
        const chip   = area.querySelector(`[data-chip-id="${chipId}"]`);
        if (chip) { chip.classList.remove('ec-chip-used'); chip.disabled = false; }

        filledSlots[idx] = null;
        slot.innerHTML = `<span class="ec-slot-num">${idx + 1}</span>`;
        slot.classList.remove('ec-slot-filled', 'ec-slot-correct', 'ec-slot-wrong');
    }

    // ─── Check answer ────────────────────────────────────────
    function checkAnswer(area) {
        if (answered) return;
        const s       = sentences[currentIdx];
        const targets = s.targets || [];
        let allFilled  = true;
        let allCorrect = true;

        filledSlots.forEach((entry, i) => {
            const slot = area.querySelector(`.ec-slot[data-slot="${i}"]`);
            if (!slot) return;

            if (!entry) {
                allFilled = false; allCorrect = false;
                slot.classList.add('ec-slot-wrong');
                return;
            }

            const expected = (targets[i]?.word || '').toLowerCase();
            const actual   = entry.word.toLowerCase();
            const correct  = actual === expected;
            slot.classList.remove('ec-slot-correct', 'ec-slot-wrong');
            slot.classList.add(correct ? 'ec-slot-correct' : 'ec-slot-wrong');
            if (!correct) allCorrect = false;
        });

        const resultEl = area.querySelector('#sd-result');
        if (!allFilled) {
            resultEl.innerHTML = `<div class="ec-result-wrong">Fill all blanks first.</div>`;
            return;
        }

        answered = true;
        total++;
        if (allCorrect) score++;
        markSentenceResult(s.id, allCorrect);

        // Disable further interaction
        area.querySelectorAll('.ec-chip').forEach(c => c.disabled = true);
        area.querySelectorAll('.ec-slot').forEach(sl => sl.style.pointerEvents = 'none');

        if (allCorrect) {
            resultEl.innerHTML = `
                <div class="ec-result-correct">&#x2705; Correct!</div>
                ${renderTargetDetails(targets)}
                ${renderSaveButtons(targets)}
                <button class="ec-btn-primary ec-next-btn" style="margin-top:6px">Next &#x2192;</button>`;
        } else {
            resultEl.innerHTML = `
                <div class="ec-result-wrong">&#x274C; Not quite.</div>
                ${renderTargetDetails(targets)}
                ${renderSaveButtons(targets)}
                <button class="ec-btn-primary ec-next-btn" style="margin-top:6px">Next &#x2192;</button>`;
        }

        resultEl.querySelector('.ec-next-btn')?.addEventListener('click', () => {
            currentIdx = Math.min(sentences.length - 1, currentIdx + 1);
            saveState();
            renderExercise();
        });
        bindSaveButtons(resultEl);
        saveState();
        updateStats();
    }

    // ─── Reveal answer ───────────────────────────────────────
    function revealAnswer(area) {
        const s       = sentences[currentIdx];
        const targets = s.targets || [];
        answered = true;

        const resultEl = area.querySelector('#sd-result');
        resultEl.innerHTML = `
            <div class="ec-result-reveal">
                <div class="ec-reveal-label">Answers:</div>
                <div>
                    ${targets.map((t, i) => `<span class="ec-reveal-chip">(${i + 1}) ${escHtml(t.word)}</span>`).join(' ')}
                </div>
            </div>
            ${renderTargetDetails(targets)}
            ${renderSaveButtons(targets)}
            <button class="ec-btn-primary ec-next-btn" style="margin-top:6px">Next &#x2192;</button>`;

        resultEl.querySelector('.ec-next-btn')?.addEventListener('click', () => {
            currentIdx = Math.min(sentences.length - 1, currentIdx + 1);
            saveState();
            renderExercise();
        });
        bindSaveButtons(resultEl);

        area.querySelectorAll('.ec-chip').forEach(c => c.disabled = true);
    }

    // ─── Render target word details ──────────────────────────
    function renderTargetDetails(targets) {
        return `<div class="sd-target-details">
            ${targets.map(t => `
                <div class="sd-target-item">
                    <strong>${escHtml(t.word)}</strong>
                    <span class="sd-phonetic">${escHtml(t.phonetic || '')}</span>
                    <span class="sd-meaning">${escHtml(t.meaning || '')}</span>
                    ${t.collo && t.collo !== '-' ? `<span class="sd-collo">${escHtml(t.collo)}</span>` : ''}
                </div>
            `).join('')}
        </div>`;
    }

    // ─── Save to Notebook buttons ────────────────────────────
    function renderSaveButtons(targets) {
        return `<div class="sd-save-row">
            ${targets.map(t => `
                <button class="ec-btn-secondary sd-save-word" data-word="${escAttr(t.word)}"
                        data-meaning="${escAttr(t.meaning || '')}"
                        data-phonetic="${escAttr(t.phonetic || '')}"
                        data-collo="${escAttr(t.collo || '')}"
                        style="font-size:0.75rem;padding:3px 8px">
                    &#x1F4D5; ${escHtml(t.word)}
                </button>
            `).join('')}
        </div>`;
    }

    function bindSaveButtons(el) {
        el.querySelectorAll('.sd-save-word').forEach(btn => {
            btn.addEventListener('click', () => {
                window.DB?.upsertNotebookWord?.({
                    word     : btn.dataset.word,
                    meaning  : btn.dataset.meaning,
                    phonetic : btn.dataset.phonetic,
                    collo    : btn.dataset.collo,
                    source   : 'Sentence Drill'
                });
                btn.innerHTML = '&#x2705; Saved';
                btn.disabled  = true;
                window.App?.updateNotebookBadge?.();
                window.App?.showToast?.(`Saved: ${btn.dataset.word}`);
            });
        });
    }

    // ─── Update stats display ────────────────────────────────
    function updateStats() {
        const progress  = loadProgress();
        const practiced = Object.keys(progress).length;
        const mastered  = Object.values(progress).filter(p => p.correct >= 2).length;
        const pEl = container?.querySelector('#sd-practiced');
        const mEl = container?.querySelector('#sd-mastered');
        if (pEl) pEl.textContent = practiced;
        if (mEl) mEl.textContent = mastered;
    }

    // ─── Utilities ───────────────────────────────────────────
    // ═════════════════════════════════════════════════════════
    //  LISTEN MODE — auto-pronounce every sentence in sequence
    // ═════════════════════════════════════════════════════════
    // Playback loop per sentence:
    //   1. English at Listen base rate (0.95)
    //   2. Pause 600ms
    //   3. English at 0.80x of base rate (slow immersion)
    //   4. Pause 600ms
    //   5. Chinese via zh-CN voice  (optional — toggled via pref 'sd_listen_cn')
    //   6. Pause 1000ms, then auto-advance to next sentence
    // Loops back to sentence 1 after the last one.
    //
    // Listen mode ignores the global speech_speed pref (which is tuned
    // for single-word vocab playback where 0.85 is easier to catch)
    // and uses rates chosen specifically for sentence-level prosody —
    // slower rates amplify the mechanical inter-comma pauses that the
    // Web Speech API produces, so we stay closer to natural speed.

    const LISTEN_PAUSE_MID  = 600;
    const LISTEN_PAUSE_NEXT = 1000;
    const LISTEN_SLOW_MULT  = 0.80;  // "slow" phase is 80% of base rate

    // Unified speed: Listen mode uses the same global 'speech_speed'
    // pref as MyWords autoplay. One slider in Settings controls both.
    function getListenRate() {
        const v = parseFloat(window.DB?.getPref?.('speech_speed', '0.9'));
        return (isFinite(v) && v >= 0.5 && v <= 1.5) ? v : 0.9;
    }

    function isListenCNEnabled() {
        return window.DB?.getPref?.('sd_listen_cn', 'false') === 'true';
    }
    function setListenCNEnabled(on) {
        window.DB?.setPref?.('sd_listen_cn', on ? 'true' : 'false');
    }

    // Listen source: which pool to auto-play through.
    //   'curated'  — the 40 hand-written sentences (default)
    //   'mywords'  — sentences pulled from enriched My Words entries
    //   'both'     — curated first, then MyWords
    function getListenSource() {
        const v = window.DB?.getPref?.('sd_listen_source', 'curated');
        return ['curated', 'mywords', 'both'].includes(v) ? v : 'curated';
    }
    function setListenSource(src) {
        if (['curated', 'mywords', 'both'].includes(src)) {
            window.DB?.setPref?.('sd_listen_source', src);
        }
    }

    // Returns the active pool of sentences for Listen mode, normalized to
    // {sentence_en, sentence_cn}. Curated already fits this shape; MyWords
    // entries are adapted from their {context, contextCn} fields.
    function getListenPool() {
        const src = getListenSource();
        const curated = sentences.map(s => ({
            sentence_en: s.sentence_en,
            sentence_cn: s.sentence_cn || ''
        }));
        const mw = getMyWordsSentences().map(w => ({
            sentence_en: w.context,
            sentence_cn: w.contextCn || ''
        }));
        if (src === 'mywords') return mw;
        if (src === 'both')    return [...curated, ...mw];
        return curated;
    }

    function startListen() {
        if (listenActive) return;
        const pool = getListenPool();
        if (pool.length === 0) {
            window.App?.showToast?.('No sentences available for this source.');
            return;
        }
        // Restore last position from saved state if available (clamped to pool)
        const state = loadState();
        listenIdx    = Math.min(Math.max(0, state.idx || 0), pool.length - 1);
        listenActive = true;
        listenPaused = false;
        listenToken++;
        acquireWakeLock();   // keep screen on while listen loop runs
        renderListenView();
        playListenLoop(listenToken);
    }

    function stopListen() {
        listenActive = false;
        listenPaused = false;
        listenPhase  = 'idle';
        listenToken++;  // invalidate any pending callbacks
        if (listenTimer) { clearTimeout(listenTimer); listenTimer = null; }
        window.App?.stopSpeak?.();
        releaseWakeLock();   // let the screen sleep again
    }

    // --- Screen Wake Lock --------------------------------------------
    // Prevents the phone's screen from auto-dimming/locking during
    // listen sessions. Without this, Chrome/Safari suspend the tab when
    // the screen goes dark and TTS stops mid-session. Mirrors the
    // my-words.js autoplay implementation so behavior is consistent.
    async function acquireWakeLock() {
        if (!('wakeLock' in navigator)) {
            console.log('[Listen] Wake Lock API not supported — screen may dim during playback');
            return;
        }
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('[Listen] Screen wake lock acquired');
            wakeLock.addEventListener('release', () => {
                console.log('[Listen] Wake lock released by system');
                wakeLock = null;
            });
        } catch (err) {
            console.warn('[Listen] Wake lock request failed:', err.message);
            wakeLock = null;
        }
    }

    async function releaseWakeLock() {
        if (!wakeLock) return;
        try {
            await wakeLock.release();
        } catch (err) {
            console.warn('[Listen] Wake lock release failed:', err.message);
        }
        wakeLock = null;
    }

    // Re-acquire wake lock if the user switches tabs/apps and comes back
    // while listen mode is still running. The browser auto-releases on hide.
    document.addEventListener('visibilitychange', () => {
        if (listenActive && !listenPaused && !document.hidden && !wakeLock) {
            acquireWakeLock();
        }
    });

    function pauseListen() {
        listenPaused = true;
        listenToken++;  // cancel in-flight utterance callbacks
        if (listenTimer) { clearTimeout(listenTimer); listenTimer = null; }
        window.App?.stopSpeak?.();
        updateListenControls();
    }

    function resumeListen() {
        if (!listenActive || !listenPaused) return;
        listenPaused = false;
        listenToken++;
        updateListenControls();
        playListenLoop(listenToken);
    }

    function nextListen() {
        if (!listenActive) return;
        const pool = getListenPool();
        if (pool.length === 0) return;
        listenIdx = (listenIdx + 1) % pool.length;
        currentIdx = Math.min(listenIdx, sentences.length - 1);  // keep drill idx in valid range
        saveState();
        listenToken++;
        if (listenTimer) { clearTimeout(listenTimer); listenTimer = null; }
        window.App?.stopSpeak?.();
        renderListenView();
        if (!listenPaused) playListenLoop(listenToken);
    }

    function prevListen() {
        if (!listenActive) return;
        const pool = getListenPool();
        if (pool.length === 0) return;
        listenIdx = (listenIdx - 1 + pool.length) % pool.length;
        currentIdx = Math.min(listenIdx, sentences.length - 1);
        saveState();
        listenToken++;
        if (listenTimer) { clearTimeout(listenTimer); listenTimer = null; }
        window.App?.stopSpeak?.();
        renderListenView();
        if (!listenPaused) playListenLoop(listenToken);
    }

    function restartCurrent() {
        if (!listenActive) return;
        listenToken++;
        if (listenTimer) { clearTimeout(listenTimer); listenTimer = null; }
        window.App?.stopSpeak?.();
        if (!listenPaused) playListenLoop(listenToken);
    }

    // Cycle through sources on tap. Called from the Listen controls.
    function cycleListenSource() {
        const order = ['curated', 'mywords', 'both'];
        const cur   = getListenSource();
        const next  = order[(order.indexOf(cur) + 1) % order.length];
        setListenSource(next);
        // Reset index when pool changes to avoid out-of-bounds playback
        const pool = getListenPool();
        listenIdx  = Math.min(listenIdx, Math.max(0, pool.length - 1));
        if (listenActive) {
            listenToken++;
            if (listenTimer) { clearTimeout(listenTimer); listenTimer = null; }
            window.App?.stopSpeak?.();
            renderListenView();
            if (!listenPaused) playListenLoop(listenToken);
        }
    }

    // Core playback loop. Uses a token so that if the user hits
    // Pause/Next/Prev mid-utterance, the stale onEnd callback from the
    // old utterance sees myToken !== listenToken and returns silently.
    function playListenLoop(myToken) {
        if (!listenActive || listenPaused || myToken !== listenToken) return;
        const pool = getListenPool();
        const s = pool[listenIdx];
        if (!s) { stopListen(); return; }

        const baseRate = getListenRate();
        const slowRate = baseRate * LISTEN_SLOW_MULT;
        const cnOn     = isListenCNEnabled();

        // Advance helper — runs after the English playback finishes,
        // and optionally plays Chinese before moving to the next sentence.
        const advanceToNext = () => {
            if (myToken !== listenToken || !listenActive || listenPaused) return;
            const poolNow = getListenPool();
            listenIdx = (listenIdx + 1) % poolNow.length;
            currentIdx = Math.min(listenIdx, sentences.length - 1);
            saveState();
            renderListenView();
            playListenLoop(myToken);
        };

        // Phase 1: English at normal speed
        listenPhase = 'en-normal';
        updateListenPhaseIndicator();
        window.App?.speak?.(s.sentence_en, baseRate, () => {
            if (myToken !== listenToken || !listenActive || listenPaused) return;
            listenTimer = setTimeout(() => {
                if (myToken !== listenToken || !listenActive || listenPaused) return;

                // Phase 2: English at 0.80x slow
                listenPhase = 'en-slow';
                updateListenPhaseIndicator();
                window.App?.speak?.(s.sentence_en, slowRate, () => {
                    if (myToken !== listenToken || !listenActive || listenPaused) return;
                    listenTimer = setTimeout(() => {
                        if (myToken !== listenToken || !listenActive || listenPaused) return;

                        // Phase 3: Chinese — only if toggle is on
                        if (!cnOn) {
                            advanceToNext();
                            return;
                        }
                        listenPhase = 'zh';
                        updateListenPhaseIndicator();
                        window.App?.speak?.(s.sentence_cn, baseRate, () => {
                            if (myToken !== listenToken || !listenActive || listenPaused) return;
                            listenTimer = setTimeout(advanceToNext, LISTEN_PAUSE_NEXT);
                        }, { lang: 'zh-CN' });
                    }, LISTEN_PAUSE_MID);
                });
            }, LISTEN_PAUSE_MID);
        });
    }

    // ─── Listen-mode UI ──────────────────────────────────────
    // Listen mode takes over the entire active panel (either Curated or
    // Mine, whichever started it). On exit we re-render that same panel
    // so the user returns to the view they came from.
    function renderListenView() {
        if (!container) return;
        const pool = getListenPool();
        const s = pool[listenIdx];
        if (!s) return;
        const src      = getListenSource();
        const srcLabel = {curated: '\u{1F4D8} Curated', mywords: '\u{1F4DA} My Words', both: '\u{1F500} Both'}[src];

        container.innerHTML = `
        <div class="ec-wrapper">
        <div class="ec-card sd-listen-card">
            <div class="ec-card-top sd-listen-top">
                <span class="ec-card-cat sd-listen-badge" style="background:var(--accent-bg);color:var(--accent)">
                    &#x1F3A7; ${listenIdx + 1}/${pool.length}
                </span>
                <button class="sd-listen-source-btn" id="sd-listen-source" title="Switch source (Curated / My Words / Both)">${srcLabel}</button>
                <span id="sd-listen-phase" class="sd-listen-phase">&#x1F50A; EN</span>
            </div>

            <div class="sd-listen-sentence" id="sd-listen-en">${escHtml(s.sentence_en)}</div>
            <div class="sd-listen-cn ${isListenCNEnabled() ? '' : 'sd-listen-cn-muted'}" id="sd-listen-cn">${escHtml(s.sentence_cn || '')}</div>

            <div class="sd-listen-controls">
                <button class="sd-listen-ctrl" id="sd-listen-prev" title="Previous">&#x23EE;</button>
                <button class="sd-listen-ctrl sd-listen-playpause" id="sd-listen-playpause" title="Pause / Resume">
                    ${listenPaused ? '&#x25B6;' : '&#x23F8;'}
                </button>
                <button class="sd-listen-ctrl" id="sd-listen-restart" title="Replay current sentence">&#x21BB;</button>
                <button class="sd-listen-ctrl" id="sd-listen-next" title="Next">&#x23ED;</button>
                <button class="sd-listen-ctrl sd-listen-cn-toggle ${isListenCNEnabled() ? 'sd-listen-cn-on' : ''}"
                        id="sd-listen-cn-btn"
                        title="Toggle Chinese pronunciation">
                    \u4E2D${isListenCNEnabled() ? '' : '\u00D7'}
                </button>
                <button class="sd-listen-ctrl sd-listen-exit" id="sd-listen-exit" title="Exit listen mode">&#x2715;</button>
            </div>
        </div>
        </div>`;

        container.querySelector('#sd-listen-playpause')?.addEventListener('click', () => {
            if (listenPaused) resumeListen(); else pauseListen();
        });
        container.querySelector('#sd-listen-prev')?.addEventListener('click', prevListen);
        container.querySelector('#sd-listen-next')?.addEventListener('click', nextListen);
        container.querySelector('#sd-listen-restart')?.addEventListener('click', restartCurrent);
        container.querySelector('#sd-listen-cn-btn')?.addEventListener('click', toggleListenCN);
        container.querySelector('#sd-listen-source')?.addEventListener('click', cycleListenSource);
        container.querySelector('#sd-listen-exit')?.addEventListener('click', () => {
            stopListen();
            // Restore the panel we came from
            if (container === curatedContainer) renderCuratedPanel();
            else if (container === mineContainer) renderMinePanel();
        });
    }

    function toggleListenCN() {
        const next = !isListenCNEnabled();
        setListenCNEnabled(next);
        // Re-render the controls so the button label flips immediately.
        // Does NOT interrupt current playback — the new setting applies
        // on the NEXT sentence (or immediately if we're past Phase 2).
        const btn = container?.querySelector('#sd-listen-cn-btn');
        if (btn) {
            btn.classList.toggle('sd-listen-cn-on', next);
            btn.innerHTML = `\u4E2D${next ? '' : '\u00D7'}`;
        }
        const cnEl = container?.querySelector('#sd-listen-cn');
        if (cnEl) cnEl.classList.toggle('sd-listen-cn-muted', !next);
        // If CN was just turned off and we're currently in the Chinese
        // phase, cancel the rest of this sentence and advance.
        if (!next && listenPhase === 'zh' && listenActive && !listenPaused) {
            listenToken++;
            if (listenTimer) { clearTimeout(listenTimer); listenTimer = null; }
            window.App?.stopSpeak?.();
            // v72: use the ACTIVE listen pool — could be curated, MyWords,
            // or both. Modulo by sentences.length is wrong when source is
            // 'mywords' or 'both' (different pool length), and would either
            // skip past the end or land on a non-existent index.
            const pool = getListenPool();
            if (!pool.length) { stopListen(); return; }
            listenIdx = (listenIdx + 1) % pool.length;
            currentIdx = Math.min(listenIdx, sentences.length - 1);
            saveState();
            renderListenView();
            playListenLoop(listenToken);
        }
    }

    function updateListenPhaseIndicator() {
        const el = container?.querySelector('#sd-listen-phase');
        if (!el) return;
        const labels = {
            'en-normal' : '\u{1F50A} EN',
            'en-slow'   : '\u{1F40C} EN slow',
            'zh'        : '\u{1F1E8}\u{1F1F3} CN',
            'idle'      : ''
        };
        el.innerHTML = labels[listenPhase] || '';

        // Visually highlight which block is active
        const en = container?.querySelector('#sd-listen-en');
        const cn = container?.querySelector('#sd-listen-cn');
        if (en) en.classList.toggle('sd-listen-active', listenPhase === 'en-normal' || listenPhase === 'en-slow');
        if (cn) cn.classList.toggle('sd-listen-active', listenPhase === 'zh');
    }

    function updateListenControls() {
        const btn = container?.querySelector('#sd-listen-playpause');
        if (btn) btn.innerHTML = listenPaused ? '&#x25B6;' : '&#x23F8;';
    }

    // ═════════════════════════════════════════════════════════

    function shuffle(arr) {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }
    function escHtml(s) {
        if (!s) return '';
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function escAttr(s) {
        return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    return {
        initCurated,
        initMine,
        // Legacy alias so any external code expecting .init() still works
        init: initCurated,
        stopListen,
        isListenActive: () => listenActive
    };
})();
