// ============================================================
// my-words.js — Word Study Module
// Modes: Browse (toggle CN) | Quiz (Chinese MCQ)
// ============================================================

window.MyWords = (function() {

    let currentIdx   = 0;
    let studyList    = [];
    let isEnriching  = false;
    let studyMode    = 'browse';
    let viewMode     = 'cards';
    let showChinese  = false;
    let quizScore    = 0;
    let quizTotal    = 0;
    let quizAnswered = false;
    let currentGroup = 0;
    let studyFilter  = 'all'; // 'all' | 'core' | 'pronunciation' | 'spelling'

    // --- Autoplay state ---
    let autoplayOn      = false;
    let autoplayTimer   = null;  // timeout id for next-word scheduling
    let autoplayToken   = 0;     // increments on every stop; callbacks check this to abort
    let autoplayWithEx  = true;  // speak example sentence after the word
    let wakeLock        = null;  // Screen Wake Lock sentinel while autoplay runs

    // --- Progress persistence (per-filter) ---
    function saveProgress() {
        // Guard against writing bad values. currentGroup or currentIdx can
        // transiently go to -1 if studyList was empty at a bad moment; we
        // don't want to persist that to localStorage (it would freeze the
        // UI on subsequent loads until a manual reset).
        const safeIdx   = Math.max(0, currentIdx   | 0);
        const safeGroup = Math.max(0, currentGroup | 0);
        const data = { idx: safeIdx, group: safeGroup, mode: studyMode, view: viewMode,
                       qScore: quizScore, qTotal: quizTotal, filter: studyFilter };
        window.DB.setPref('mw_progress', JSON.stringify(data));
        // Also save per-filter position
        window.DB.setPref('mw_pos_' + studyFilter, JSON.stringify({ idx: safeIdx, group: safeGroup, qScore: quizScore, qTotal: quizTotal }));
    }

    function loadProgress() {
        try {
            const raw = window.DB.getPref('mw_progress', '{}');
            return JSON.parse(raw);
        } catch { return {}; }
    }

    function loadFilterPosition(filter) {
        try {
            const raw = window.DB.getPref('mw_pos_' + filter, '{}');
            return JSON.parse(raw);
        } catch { return {}; }
    }

    function getGroupSize() {
        return parseInt(window.DB.getPref('group_size', '20')) || 20;
    }

    function getFilteredList() {
        if (studyFilter === 'all') return studyList;
        // Due filter pulls from DB directly so it always reflects current
        // review state (a word becomes "not due" the moment you review it).
        if (studyFilter === 'due') {
            try { return window.DB.getDueWords(); }
            catch { return studyList; }
        }
        return studyList.filter(w => {
            const focus = Array.isArray(w.focus) ? w.focus : [];
            return focus.includes(studyFilter);
        });
    }

    function getGroupCount() {
        return Math.max(1, Math.ceil(getFilteredList().length / getGroupSize()));
    }

    function getGroupWords() {
        const filtered = getFilteredList();
        const size     = getGroupSize();
        const start    = currentGroup * size;
        const group    = filtered.slice(start, start + size);
        // In quiz mode, put weak words first so they get practiced sooner
        if (studyMode === 'quiz' && studyFilter !== 'weak') {
            const weak    = group.filter(w => (w.focus || []).includes('weak'));
            const nonWeak = group.filter(w => !(w.focus || []).includes('weak'));
            return [...weak, ...nonWeak];
        }
        return group;
    }

    function init() {
        console.log('[MyWords] init started');
        showChinese = window.DB.getPref('show_cn_default', 'false') === 'true';
        bindEvents();
        refreshStudyList();

        // Restore progress. Clamp both group and idx to >= 0 — without
        // Math.max(_, 0) these can go to -1 if studyList was transiently
        // empty (e.g. during a sync-pull reload), which then freezes the
        // UI on an empty render even after data becomes available.
        const prog = loadProgress();
        if (prog.mode)  studyMode    = prog.mode;
        if (prog.view)  viewMode     = prog.view;
        if (prog.filter) studyFilter  = prog.filter;
        if (prog.group != null) currentGroup = Math.max(0, Math.min(prog.group, getGroupCount() - 1));
        if (prog.idx   != null) currentIdx   = Math.max(0, Math.min(prog.idx, getGroupWords().length - 1));
        if (prog.qScore != null) quizScore = prog.qScore;
        if (prog.qTotal != null) quizTotal = prog.qTotal;

        // Sync UI toggles — derive display mode from saved studyMode + viewMode
        const dm = studyMode === 'quiz' ? 'quiz' : viewMode === 'list' ? 'list' : 'cards';
        document.getElementById('mw-dm-cards')?.classList.toggle('active', dm === 'cards');
        document.getElementById('mw-dm-list')?.classList.toggle('active', dm === 'list');
        document.getElementById('mw-dm-quiz')?.classList.toggle('active', dm === 'quiz');
        // Sync filter pills
        document.querySelectorAll('.mw-filter-pill').forEach(b => {
            b.classList.toggle('active', b.dataset.filter === studyFilter);
        });
        const cnBtn = document.getElementById('mw-toggle-cn');
        if (cnBtn) {
            cnBtn.style.display = studyMode === 'quiz' ? 'none' : '';
            cnBtn.classList.toggle('active', showChinese);
            cnBtn.innerHTML = showChinese ? '中<span class="mw-btn-label"> CN</span>' : '中<span class="mw-btn-label"> CN</span>';
        }

        render();
        console.log('[MyWords] init complete, words:', studyList.length, 'group:', currentGroup, 'idx:', currentIdx);

        // Defensive retry: if init ran before localStorage was fully
        // populated (e.g., racing with a sync pull that reloaded the
        // page), the initial render may show 0 words even though the
        // notebook is there. After a short delay, re-check and re-render
        // if the stored notebook now has words but studyList is empty.
        // Only triggers once — doesn't re-run on subsequent renders.
        setTimeout(() => {
            const stored = window.DB.loadNotebook();
            if (stored.length > 0 && studyList.length === 0) {
                console.warn('[MyWords] recovery: studyList was empty but storage has', stored.length, 'words — re-rendering');
                refreshStudyList();
                // Reset currentGroup/currentIdx defensively since previous
                // clamp produced bad values when list was empty.
                currentGroup = Math.max(0, Math.min(currentGroup, getGroupCount() - 1));
                currentIdx   = Math.max(0, Math.min(currentIdx,   getGroupWords().length - 1));
                render();
            }
        }, 800);

        // Self-healing render: if mw-area ends up empty but the notebook
        // has words, re-render. Triggers on page-visibility change (user
        // switches tabs back), window focus, and storage events (sync
        // pulls in another tab/SW). Catches the observed symptom where
        // the UI shows 0 words despite localStorage being intact.
        const maybeHeal = () => {
            const area = document.getElementById('mw-area');
            if (!area) return;
            const isOnMyWordsTab = document.getElementById('view-my-words')?.classList.contains('active');
            if (!isOnMyWordsTab) return;
            const hasNoContent = area.children.length === 0;
            const storedCount  = window.DB.loadNotebook().length;
            if (hasNoContent && storedCount > 0) {
                console.warn('[MyWords] self-heal: UI empty but storage has', storedCount, 'words — re-rendering');
                refreshStudyList();
                currentGroup = Math.max(0, Math.min(currentGroup, getGroupCount() - 1));
                currentIdx   = Math.max(0, Math.min(currentIdx,   getGroupWords().length - 1));
                render();
            }
        };
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) maybeHeal();
        });
        window.addEventListener('focus', maybeHeal);
        window.addEventListener('storage', (e) => {
            if (e.key && e.key.includes('notebook')) maybeHeal();
        });

        // Sync pulls now apply data silently (without a page reload) and
        // dispatch this event so live modules can refresh their views.
        // Re-pull notebook from storage and re-render if MyWords is the
        // active tab. If the user is on a different tab, the next time
        // they open MyWords they'll see fresh data via the normal init.
        window.addEventListener('emp:datachanged', () => {
            const isOnMyWordsTab = document.getElementById('view-my-words')?.classList.contains('active');
            refreshStudyList();
            window.App?.updateNotebookBadge?.();
            if (isOnMyWordsTab) {
                currentGroup = Math.max(0, Math.min(currentGroup, getGroupCount() - 1));
                currentIdx   = Math.max(0, Math.min(currentIdx, getGroupWords().length - 1));
                render();
                updateFilterCounts();
            }
        });

        // Also run one extra time after a slightly longer delay to catch
        // any post-load render clobbering (e.g., by sync pulls that
        // apply data without a full reload).
        setTimeout(maybeHeal, 2000);
    }

    function bindEvents() {
        // Import
        const importBtn = document.getElementById('mw-import-btn');
        if (importBtn) { importBtn.addEventListener('click', openImportModal); importBtn.onclick = openImportModal; }
        document.getElementById('mw-import-close')?.addEventListener('click', closeImportModal);
        document.getElementById('mw-import-submit')?.addEventListener('click', handleImport);
        document.getElementById('mw-import-paste')?.addEventListener('click', pasteFromClipboard);
        document.getElementById('mw-add-single')?.addEventListener('click', handleAddSingle);
        document.getElementById('mw-single-input')?.addEventListener('keydown', (e) => {
            const dropdown = document.getElementById('mw-search-dropdown');
            if (e.key === 'Enter') {
                e.preventDefault();
                // If dropdown has a highlighted item, navigate to it
                const highlighted = dropdown?.querySelector('.mw-sd-item.mw-sd-highlight');
                if (highlighted) {
                    highlighted.click();
                    return;
                }
                // If dropdown has exactly one match, navigate to it
                const items = dropdown?.querySelectorAll('.mw-sd-item');
                if (items && items.length === 1) {
                    items[0].click();
                    return;
                }
                // Otherwise add as new word
                handleAddSingle();
            }
            if (e.key === 'Escape') {
                closeSearchDropdown();
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                navigateDropdown(e.key === 'ArrowDown' ? 1 : -1);
            }
        });
        document.getElementById('mw-single-input')?.addEventListener('input', handleSearchInput);
        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.mw-quick-add')) closeSearchDropdown();
        });

        // Batch enrich
        document.getElementById('mw-batch-enrich')?.addEventListener('click', batchEnrichCopy);
        document.getElementById('mw-batch-paste')?.addEventListener('click', openBatchPasteModal);

        // Navigation
        document.getElementById('mw-prev')?.addEventListener('click', () => { stopAutoplay(); navigate(-1); });
        document.getElementById('mw-next')?.addEventListener('click', () => { stopAutoplay(); navigate(1); });
        document.getElementById('mw-shuffle')?.addEventListener('click', () => { stopAutoplay(); shuffleList(); });

        // v75: swipe left/right anywhere on the card area to walk through
        // study words. Stops autoplay if running, mirroring the prev/next
        // button behavior. Skipped in list mode since list scrolls
        // vertically and a horizontal gesture there shouldn't navigate.
        const mwArea = document.getElementById('mw-area');
        if (mwArea && window.App?.bindSwipe) {
            window.App.bindSwipe(mwArea, {
                onPrev: () => {
                    if (viewMode === 'list') return;
                    stopAutoplay();
                    navigate(-1);
                },
                onNext: () => {
                    if (viewMode === 'list') return;
                    stopAutoplay();
                    navigate(1);
                }
            });
        }

        // Autoplay toggle
        document.getElementById('mw-autoplay')?.addEventListener('click', toggleAutoplay);

        // View / mode toggles — unified three-way
        document.getElementById('mw-dm-cards')?.addEventListener('click', () => { stopAutoplay(); setDisplayMode('cards'); });
        document.getElementById('mw-dm-list')?.addEventListener('click', () => { stopAutoplay(); setDisplayMode('list'); });
        document.getElementById('mw-dm-quiz')?.addEventListener('click', () => { stopAutoplay(); setDisplayMode('quiz'); });

        // Show/hide Chinese toggle
        document.getElementById('mw-toggle-cn')?.addEventListener('click', toggleChinese);

        // Focus filter pills
        document.querySelectorAll('.mw-filter-pill').forEach(btn => {
            btn.addEventListener('click', () => {
                stopAutoplay();
                // Save current filter's position before switching
                saveProgress();
                // Switch filter
                studyFilter = btn.dataset.filter;
                // Restore saved position for this filter
                const pos    = loadFilterPosition(studyFilter);
                currentGroup = Math.min(pos.group || 0, Math.max(0, getGroupCount() - 1));
                currentIdx   = Math.min(pos.idx   || 0, Math.max(0, getGroupWords().length - 1));
                quizScore    = pos.qScore || 0;
                quizTotal    = pos.qTotal || 0;
                // Update active state
                document.querySelectorAll('.mw-filter-pill').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                saveProgress();
                render();
            });
        });

        // Delegated clicks
        document.getElementById('mw-area')?.addEventListener('click', handleAreaClick);

        // Keyboard
        document.addEventListener('keydown', (e) => {
            const view = document.getElementById('view-my-words');
            if (!view || !view.classList.contains('active')) return;
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (e.key === 'ArrowLeft')  { e.preventDefault(); stopAutoplay(); navigate(-1); }
            if (e.key === 'ArrowRight') { e.preventDefault(); stopAutoplay(); navigate(1); }
            if (e.key === ' ')          { e.preventDefault(); toggleChinese(); }
            if (e.key === 'p' || e.key === 'P') { e.preventDefault(); toggleAutoplay(); }
            // R = remove current word (with confirmation). Only fires in
            // card or quiz view — list view already has per-row buttons,
            // and a global R could remove the wrong word there.
            if ((e.key === 'r' || e.key === 'R') && viewMode === 'cards') {
                e.preventDefault();
                stopAutoplay();
                const words = getGroupWords();
                const w     = words[currentIdx];
                if (!w) return;
                if (!confirm(`Remove "${w.word}" from your notebook?\n\nThis can't be undone, but you can re-add the word later.`)) return;
                window.DB.removeNotebookWord(w.word);
                refreshStudyList();
                if (currentIdx >= studyList.length) currentIdx = Math.max(0, studyList.length - 1);
                render();
                updateFilterCounts();
                window.App?.updateNotebookBadge?.();
                window.App?.showToast?.(`"${w.word}" removed.`);
            }
        });
    }

    function refreshStudyList() { studyList = window.DB.loadNotebook(); }

    // =====================================================
    // MODE / VIEW
    // =====================================================

    function setDisplayMode(dm) {
        // dm = 'cards' | 'list' | 'quiz'
        if (dm === 'quiz') {
            studyMode    = 'quiz';
            viewMode     = 'cards';
            showChinese  = window.DB.getPref('show_cn_default', 'false') === 'true';
            quizAnswered = false;
            currentIdx   = 0;
            quizScore    = 0;
            quizTotal    = 0;
        } else {
            studyMode = 'browse';
            viewMode  = dm;  // 'cards' or 'list'
        }
        // Update three-way toggle active state
        document.getElementById('mw-dm-cards')?.classList.toggle('active', dm === 'cards');
        document.getElementById('mw-dm-list')?.classList.toggle('active', dm === 'list');
        document.getElementById('mw-dm-quiz')?.classList.toggle('active', dm === 'quiz');
        // CN toggle: visible in cards/list, hidden in quiz
        const cnBtn = document.getElementById('mw-toggle-cn');
        if (cnBtn) cnBtn.style.display = dm === 'quiz' ? 'none' : '';
        saveProgress();
        render();
    }

    // Legacy wrappers (for any external callers)
    function setStudyMode(mode) {
        setDisplayMode(mode === 'quiz' ? 'quiz' : 'cards');
    }
    function setView(mode) {
        setDisplayMode(mode === 'list' ? 'list' : 'cards');
    }

    function toggleChinese() {
        showChinese = !showChinese;
        const btn = document.getElementById('mw-toggle-cn');
        if (btn) {
            btn.classList.toggle('active', showChinese);
        }
        // Toggle all Chinese text elements
        document.querySelectorAll('.mw-cn').forEach(el => {
            el.classList.toggle('mw-cn-visible', showChinese);
        });
    }

    // =====================================================
    // IMPORT
    // =====================================================

    function openImportModal() { document.getElementById('mw-import-modal').classList.add('open'); }
    function closeImportModal() { document.getElementById('mw-import-modal').classList.remove('open'); }

    async function pasteFromClipboard() {
        try {
            const text = await navigator.clipboard.readText();
            document.getElementById('mw-import-input').value = text;
            window.App?.showToast?.('Pasted from clipboard.');
        } catch { window.App?.showToast?.('Could not read clipboard. Paste manually.'); }
    }

    function handleImport() {
        const raw = (document.getElementById('mw-import-input')?.value || '').trim();
        if (!raw) { window.App?.showToast?.('Paste your word list first.'); return; }

        let count = 0;

        // Detect format: rich (WORD: / PHONETIC: / ...) or simple (word | meaning)
        if (raw.includes('WORD:') && raw.includes('PHONETIC:')) {
            count = importRichFormat(raw);
        } else {
            count = importSimpleFormat(raw);
        }

        window.App?.showToast?.(`Imported ${count} words.`);
        window.App?.updateNotebookBadge?.();
        refreshStudyList();
        currentIdx = 0;
        render();
        closeImportModal();
        document.getElementById('mw-import-input').value = '';
    }

    function importSimpleFormat(raw) {
        let words = [];

        // Detect format by analyzing content
        const hasNewlines   = raw.includes('\n');
        const hasPipe       = raw.includes('|');
        const hasTab        = raw.includes('\t');
        const hasCommas     = raw.includes(',');
        const hasSemicolons = raw.includes(';');

        if (hasNewlines && (hasPipe || hasTab)) {
            // Structured: one entry per line with | or tab separators
            // e.g. "word | meaning | notes"
            const lines = raw.split(/\n/).map(l => l.trim()).filter(Boolean);
            for (const line of lines) {
                const parts = line.split(/[|\t]/).map(s => s.trim());
                if (parts[0]) words.push({ word: parts[0], meaning: parts[1] || '', collo: parts[2] || '' });
            }
        } else if (hasNewlines && !hasCommas && !hasSemicolons) {
            // One word/phrase per line (no other delimiters)
            const lines = raw.split(/\n/).map(l => l.trim()).filter(Boolean);
            for (const line of lines) {
                if (line) words.push({ word: line });
            }
        } else if (hasCommas) {
            // Comma-separated: "word1, word2, word3" or "word1,word2"
            const items = raw.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
            for (const item of items) {
                // Each item might still have | for meaning
                if (item.includes('|')) {
                    const parts = item.split('|').map(s => s.trim());
                    words.push({ word: parts[0], meaning: parts[1] || '', collo: parts[2] || '' });
                } else {
                    words.push({ word: item });
                }
            }
        } else if (hasSemicolons) {
            // Semicolon-separated: "word1; word2; word3"
            const items = raw.split(/[;\n]/).map(s => s.trim()).filter(Boolean);
            for (const item of items) {
                if (item.includes('|')) {
                    const parts = item.split('|').map(s => s.trim());
                    words.push({ word: parts[0], meaning: parts[1] || '', collo: parts[2] || '' });
                } else {
                    words.push({ word: item });
                }
            }
        } else if (raw.includes(' ') && !hasNewlines) {
            // Space-separated: "word1 word2 word3 word4"
            // Only split if tokens look like a vocabulary list, not a phrase
            const tokens      = raw.split(/\s+/).filter(Boolean);
            const funcWords   = new Set(['i','a','an','the','is','am','are','was','were','be','it','my','me','your','you','we','our','he','she','his','her','they','them','their','to','of','in','on','at','by','for','with','from','not','no','do','does','did','has','have','had','can','could','will','would','shall','should','may','might']);
            const vocabTokens = tokens.filter(t => !funcWords.has(t.toLowerCase()));
            const avgLen      = vocabTokens.reduce((s, t) => s + t.length, 0) / (vocabTokens.length || 1);

            // Split only if: 4+ non-function tokens AND most tokens are content words
            if (vocabTokens.length >= 4 && vocabTokens.length > tokens.length * 0.7 && avgLen > 4) {
                for (const t of tokens) {
                    if (!funcWords.has(t.toLowerCase())) words.push({ word: t });
                }
            } else {
                words.push({ word: raw.trim() });
            }
        } else {
            // Single word/phrase
            words.push({ word: raw.trim() });
        }

        // Deduplicate and save
        let count = 0;
        const seen = new Set();
        for (const entry of words) {
            const w = (entry.word || '').trim();
            if (!w || w.length > 100) continue;
            const key = w.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);

            window.DB.upsertNotebookWord({
                word    : w,
                meaning : entry.meaning || '',
                collo   : entry.collo   || '',
                source  : 'Import',
                tags    : ['imported']
            });
            count++;
        }
        return count;
    }

    function importRichFormat(raw) {
        // Normalize line endings
        raw = String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

        // Line-by-line parser. Lines matching `LABEL: value` start (or
        // continue) a labelled field. Lines that DON'T match the label
        // pattern are treated as continuation of the previous field —
        // appended with a space — so multi-line NOTE / EXAMPLE_CN /
        // COLLOCATIONS content from the AI doesn't get silently dropped.
        const lines     = raw.split('\n');
        const results   = [];
        let current     = null;
        let lastLabel   = null;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === '---') { lastLabel = null; continue; }

            const m = trimmed.match(/^([A-Z][A-Z_]+):\s*(.*)$/);
            if (m) {
                const label = m[1];
                const value = (m[2] || '').trim();

                // If we hit a new WORD:, save previous and start new entry
                if (label === 'WORD') {
                    if (current && current.WORD) results.push(current);
                    current   = { WORD: value };
                    lastLabel = 'WORD';
                } else if (current) {
                    current[label] = value;
                    lastLabel      = label;
                }
            } else if (current && lastLabel) {
                // Continuation line — append to the previous field with a
                // space separator. Skip if there's no field to append to
                // (e.g. stray text before the first WORD:).
                const prev = current[lastLabel] || '';
                current[lastLabel] = prev ? `${prev} ${trimmed}` : trimmed;
            }
        }
        // Don't forget the last entry
        if (current && current.WORD) results.push(current);

        let count = 0;
        for (const f of results) {
            window.DB.upsertNotebookWord({
                word      : f.WORD              || '',
                phonetic  : f.PHONETIC          || '',
                meaning   : f.MEANING_CN        || '',
                enDef     : f.MEANING_EN         || '',
                register  : (f.REGISTER         || 'neutral').toLowerCase(),
                collo     : f.COLLOCATIONS      || '',
                colloCn   : f.COLLOCATIONS_CN   || '',
                context   : f.EXAMPLE           || '',
                contextCn : f.EXAMPLE_CN        || '',
                note      : f.NOTE              || '',
                source    : 'Batch enriched',
                tags      : ['enriched']
            });
            count++;
        }
        console.log('[importRich] parsed', results.length, 'entries, saved', count);
        return count;
    }

    // =====================================================
    // SEARCH / FIND WORD
    // =====================================================

    function handleSearchInput() {
        const input = document.getElementById('mw-single-input');
        const query = (input?.value || '').trim().toLowerCase();
        if (query.length < 1) { closeSearchDropdown(); return; }

        const matches = studyList.filter(w => {
            const word    = (w.word || '').toLowerCase();
            const meaning = (w.meaning || '').toLowerCase();
            const collo   = (w.collo || '').toLowerCase();
            return word.includes(query) || meaning.includes(query) || collo.includes(query);
        }).slice(0, 8); // limit to 8 results

        const dropdown = document.getElementById('mw-search-dropdown');
        if (!dropdown) return;

        if (matches.length === 0) {
            dropdown.innerHTML = `<div class="mw-sd-empty">No match — press Enter or + to add "<strong>${escHtml(query)}</strong>"</div>`;
            dropdown.style.display = 'block';
            return;
        }

        dropdown.innerHTML = matches.map((w, i) => {
            const meaning = w.meaning || w.enDef || '';
            const phonetic = w.phonetic ? `<span class="mw-sd-phonetic">${escHtml(w.phonetic)}</span>` : '';
            const collo    = w.collo ? `<span class="mw-sd-collo">${escHtml(w.collo)}</span>` : '';
            // Highlight the matching part in the word
            const wordHtml = highlightMatch(w.word || '', query);
            return `<div class="mw-sd-item" data-word="${escAttr(w.word)}" data-idx="${i}">
                <span class="mw-sd-word">${wordHtml}</span>
                ${phonetic}
                <span class="mw-sd-meaning">${escHtml(meaning)}</span>
                ${collo}
            </div>`;
        }).join('');
        dropdown.style.display = 'block';

        // Click to navigate
        dropdown.querySelectorAll('.mw-sd-item').forEach(item => {
            item.addEventListener('click', () => {
                navigateToWord(item.dataset.word);
                closeSearchDropdown();
                const input = document.getElementById('mw-single-input');
                if (input) input.value = '';
            });
        });
    }

    function highlightMatch(text, query) {
        const idx = text.toLowerCase().indexOf(query.toLowerCase());
        if (idx < 0) return escHtml(text);
        const before = escHtml(text.slice(0, idx));
        const match  = escHtml(text.slice(idx, idx + query.length));
        const after  = escHtml(text.slice(idx + query.length));
        return `${before}<mark>${match}</mark>${after}`;
    }

    function closeSearchDropdown() {
        const dropdown = document.getElementById('mw-search-dropdown');
        if (dropdown) { dropdown.style.display = 'none'; dropdown.innerHTML = ''; }
    }

    function navigateDropdown(dir) {
        const dropdown = document.getElementById('mw-search-dropdown');
        if (!dropdown) return;
        const items   = [...dropdown.querySelectorAll('.mw-sd-item')];
        if (items.length === 0) return;
        const current = items.findIndex(i => i.classList.contains('mw-sd-highlight'));
        items.forEach(i => i.classList.remove('mw-sd-highlight'));
        let next = current + dir;
        if (next < 0) next = items.length - 1;
        if (next >= items.length) next = 0;
        items[next].classList.add('mw-sd-highlight');
        items[next].scrollIntoView({ block: 'nearest' });
    }

    function navigateToWord(wordText) {
        if (!wordText) return;
        const wordLow = wordText.toLowerCase();

        // Switch to "all" filter to find the word
        studyFilter = 'all';
        document.querySelectorAll('.mw-filter-pill').forEach(b =>
            b.classList.toggle('active', b.dataset.filter === 'all')
        );

        refreshStudyList();
        const globalIdx = studyList.findIndex(w => (w.word || '').toLowerCase() === wordLow);
        if (globalIdx < 0) {
            window.App?.showToast?.(`"${wordText}" not found.`);
            return;
        }

        // Calculate which group and position within group
        const size  = getGroupSize();
        currentGroup = Math.floor(globalIdx / size);
        currentIdx   = globalIdx % size;

        // Switch to card mode to show the card
        studyMode    = 'browse';
        viewMode     = 'cards';
        showChinese  = true; // show meaning since user is looking up
        document.getElementById('mw-dm-cards')?.classList.toggle('active', true);
        document.getElementById('mw-dm-list')?.classList.toggle('active', false);
        document.getElementById('mw-dm-quiz')?.classList.toggle('active', false);
        const cnBtn = document.getElementById('mw-toggle-cn');
        if (cnBtn) { cnBtn.style.display = ''; cnBtn.classList.add('active'); }

        saveProgress();
        render();
        window.App?.showToast?.(`Found: ${wordText}`);
    }

    // =====================================================
    // ADD SINGLE WORD
    // =====================================================

    function handleAddSingle() {
        const input = document.getElementById('mw-single-input');
        const word  = (input?.value || '').trim();
        if (!word) return;
        window.DB.upsertNotebookWord({ word: word, source: 'Quick add', tags: ['imported'] });
        input.value = '';
        window.App?.showToast?.(`"${word}" added.`);
        window.App?.updateNotebookBadge?.();
        refreshStudyList();
        // Keep current position — new word appends to the end of the list
        // Clamp index in case group bounds shifted
        const groupWords = getGroupWords();
        if (currentIdx >= groupWords.length) currentIdx = Math.max(0, groupWords.length - 1);
        saveProgress();
        render();
    }

    // =====================================================
    // BATCH ENRICH — copy prompt for all words, paste back
    // =====================================================

    function isWordComplete(w) {
        // A word is "complete" if it has phonetic + meaning + enDef + at least one collocation + example
        return Boolean(w.phonetic && w.meaning && w.enDef && w.collo && w.context);
    }

    function batchEnrichCopy() {
        refreshStudyList();
        if (studyList.length === 0) { window.App?.showToast?.('No words to enrich.'); return; }

        // Filter: only words that lack information
        const incomplete = studyList.filter(w => !isWordComplete(w));

        if (incomplete.length === 0) {
            window.App?.showToast?.('All words already have rich information!');
            return;
        }

        const wordList = incomplete.map(w => w.word).join('\n');

        const prompt = `Please provide detailed vocabulary entries for each word/phrase below. Use this EXACT format for EACH word, separated by "---":

LEMMA RULE: If a word is inflected (plural, past tense, -ing/-ed form, comparative, superlative, irregular form), provide the entry for its BASE FORM (lemma) and put the lemma in the WORD field, not the original input. Examples: "capping" → entry for "cap"; "went" → entry for "go"; "studies" → entry for "study"; "better" → entry for "good". For phrases, keep the phrase intact (don't lemmatize individual words inside a phrase). If the input is already in base form, use it unchanged.

WORD: [the base form / lemma of the input word; for phrases, the phrase as given]
PHONETIC: [IPA pronunciation, e.g. /\u02C8r\u00E6m.b\u028A.t\u0259n/]
MEANING_CN: [Chinese meaning, concise but complete, 2-20 chars]
MEANING_EN: [Clear English definition, 1-2 sentences]
REGISTER: [formal|neutral|casual|academic|technical]
COLLOCATIONS: [3-4 common collocations or phrases, separated by " \u00B7 "]
COLLOCATIONS_CN: [Chinese translation of each collocation above, same order, separated by " \u00B7 "]
EXAMPLE: [A natural example sentence using the word in context]
EXAMPLE_CN: [Chinese translation of the example sentence]
NOTE: [Usage tip: when/how native speakers use this, common mistakes to avoid, or cultural context. 1-2 sentences]
---

Here are the words that need enrichment (${incomplete.length} of ${studyList.length} total):

${wordList}

IMPORTANT:
- Provide accurate IPA phonetic transcription
- Collocations and their Chinese translations must be in the same order
- Example sentences should reflect real-world usage, not textbook-style
- Notes should highlight what a Chinese speaker specifically needs to know
- Apply the LEMMA RULE above: return entries for base forms, not inflected input
- Separate each entry with "---"
- Do NOT use markdown formatting, just plain text`;

        navigator.clipboard.writeText(prompt).then(() => {
            window.App?.showToast?.(`Prompt for ${incomplete.length} incomplete words copied (${studyList.length - incomplete.length} already complete). Paste in Claude.ai.`, 5000);
            window.open('https://claude.ai/new', '_blank');
        }).catch(() => {
            openBatchPasteModal();
        });
    }

    function openBatchPasteModal() {
        let modal = document.getElementById('mw-batch-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id        = 'mw-batch-modal';
            modal.className = 'modal-overlay';
            modal.innerHTML = `
                <div class="modal-card">
                    <div class="modal-header">
                        <h2>Paste enriched data</h2>
                        <button class="modal-close" onclick="document.getElementById('mw-batch-modal').classList.remove('open')">&times;</button>
                    </div>
                    <div class="modal-body">
                        <p class="settings-hint">Paste the full response from Claude.ai. All words will be updated with phonetics, meanings, examples, etc.</p>
                        <textarea id="mw-batch-input" class="mw-import-textarea" rows="12" placeholder="Paste the AI response here..."></textarea>
                        <button class="wl-btn-primary" id="mw-batch-apply" style="width:100%;margin-top:10px">Apply to all words</button>
                    </div>
                </div>`;
            document.body.appendChild(modal);
            document.getElementById('mw-batch-apply').addEventListener('click', () => {
                const text = (document.getElementById('mw-batch-input')?.value || '').trim();
                if (!text) { window.App?.showToast?.('Paste the AI response first.'); return; }
                const count = importRichFormat(text);
                window.App?.showToast?.(`Updated ${count} words with enriched data.`);
                window.App?.updateNotebookBadge?.();
                refreshStudyList();
                currentIdx = 0;
                showChinese = true;
                const cnBtn = document.getElementById('mw-toggle-cn');
                if (cnBtn) { cnBtn.classList.add('active'); cnBtn.innerHTML = '\u{1F441}<span class="mw-btn-label"> Hide CN</span>'; }
                render();
                modal.classList.remove('open');
                document.getElementById('mw-batch-input').value = '';
            });
        }
        modal.classList.add('open');
    }

    // =====================================================
    // NAVIGATION
    // =====================================================

    // ----- SRS REVIEW -----
    // Called when the user taps one of the four SRS feedback buttons in
    // due-filter card view. Records the review against the current word,
    // re-pulls the due list (the word is no longer due, so the list shrinks),
    // and advances to the next word. If no due words remain, shows a
    // celebratory toast and falls back to the All filter.
    function handleSrsReview(result) {
        const words = getGroupWords();
        const w     = words[currentIdx];
        if (!w) return;

        const updated = window.DB.recordReview?.(w.word, result);
        if (!updated) {
            window.App?.showToast?.('Could not record review.');
            return;
        }

        const labels = { wrong: 'tomorrow', hard: '2 days', good: 'a few days', easy: 'longer' };
        window.App?.showToast?.(`Saw "${w.word}" \u2014 next review in ${labels[result] || 'a few days'}.`);

        // Refresh underlying data and the filtered list
        refreshStudyList();

        // If we're still in due-filter mode and the list shrank, snap idx
        // back into range and re-render.
        const remaining = getGroupWords();
        if (remaining.length === 0) {
            // All due words reviewed — celebrate and bounce to All view.
            const stats = window.DB.getReviewStats?.();
            window.App?.showToast?.(
                stats && stats.due === 0
                    ? '\u{1F389} All caught up! No more words due today.'
                    : 'No more words in this group.',
                4000
            );
            studyFilter = 'all';
            currentIdx  = 0;
            // Sync filter pill UI
            document.querySelectorAll('.mw-filter-pill').forEach(b => {
                b.classList.toggle('active', b.dataset.filter === 'all');
            });
            saveProgress();
            render();
            updateFilterCounts();
            return;
        }

        if (currentIdx >= remaining.length) currentIdx = 0;
        saveProgress();
        renderBrowseCard();
        updateFilterCounts();
    }

    function navigate(dir) {
        const words = getGroupWords();
        if (words.length === 0) return;
        currentIdx += dir;
        // Wrap within group
        if (currentIdx >= words.length) currentIdx = 0;
        if (currentIdx < 0) currentIdx = words.length - 1;
        showChinese  = window.DB.getPref('show_cn_default', 'false') === 'true';
        quizAnswered = false;
        const cnBtn = document.getElementById('mw-toggle-cn');
        if (cnBtn) {
            cnBtn.classList.toggle('active', showChinese);
            cnBtn.innerHTML = showChinese ? '\u{1F441}<span class="mw-btn-label"> Hide CN</span>' : '\u{1F441}<span class="mw-btn-label"> Show CN</span>';
        }
        saveProgress();
        render();
        speakCurrent();
    }

    function navigateGroup(dir) {
        const total = getGroupCount();
        currentGroup += dir;
        if (currentGroup >= total) currentGroup = 0;
        if (currentGroup < 0) currentGroup = total - 1;
        currentIdx   = 0;
        quizScore    = 0;
        quizTotal    = 0;
        quizAnswered = false;
        saveProgress();
        render();
    }

    function shuffleList() {
        // Shuffle the notebook and save so render()'s refreshStudyList picks up the new order
        const nb = window.DB.loadNotebook();
        for (let i = nb.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [nb[i], nb[j]] = [nb[j], nb[i]];
        }
        window.DB.saveNotebook(nb);
        currentIdx   = 0;
        quizAnswered = false;
        saveProgress();
        render();
        window.App?.showToast?.('Shuffled.');
    }

    function speakCurrent() {
        const words = getGroupWords();
        const w = words[currentIdx];
        if (w) window.App?.speak?.(w.word);
    }

    // =====================================================
    // AUTOPLAY — walk through words reading each one aloud
    // =====================================================

    function updateAutoplayBtn() {
        const btn = document.getElementById('mw-autoplay');
        if (!btn) return;
        if (autoplayOn) {
            btn.innerHTML = '&#x23F8;&#xFE0F;<span class="mw-btn-label"> Stop</span>';   // ⏸️ pause
            btn.title     = 'Stop auto-play';
            btn.classList.add('mw-autoplay-on');
        } else {
            btn.innerHTML = '&#x25B6;&#xFE0F;<span class="mw-btn-label"> Play</span>';   // ▶️ play
            btn.title     = 'Auto-play pronunciations';
            btn.classList.remove('mw-autoplay-on');
        }
    }

    function startAutoplay() {
        // Autoplay only makes sense in card view (browsing one word at a time).
        // If user is in list view, flip them to cards first.
        if (viewMode !== 'cards' || studyMode === 'quiz') {
            setDisplayMode('cards');
        }
        const words = getGroupWords();
        if (words.length === 0) {
            window.App?.showToast?.('No words to play.');
            return;
        }
        autoplayOn = true;
        autoplayToken++;
        acquireWakeLock();   // keep screen on while autoplay runs
        updateAutoplayBtn();
        speakCurrentAndQueueNext(autoplayToken);
    }

    function stopAutoplay() {
        autoplayOn = false;
        autoplayToken++;    // invalidates any pending callbacks
        if (autoplayTimer) { clearTimeout(autoplayTimer); autoplayTimer = null; }
        window.App?.stopSpeak?.();
        releaseWakeLock();   // let the screen sleep again
        document.querySelectorAll('.mw-card-playing, .mw-speaking-now')
            .forEach(el => el.classList.remove('mw-card-playing', 'mw-speaking-now'));
        updateAutoplayBtn();
    }

    // --- Screen Wake Lock --------------------------------------------
    // Prevents the phone's screen from auto-dimming/locking during
    // autoplay sessions. Without this, Chrome suspends the tab when
    // the screen goes dark and TTS stops mid-session.
    // Browser auto-releases the lock when the tab is hidden; we re-
    // acquire it when autoplay is still on and the tab becomes visible.
    async function acquireWakeLock() {
        if (!('wakeLock' in navigator)) {
            console.log('[Autoplay] Wake Lock API not supported — screen may dim during playback');
            return;
        }
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('[Autoplay] Screen wake lock acquired');
            wakeLock.addEventListener('release', () => {
                console.log('[Autoplay] Wake lock released by system');
                wakeLock = null;
            });
        } catch (err) {
            console.warn('[Autoplay] Wake lock request failed:', err.message);
            wakeLock = null;
        }
    }

    async function releaseWakeLock() {
        if (!wakeLock) return;
        try {
            await wakeLock.release();
        } catch (err) {
            console.warn('[Autoplay] Wake lock release failed:', err.message);
        }
        wakeLock = null;
    }

    // Re-acquire wake lock if the user switches to another tab and comes back
    // while autoplay is still running. The browser auto-releases on hide.
    document.addEventListener('visibilitychange', () => {
        if (autoplayOn && !document.hidden && !wakeLock) {
            acquireWakeLock();
        }
    });

    function toggleAutoplay() {
        if (autoplayOn) stopAutoplay();
        else            startAutoplay();
    }

    // Speak current word → each collocation → example sentence → wait → next.
    // The `myToken` pattern prevents stale callbacks from firing after stop.
    function speakCurrentAndQueueNext(myToken) {
        if (!autoplayOn || myToken !== autoplayToken) return;
        const words = getGroupWords();
        const w     = words[currentIdx];
        if (!w) { stopAutoplay(); return; }

        // Highlight current card so the user can follow along on mobile
        const cardEl = document.querySelector('.mw-card');
        if (cardEl) cardEl.classList.add('mw-card-playing');

        const rate = parseFloat(window.DB.getPref('speech_speed', '0.85'));

        // Build the speech queue for this card. Each item is {text, lang}
        // so the TTS engine can switch between English and Chinese voices
        // between utterances. Order (per user preference):
        //   1. the word itself            (EN)
        //   2. the English definition     (EN)
        //   3. the Chinese meaning        (CN) ─ brief, just the gloss
        //   4. each collocation           (EN)
        //   5. the example sentence       (EN, if enabled)
        const queue = [{ text: w.word, lang: 'en-US' }];
        if (w.enDef && w.enDef.trim()) {
            queue.push({ text: w.enDef, lang: 'en-US' });
        }
        if (w.meaning && w.meaning.trim()) {
            queue.push({ text: w.meaning, lang: 'zh-CN' });
        }
        if (w.collo) {
            (w.collo || '').split(/\s*·\s*/).map(s => s.trim()).filter(Boolean)
                .forEach(c => queue.push({ text: c, lang: 'en-US' }));
        }
        if (autoplayWithEx && w.context && w.context.trim()) {
            queue.push({ text: w.context, lang: 'en-US' });
        }

        playQueue(queue, rate, myToken, () => {
            if (!autoplayOn || myToken !== autoplayToken) return;
            scheduleNext(myToken);
        });
    }

    // Play a list of {text, lang} items sequentially with a short pause
    // between each. Stops cleanly if autoplay is cancelled or the token
    // is invalidated. Accepts plain strings too for backward compat —
    // these default to the system voice (English).
    function playQueue(items, rate, myToken, onDone) {
        let i = 0;
        const next = () => {
            if (!autoplayOn || myToken !== autoplayToken) return;
            if (i >= items.length) { onDone && onDone(); return; }
            const entry = items[i++];
            const text  = typeof entry === 'string' ? entry : entry.text;
            const lang  = typeof entry === 'string' ? ''    : (entry.lang || '');
            // Briefly highlight which collocation/example is being spoken
            highlightSpeakable(text);
            // Chinese voices on most systems are fixed at rate 1.0 by the
            // engine regardless — but we pass rate anyway for consistency.
            const opts = lang ? { lang } : undefined;
            window.App?.speak?.(text, rate, () => {
                if (!autoplayOn || myToken !== autoplayToken) return;
                // Small pause between items (shorter than between-cards gap)
                autoplayTimer = setTimeout(next, 350);
            }, opts);
        };
        next();
    }

    // Add a transient glow to the collocation/example currently being spoken
    // so the user can visually track progress through the card.
    function highlightSpeakable(text) {
        const norm = (text || '').trim().toLowerCase();
        if (!norm) return;
        // Clear any prior highlights
        document.querySelectorAll('.mw-speaking-now').forEach(el => el.classList.remove('mw-speaking-now'));
        // Find a .mw-speakable element whose dataset.speak matches
        const match = Array.from(document.querySelectorAll('.mw-speakable'))
            .find(el => (el.dataset.speak || '').trim().toLowerCase() === norm);
        if (match) match.classList.add('mw-speaking-now');
    }

    function scheduleNext(myToken) {
        // Pause between words so the user has a beat to register it
        autoplayTimer = setTimeout(() => {
            if (!autoplayOn || myToken !== autoplayToken) return;
            // Clear the "playing" highlight from the outgoing card
            document.querySelectorAll('.mw-card-playing, .mw-speaking-now')
                .forEach(el => el.classList.remove('mw-card-playing', 'mw-speaking-now'));

            const words = getGroupWords();
            if (words.length === 0) { stopAutoplay(); return; }

            // Advance. If we hit the end of the group, stop gracefully
            // rather than looping — looping would play forever.
            if (currentIdx >= words.length - 1) {
                stopAutoplay();
                window.App?.showToast?.('Finished this group.');
                return;
            }
            currentIdx++;
            showChinese  = window.DB.getPref('show_cn_default', 'false') === 'true';
            quizAnswered = false;
            saveProgress();
            render();
            speakCurrentAndQueueNext(myToken);
        }, 1200);
    }

    // =====================================================
    // RENDER
    // =====================================================

    function render() {
        const area      = document.getElementById('mw-area');
        const counter   = document.getElementById('mw-counter');
        const groupInfo = document.getElementById('mw-group-info');
        if (!area) { console.warn('[MyWords] render: mw-area element missing, bailing'); return; }
        refreshStudyList();
        console.log('[MyWords] render: studyList=' + studyList.length + ' currentGroup=' + currentGroup + ' currentIdx=' + currentIdx + ' mode=' + studyMode + ' view=' + viewMode + ' filter=' + studyFilter);

        const words      = getGroupWords();
        const groupCount = getGroupCount();
        console.log('[MyWords] render: getGroupWords=' + words.length + ' groupCount=' + groupCount);

        // Update group info
        if (groupInfo) {
            if (groupCount > 1) {
                groupInfo.style.display = 'flex';
                groupInfo.innerHTML = `
                    <button class="mw-nav-btn mw-grp-btn" id="mw-prev-group">&#x25C0;</button>
                    <span class="mw-grp-label"><span class="mw-btn-label">Group</span><span class="mw-grp-short">G</span><span class="mw-grp-num">${currentGroup + 1}/${groupCount}</span></span>
                    <button class="mw-nav-btn mw-grp-btn" id="mw-next-group">&#x25B6;</button>`;
                document.getElementById('mw-prev-group')?.addEventListener('click', () => navigateGroup(-1));
                document.getElementById('mw-next-group')?.addEventListener('click', () => navigateGroup(1));
            } else {
                groupInfo.style.display = 'none';
            }
        }

        // Update counter (position only — incomplete-word indicator
        // goes to a separate badge below the nav row)
        if (counter) {
            if (studyMode === 'quiz' && quizTotal > 0) {
                counter.textContent = `${currentIdx + 1}/${words.length} (${quizScore}/${quizTotal})`;
            } else {
                counter.textContent = words.length > 0 ? `${currentIdx + 1}/${words.length}` : '0 words';
            }
        }

        // Update enrich-badge — on desktop shows a parenthesized count
        // next to the "AI enrich" label (e.g. "✨ AI enrich (12)"). On
        // mobile the count span is hidden via CSS; the subtle accent
        // dot from .mw-has-pending remains the only visual indicator.
        // Tooltip is set in both cases for accessibility and for desktop
        // hover-to-confirm before acting.
        const enrichBtn   = document.getElementById('mw-batch-enrich');
        const enrichCount = document.getElementById('mw-enrich-count');
        if (enrichBtn) {
            const incomplete = studyList.filter(w => !isWordComplete(w)).length;
            if (incomplete > 0) {
                enrichBtn.title = `AI enrich — ${incomplete} word${incomplete === 1 ? '' : 's'} to enrich`;
                enrichBtn.classList.add('mw-has-pending');
                if (enrichCount) enrichCount.textContent = ` (${incomplete})`;
            } else {
                enrichBtn.title = 'AI enrich — all words are fully enriched';
                enrichBtn.classList.remove('mw-has-pending');
                if (enrichCount) enrichCount.textContent = '';
            }
        }

        if (studyList.length === 0) {
            area.innerHTML = `<div class="mw-empty"><p>No words yet. Import your word list or quick-add words above.</p></div>`;
            updateFilterCounts();
            return;
        }

        if (words.length === 0 && studyFilter !== 'all') {
            const labels = { core: '\u2B50 Core', pronunciation: '\uD83D\uDD0A Pronunciation', spelling: '\u270F\uFE0F Spelling' };
            area.innerHTML = `<div class="mw-empty"><p>No words marked as ${labels[studyFilter] || studyFilter} yet.</p><p style="font-size:13px;color:var(--text-tertiary)">Browse your words and tap the ${labels[studyFilter]} button to mark them, then come back here.</p></div>`;
            updateFilterCounts();
            return;
        }
        if (viewMode === 'list')       { renderList(); updateFilterCounts(); return; }
        if (studyMode === 'quiz')      { renderQuizCard(); updateFilterCounts(); return; }
        renderBrowseCard();
        updateFilterCounts();
    }

    function updateFilterCounts() {
        const allCount   = studyList.length;
        const coreCount  = studyList.filter(w => (w.focus || []).includes('core')).length;
        const pronCount  = studyList.filter(w => (w.focus || []).includes('pronunciation')).length;
        const spellCount = studyList.filter(w => (w.focus || []).includes('spelling')).length;
        const weakCount  = studyList.filter(w => (w.focus || []).includes('weak')).length;
        // Due count comes from DB rather than studyList so it reflects fresh
        // review state, not the (sometimes stale) cached list.
        let dueCount = 0;
        try { dueCount = window.DB.getDueCount?.() || 0; } catch {}

        const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n > 0 ? `(${n})` : ''; };
        set('mw-fc-due',           dueCount);
        set('mw-fc-all',           allCount);
        set('mw-fc-core',          coreCount);
        set('mw-fc-pronunciation', pronCount);
        set('mw-fc-spelling',      spellCount);
        set('mw-fc-weak',          weakCount);

        // Show/hide filter row. Always show if any words are marked OR
        // any due words exist OR we're not on the All filter.
        const hasAnyMarked = coreCount + pronCount + spellCount + weakCount > 0;
        const filterRow    = document.getElementById('mw-filter-row');
        if (filterRow) filterRow.style.display =
            (hasAnyMarked || dueCount > 0 || studyFilter !== 'all') ? 'flex' : 'none';
    }

    // ----- BROWSE (toggle CN) -----

    function renderBrowseCard() {
        const area  = document.getElementById('mw-area');
        const words = getGroupWords();
        const w     = words[currentIdx];
        if (!w) return;

        const hasMeaning = Boolean(w.meaning || w.enDef);
        const cnVis      = showChinese ? 'mw-cn-visible' : '';

        const colloItems   = (w.collo   || '').split(/\s*·\s*/).filter(Boolean);
        const colloCnItems = (w.colloCn || '').split(/\s*·\s*/).filter(Boolean);

        const colloHtml = colloItems.length > 0 ? `
            <div class="mw-collo-grid2">
                ${colloItems.map((c, i) => `<div class="mw-collo2 mw-speakable" data-speak="${escAttr(c)}"><span class="mw-collo-icon2">&#x1F50A;</span><span class="mw-collo-en2">${escHtml(c)}</span>${colloCnItems[i] ? `<span class="mw-cn mw-collo-cn2 ${cnVis}">${escHtml(colloCnItems[i])}</span>` : ''}</div>`).join('')}
            </div>` : '';

        const exHtml = w.context ? `
            <div class="mw-ex2">
                <div class="mw-ex-en2 mw-speakable" data-speak="${escAttr(w.context)}">"${escHtml(w.context)}" <button class="speak-btn speak-btn-s" data-text="${escAttr(w.context)}">&#x1F50A;</button></div>
                ${w.contextCn ? `<div class="mw-cn mw-ex-cn2 ${cnVis}">${escHtml(w.contextCn)}</div>` : ''}
            </div>` : '';

        const noteHtml = w.note ? `<div class="mw-note2">${escHtml(w.note)}</div>` : '';

        // SRS feedback row — only shown when the user is studying due words.
        // This keeps the regular browse experience visually unchanged.
        // The four buttons map directly to the scheduler's result codes
        // (wrong/hard/good/easy) and are wired via .mw-srs-btn delegation.
        const srsHtml = studyFilter === 'due' ? `
            <div class="mw-srs-row">
                <span class="mw-srs-prompt">How well did you know it?</span>
                <div class="mw-srs-btns">
                    <button class="mw-srs-btn mw-srs-wrong" data-srs="wrong" title="Forgot \u2014 review tomorrow">\u274C Forgot</button>
                    <button class="mw-srs-btn mw-srs-hard"  data-srs="hard"  title="Hard \u2014 review in 2 days">\u{1F914} Hard</button>
                    <button class="mw-srs-btn mw-srs-good"  data-srs="good"  title="Good \u2014 standard interval">\u{1F44D} Good</button>
                    <button class="mw-srs-btn mw-srs-easy"  data-srs="easy"  title="Easy \u2014 longer interval">\u{1F60E} Easy</button>
                </div>
            </div>` : '';

        area.innerHTML = `
            <div class="mw-card mw-card-compact">
                <div class="mw-row-top">
                    <div class="mw-col-word">
                        <div class="mw-word-row2">
                            <span class="mw-word2">${escHtml(w.word)}</span>
                            <button class="speak-btn" data-text="${escAttr(w.word)}" style="width:32px;height:32px;font-size:15px">&#x1F50A;</button>
                        </div>
                        ${w.phonetic ? `<span class="mw-ph2">${escHtml(w.phonetic)}</span>` : ''}
                        ${w.register && w.register !== 'neutral' ? `<span class="wl-register-tag wl-register-${w.register}" style="font-size:10px;margin-top:2px;display:inline-block">${w.register}</span>` : ''}
                    </div>
                    <div class="mw-col-def">
                        ${w.meaning ? `<div class="mw-cn mw-cn2 ${cnVis}">${escHtml(w.meaning)}</div>` : ''}
                        ${w.enDef   ? `<div class="mw-en2 mw-speakable" data-speak="${escAttr(w.enDef)}"><span class="mw-endef-icon">&#x1F50A;</span>${escHtml(w.enDef)}</div>` : ''}
                    </div>
                </div>
                ${colloHtml}
                ${exHtml}
                ${noteHtml}
                ${srsHtml}
                <div class="mw-card-bottom">
                    <div class="mw-focus-tags">
                        ${focusBtn(w, 'core',          '\u2B50', 'Core')}
                        ${focusBtn(w, 'pronunciation', '\uD83D\uDD0A', 'Pronunciation')}
                        ${focusBtn(w, 'spelling',      '\u270F\uFE0F', 'Spelling')}
                    </div>
                    <div class="mw-card-actions">
                        <button class="mw-action-btn mw-enrich-btn" data-word="${escAttr(w.word)}">&#x2728; ${hasMeaning ? 'More' : 'Enrich'}</button>
                        ${!isWordComplete(w) ? '<span class="mw-incomplete-tag">needs enrich</span>' : ''}
                        <button class="mw-action-btn mw-delete-btn" data-word="${escAttr(w.word)}">&#x1F5D1;</button>
                    </div>
                </div>
            </div>`;
    }

    // ----- QUIZ (Chinese MCQ) -----

    function renderQuizCard() {
        const area  = document.getElementById('mw-area');
        const words = getGroupWords();
        const w     = words[currentIdx];
        if (!w) return;

        const correctMeaning = w.meaning || w.enDef || '(no definition)';
        const distractors    = buildDistractors(currentIdx, 3);
        const options = [
            { text: correctMeaning, correct: true },
            ...distractors.map(d => ({ text: d, correct: false }))
        ].sort(() => Math.random() - 0.5);

        area.innerHTML = `
            <div class="mw-card mw-quiz-card">
                <button class="mw-quiz-remove mw-delete-btn" data-word="${escAttr(w.word)}" title="Remove this word from notebook">&#x1F5D1;</button>
                <div class="mw-card-top">
                    <div class="mw-card-word-row" style="justify-content:center">
                        <span class="mw-card-word">${escHtml(w.word)}</span>
                        <button class="speak-btn speak-btn-lg" data-text="${escAttr(w.word)}" title="Pronounce">&#x1F50A;</button>
                    </div>
                    ${w.phonetic ? `<span class="mw-card-phonetic" style="text-align:center;display:block">${escHtml(w.phonetic)}</span>` : ''}
                </div>
                <div class="mw-quiz-options">
                    ${options.map((o, i) => `
                        <button class="mw-quiz-option" data-correct="${o.correct}" data-idx="${i}">
                            <span class="mw-quiz-letter">${'ABCD'[i]}</span>
                            <span class="mw-quiz-text">${escHtml(o.text)}</span>
                        </button>
                    `).join('')}
                </div>
                <div class="mw-quiz-feedback" id="mw-quiz-feedback"></div>
                <div class="mw-card-bottom">
                    <div class="mw-focus-tags">
                        ${focusBtn(w, 'core',          '\u2B50',         'Core')}
                        ${focusBtn(w, 'pronunciation', '\uD83D\uDD0A',   'Pron.')}
                        ${focusBtn(w, 'spelling',      '\u270F\uFE0F',   'Spell')}
                    </div>
                </div>
            </div>`;
    }

    function buildDistractors(groupIdx, count) {
        // Pull distractors from ALL words for variety, excluding current word
        const words   = getGroupWords();
        const current = words[groupIdx];
        const pool    = studyList
            .filter(w => w.word !== current?.word && (w.meaning || w.enDef))
            .map(w => w.meaning || w.enDef || '');
        const fallbacks = ['\u540D\u8BCD', '\u52A8\u8BCD', '\u5F62\u5BB9\u8BCD', '\u526F\u8BCD', '\u77ED\u8BED', '\u8868\u8FBE\u65B9\u5F0F'];
        while (pool.length < count) pool.push(fallbacks[pool.length % fallbacks.length]);
        return pool.sort(() => Math.random() - 0.5).slice(0, count);
    }

    function handleQuizAnswer(btn) {
        if (quizAnswered) return;
        quizAnswered = true;
        quizTotal++;

        const isCorrect = btn.dataset.correct === 'true';
        const words     = getGroupWords();
        const w         = words[currentIdx];
        const feedback  = document.getElementById('mw-quiz-feedback');

        document.querySelectorAll('.mw-quiz-option').forEach(b => {
            b.disabled = true;
            if (b.dataset.correct === 'true') b.classList.add('mw-quiz-correct');
        });

        if (isCorrect) {
            btn.classList.add('mw-quiz-correct');
            quizScore++;
            if (feedback) feedback.innerHTML = `<div class="mw-fb-correct">&#x2705; Correct!</div>`;
            // Track correct streak
            trackQuizResult(w, true);
        } else {
            btn.classList.add('mw-quiz-wrong');
            if (feedback) feedback.innerHTML = `<div class="mw-fb-wrong">&#x274C; Answer: ${escHtml(w.meaning || w.enDef || '')}</div>`;
            // Track wrong
            trackQuizResult(w, false);
        }

        const counter = document.getElementById('mw-counter');
        if (counter) counter.textContent = `${currentIdx + 1}/${words.length} (${quizScore}/${quizTotal})`;

        saveProgress();
        setTimeout(() => navigate(1), isCorrect ? 1200 : 2500);
    }

    /** Track quiz result: update wrongCount/correctStreak, manage weak tag. */
    function trackQuizResult(w, isCorrect) {
        if (!w || !w.word) return;
        const nb  = window.DB.loadNotebook();
        const idx = nb.findIndex(x => (x.word || '').toLowerCase() === w.word.toLowerCase());
        if (idx < 0) return;

        const entry = nb[idx];
        if (!entry.wrongCount)    entry.wrongCount    = 0;
        if (!entry.correctStreak) entry.correctStreak = 0;
        const focus = Array.isArray(entry.focus) ? [...entry.focus] : [];

        if (isCorrect) {
            entry.correctStreak++;
            // Graduate: 3 correct in a row removes weak tag
            if (entry.correctStreak >= 3 && focus.includes('weak')) {
                focus.splice(focus.indexOf('weak'), 1);
                entry.focus = focus;
            }
        } else {
            entry.wrongCount++;
            entry.correctStreak = 0;
            // Auto-tag as weak
            if (!focus.includes('weak')) {
                focus.push('weak');
                entry.focus = focus;
            }
        }

        nb[idx] = entry;
        window.DB.saveNotebook(nb);
        // Refresh in-memory list
        refreshStudyList();
    }

    // ----- LIST -----

    function renderList() {
        const area  = document.getElementById('mw-area');
        const words = getGroupWords();
        area.innerHTML = `<div class="mw-list">${words.map((w, i) => {
            const complete = isWordComplete(w);
            const focus    = Array.isArray(w.focus) ? w.focus : [];
            const icons    = [
                focus.includes('core')          ? '\u2B50' : '',
                focus.includes('pronunciation') ? '\uD83D\uDD0A' : '',
                focus.includes('spelling')      ? '\u270F\uFE0F' : ''
            ].filter(Boolean).join('');
            return `
            <div class="mw-list-item ${i === currentIdx ? 'mw-list-active' : ''} ${!complete ? 'mw-list-incomplete' : ''}" data-idx="${i}">
                <button class="speak-btn" data-text="${escAttr(w.word)}">&#x1F50A;</button>
                <span class="mw-list-word">${escHtml(w.word)}</span>
                ${icons ? `<span class="mw-list-icons">${icons}</span>` : ''}
                ${w.phonetic ? `<span class="mw-list-phonetic">${escHtml(w.phonetic)}</span>` : ''}
                <span class="mw-list-meaning">${escHtml(w.meaning || w.enDef || '')}</span>
                ${!complete ? '<span class="mw-incomplete-tag">!</span>' : ''}
                <button class="mw-list-delete mw-delete-btn" data-word="${escAttr(w.word)}" title="Remove">&#x1F5D1;</button>
            </div>`;
        }).join('')}</div>`;
    }

    // =====================================================
    // SINGLE WORD ENRICH (free or API)
    // =====================================================

    function enrichWord(word) {
        if (isEnriching) return;
        if (window.AIEngine.hasAPIKey()) { enrichWithAPI(word); }
        else { enrichWithClipboard(word); }
    }

    function enrichWithClipboard(word) {
        const prompt = `Please provide details for this English word/phrase. Use this EXACT format:

WORD: ${word}
PHONETIC: [IPA pronunciation, e.g. /ˈræm.bʊ.tən/]
MEANING_CN: [Chinese meaning, concise but complete]
MEANING_EN: [English definition, 1-2 sentences]
REGISTER: [formal|neutral|casual|academic|technical]
COLLOCATIONS: [3-4 common collocations separated by " · "]
COLLOCATIONS_CN: [Chinese for each collocation, same order, separated by " · "]
EXAMPLE: [one natural example sentence]
EXAMPLE_CN: [Chinese translation of the example]
NOTE: [usage tip for Chinese speakers, 1-2 sentences]`;

        navigator.clipboard.writeText(prompt).then(() => {
            window.App?.showToast?.('Prompt copied! Paste in Claude.ai, then paste result back.', 5000);
            window.open('https://claude.ai/new', '_blank');
            setTimeout(() => openSinglePasteModal(word), 1000);
        });
    }

    function openSinglePasteModal(word) {
        let modal = document.getElementById('mw-single-paste-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id        = 'mw-single-paste-modal';
            modal.className = 'modal-overlay';
            modal.innerHTML = `
                <div class="modal-card">
                    <div class="modal-header"><h2>Paste AI response</h2>
                        <button class="modal-close" onclick="document.getElementById('mw-single-paste-modal').classList.remove('open')">&times;</button></div>
                    <div class="modal-body">
                        <p class="settings-hint">Paste the response from Claude.ai below.</p>
                        <textarea id="mw-single-paste-input" class="mw-import-textarea" rows="8" placeholder="Paste here..."></textarea>
                        <button class="wl-btn-primary" id="mw-single-paste-apply" style="width:100%;margin-top:10px">Apply</button>
                    </div>
                </div>`;
            document.body.appendChild(modal);
        }
        modal.dataset.word = word;
        document.getElementById('mw-single-paste-apply').onclick = () => {
            const text = (document.getElementById('mw-single-paste-input')?.value || '').trim();
            if (!text) return;
            importRichFormat(text);
            refreshStudyList();
            const idx = studyList.findIndex(w => w.word === modal.dataset.word);
            if (idx >= 0) currentIdx = idx;
            showChinese = true;
            const cnBtn = document.getElementById('mw-toggle-cn');
            if (cnBtn) { cnBtn.classList.add('active'); cnBtn.innerHTML = '\u{1F441}<span class="mw-btn-label"> Hide CN</span>'; }
            render();
            modal.classList.remove('open');
            document.getElementById('mw-single-paste-input').value = '';
            window.App?.showToast?.('Word updated!');
        };
        modal.classList.add('open');
    }

    async function enrichWithAPI(word) {
        isEnriching = true;
        const btn = document.querySelector(`.mw-enrich-btn[data-word="${CSS.escape(word)}"]`);
        if (btn) { btn.disabled = true; btn.innerHTML = '<span class="wl-spinner"></span>'; }

        const prompt = `You are an English vocabulary expert helping a PhD-level Chinese speaker.
Return a JSON object:
{"word":"...","phonetic":"IPA","meaning":"Chinese meaning","enDef":"English def 1-2 sentences","register":"formal|neutral|casual|academic","collo":"collocations separated by ' · '","colloCn":"Chinese for each collocation, same order, separated by ' · '","context":"example sentence","contextCn":"Chinese translation of example","note":"usage tip for Chinese speakers"}
Return ONLY valid JSON.`;

        try {
            const r = await window.AIEngine.callClaudeJSON(prompt, `Word: ${word}`);
            window.DB.upsertNotebookWord({
                word: word, meaning: r.meaning || '', enDef: r.enDef || '', phonetic: r.phonetic || '',
                register: r.register || 'neutral', collo: r.collo || '', colloCn: r.colloCn || '',
                context: r.context || '', contextCn: r.contextCn || '', note: r.note || '', source: 'AI enriched'
            });
            refreshStudyList(); showChinese = true;
            const cnBtn = document.getElementById('mw-toggle-cn');
            if (cnBtn) { cnBtn.classList.add('active'); cnBtn.innerHTML = '\u{1F441}<span class="mw-btn-label"> Hide CN</span>'; }
            render();
        } catch (err) { window.App?.showToast?.(window.AIEngine.friendlyError(err)); }
        finally { isEnriching = false; }
    }

    // =====================================================
    // CLICK HANDLERS
    // =====================================================

    function handleAreaClick(e) {
        // SRS feedback (only present in due-filter card view)
        const srsBtn = e.target.closest('.mw-srs-btn');
        if (srsBtn) {
            handleSrsReview(srsBtn.dataset.srs);
            return;
        }

        const quizOpt = e.target.closest('.mw-quiz-option');
        if (quizOpt) { handleQuizAnswer(quizOpt); return; }

        // Focus tag toggle
        const focusBtnEl = e.target.closest('.mw-focus-btn');
        if (focusBtnEl) {
            const word = focusBtnEl.dataset.word;
            const type = focusBtnEl.dataset.focus;
            const isOn = window.DB.toggleFocus(word, type);
            focusBtnEl.classList.toggle('mw-focus-active', isOn);
            refreshStudyList();
            updateFilterCounts();
            // Toast with hint
            const labels = { core: '\u2B50 Core', pronunciation: '\uD83D\uDD0A Pronunciation', spelling: '\u270F\uFE0F Spelling' };
            const count  = studyList.filter(w => (w.focus || []).includes(type)).length;
            if (isOn) {
                window.App?.showToast?.(`Marked as ${labels[type]}. Click "${labels[type]} (${count})" above to study only these.`, 4000);
            } else {
                window.App?.showToast?.(`Removed ${labels[type]} mark.`);
            }
            return;
        }

        const enrichBtn = e.target.closest('.mw-enrich-btn');
        if (enrichBtn) { enrichWord(enrichBtn.dataset.word); return; }

        const deleteBtn = e.target.closest('.mw-delete-btn');
        if (deleteBtn) {
            // Always stop propagation so a delete inside a clickable list
            // row doesn't also navigate the user to the deleted word.
            e.stopPropagation();
            const word = deleteBtn.dataset.word;
            if (!word) return;
            if (!confirm(`Remove "${word}" from your notebook?\n\nThis can't be undone, but you can re-add the word later.`)) return;
            window.DB.removeNotebookWord(word);
            refreshStudyList();
            if (currentIdx >= studyList.length) currentIdx = Math.max(0, studyList.length - 1);
            render();
            updateFilterCounts();
            window.App?.updateNotebookBadge?.();
            window.App?.showToast?.(`"${word}" removed.`);
            return;
        }

        const listItem = e.target.closest('.mw-list-item');
        if (listItem && listItem.dataset.idx !== undefined) {
            currentIdx = parseInt(listItem.dataset.idx, 10);
            setView('cards'); speakCurrent();
        }
    }

    function focusBtn(w, type, icon, label) {
        const focus  = Array.isArray(w.focus) ? w.focus : [];
        const active = focus.includes(type) ? 'mw-focus-active' : '';
        return `<button class="mw-focus-btn ${active}" data-focus="${type}" data-word="${escAttr(w.word)}">${icon}<span>${label}</span></button>`;
    }

    function escHtml(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
    function escAttr(s) {
        // v72: HTML attribute escaping. Old version used JS-style \\' which
        // meant words like "don't" became data-word="don\'t" — invalid in
        // HTML, breaking subsequent matching/saving/deletion lookups.
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/\n/g, ' ');
    }

    return { init, render, refreshStudyList, startAutoplay, stopAutoplay, toggleAutoplay,
             isAutoplayActive: () => autoplayOn };
})();
