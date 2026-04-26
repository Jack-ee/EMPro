// ============================================================
// writing-lab.js — Writing Lab Module
// ============================================================

window.WritingLab = (function() {

    let currentMode   = 'polish';
    let lastResult    = null;
    let isProcessing  = false;

    // v72: copy cache for inline copy buttons. Replaces fragile inline
    // onclick="...copyText(this, '${escAttr(text)}')" handlers that broke
    // on AI text containing quotes, backticks, or template syntax. Buttons
    // now carry a data-copy-id and the text lives here in a Map.
    const copyCache = new Map();
    function putCopyText(text) {
        const id = `wlcpy_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        copyCache.set(id, String(text == null ? '' : text));
        return id;
    }

    /** Initialize the writing lab. */
    function init() {
        renderModeSelector();
        bindEvents();
        loadLastDraft();
        updateCharCount();
    }

    /** Render mode buttons from config. */
    function renderModeSelector() {
        const container = document.getElementById('wl-modes');
        if (!container) return;

        const modes = window.WRITING_MODES || [];
        container.innerHTML = modes.map(m => `
            <button class="wl-mode-btn ${m.id === currentMode ? 'active' : ''}"
                    data-mode="${m.id}" title="${m.description}">
                <span class="wl-mode-icon">${m.icon}</span>
                <span class="wl-mode-label">${m.label}</span>
            </button>
        `).join('');
    }

    /** Bind UI events. */
    function bindEvents() {
        // Mode selection
        document.getElementById('wl-modes')?.addEventListener('click', (e) => {
            const btn = e.target.closest('.wl-mode-btn');
            if (!btn) return;
            currentMode = btn.dataset.mode;
            document.querySelectorAll('.wl-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === currentMode));
            // Clear results when switching mode
            clearResults();
        });

        // Submit
        document.getElementById('wl-submit')?.addEventListener('click', handleSubmit);

        // Clear
        document.getElementById('wl-clear')?.addEventListener('click', () => {
            document.getElementById('wl-input').value = '';
            clearResults();
            updateCharCount();
        });

        // Character count
        document.getElementById('wl-input')?.addEventListener('input', updateCharCount);

        // Keyboard shortcut: Ctrl+Enter to submit
        document.getElementById('wl-input')?.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                handleSubmit();
            }
        });

        // History toggle
        document.getElementById('wl-history-toggle')?.addEventListener('click', toggleHistory);

        // Save to notebook buttons (delegated)
        document.getElementById('wl-results')?.addEventListener('click', (e) => {
            // v72: delegated copy button — replaces fragile inline onclick
            // that interpolated AI text directly into the HTML attribute.
            const copyEl = e.target.closest('.wl-copy-target[data-copy-id]');
            if (copyEl) {
                const text = copyCache.get(copyEl.dataset.copyId) || '';
                navigator.clipboard?.writeText(text)
                    .then(() => {
                        const orig = copyEl.textContent;
                        copyEl.textContent = 'Copied!';
                        setTimeout(() => { copyEl.textContent = orig; }, 1500);
                    })
                    .catch(() => window.App?.showToast?.('Copy failed.'));
                return;
            }

            const saveBtn = e.target.closest('.wl-save-word');
            if (saveBtn) {
                const word = saveBtn.dataset.word;
                const note = saveBtn.dataset.note || '';
                if (word) {
                    window.DB.upsertNotebookWord({
                        word     : word,
                        collo    : note,
                        source   : 'Writing Lab',
                        tags     : ['writing-lab']
                    });
                    saveBtn.textContent = 'Saved';
                    saveBtn.disabled    = true;
                    window.App?.updateNotebookBadge?.();
                }
            }
        });
    }

    /** Handle the main submit action. */
    async function handleSubmit() {
        if (isProcessing) return;

        const input = document.getElementById('wl-input');
        const text  = (input?.value || '').trim();

        if (!text) {
            window.App?.showToast?.('Please enter some text first.');
            return;
        }

        if (text.length < 3) {
            window.App?.showToast?.('Please enter at least a short sentence.');
            return;
        }

        if (!window.AIEngine.hasAPIKey()) {
            window.App?.showToast?.('Please set your API key in Settings first.');
            window.App?.openSettings?.();
            return;
        }

        const mode = (window.WRITING_MODES || []).find(m => m.id === currentMode);
        if (!mode) return;

        setProcessing(true);
        clearResults();
        showLoading();

        try {
            const result = await window.AIEngine.callClaudeJSON(mode.system, text);
            lastResult   = { mode: currentMode, input: text, output: result, timestamp: Date.now() };

            // Save to history
            window.DB.saveWritingEntry({
                mode   : currentMode,
                input  : text,
                output : result
            });

            // Update stats. Refine mode returns `versions` (multiple variants
            // with no single score) — pass null so bumpSession skips the avg
            // update. Otherwise pass the numeric score if the AI gave one.
            const score = result.versions?.[0]
                ? null
                : (typeof result.score === 'number' ? result.score : null);
            window.DB.bumpSession(currentMode, score);

            renderResult(result, currentMode);
            window.App?.refreshStats?.();
        } catch (err) {
            showError(window.AIEngine.friendlyError(err));
        } finally {
            setProcessing(false);
        }
    }

    /** Render results based on mode. */
    function renderResult(result, mode) {
        const container = document.getElementById('wl-results');
        if (!container) return;

        if (mode === 'paraphrase') {
            renderParaphraseResult(container, result);
        } else {
            renderCorrectionResult(container, result, mode);
        }

        container.classList.add('visible');
    }

    /** Render correction-style results (polish, academic, casual, email, chinglish). */
    function renderCorrectionResult(container, result, mode) {
        const inputText = document.getElementById('wl-input')?.value || '';

        // Score badge
        const scoreBadge = typeof result.score === 'number'
            ? `<div class="wl-score">
                 <div class="wl-score-ring" style="--score: ${result.score}">
                   <span class="wl-score-value">${result.score}</span>
                 </div>
                 <span class="wl-score-label">${getScoreLabel(result.score)}</span>
               </div>`
            : '';

        // Diff view
        const diffHtml = buildDiffHtml(inputText, result.corrected || '');

        // Changes list
        let changesHtml = '';
        const changes   = result.changes || result.chinglish_patterns || [];
        if (changes.length > 0) {
            changesHtml = `
                <div class="wl-changes">
                    <h3 class="wl-section-title">${mode === 'chinglish' ? 'Chinglish Patterns Found' : 'Changes Made'}</h3>
                    ${changes.map((c, i) => {
                        const orig    = c.original       || '';
                        const revised = c.revised || c.native || '';
                        const reason  = c.reason  || c.chinese_logic || '';
                        const severity = c.severity ? `<span class="wl-severity wl-severity-${c.severity}">${c.severity}</span>` : '';
                        return `
                            <div class="wl-change-item" style="animation-delay: ${i * 60}ms">
                                <div class="wl-change-header">
                                    <span class="wl-change-num">${i + 1}</span>
                                    ${severity}
                                </div>
                                <div class="wl-change-diff">
                                    <span class="wl-del">${escHtml(orig)}</span>
                                    <span class="wl-arrow-icon">\u2192</span>
                                    <span class="wl-ins">${escHtml(revised)}</span>
                                </div>
                                <div class="wl-change-reason">${escHtml(reason)}</div>
                            </div>`;
                    }).join('')}
                </div>`;
        }

        // Clean patterns (chinglish mode)
        let cleanHtml = '';
        if (result.clean_patterns && result.clean_patterns.length > 0) {
            cleanHtml = `
                <div class="wl-clean-patterns">
                    <h3 class="wl-section-title">What you got right</h3>
                    <ul>${result.clean_patterns.map(p => `<li>${escHtml(p)}</li>`).join('')}</ul>
                </div>`;
        }

        // Subject suggestions (email mode)
        let subjectHtml = '';
        if (result.subject_suggestions && result.subject_suggestions.length > 0) {
            subjectHtml = `
                <div class="wl-subjects">
                    <h3 class="wl-section-title">Subject line suggestions</h3>
                    ${result.subject_suggestions.map(s => {
                        const id = putCopyText(s);
                        return `<div class="wl-subject-option wl-copy-target" data-copy-id="${id}">${escHtml(s)} <span class="wl-copy-hint">click to copy</span></div>`;
                    }).join('')}
                </div>`;
        }

        // Extra notes
        const notes = result.register_notes || result.native_tips || result.tone_notes || '';
        const notesHtml = notes
            ? `<div class="wl-notes"><span class="wl-notes-icon">\uD83D\uDCA1</span> ${escHtml(notes)}</div>`
            : '';

        // Overall summary
        const overallHtml = result.overall
            ? `<div class="wl-overall">${escHtml(result.overall)}</div>`
            : '';

        // Corrected text with copy button
        const correctedHtml = result.corrected
            ? `<div class="wl-corrected-section">
                 <div class="wl-corrected-header">
                   <h3 class="wl-section-title">Corrected text</h3>
                   <button class="speak-btn" data-text="${escAttr(result.corrected)}" title="Listen">&#x1F50A;</button>
                   <button class="wl-btn-small" onclick="WritingLab.copyCorrected()">Copy</button>
                 </div>
                 <div class="wl-corrected-text" id="wl-corrected-text">${escHtml(result.corrected)}</div>
               </div>`
            : '';

        container.innerHTML = `
            <div class="wl-result-card">
                ${scoreBadge}
                ${overallHtml}
                ${subjectHtml}
                ${correctedHtml}
                <div class="wl-diff-section">
                    <h3 class="wl-section-title">Comparison</h3>
                    <div class="wl-diff-view">${diffHtml}</div>
                </div>
                ${changesHtml}
                ${cleanHtml}
                ${notesHtml}
            </div>`;
    }

    /** Render paraphrase results. */
    function renderParaphraseResult(container, result) {
        const versions = result.versions || [];
        const vocabHL  = result.vocabulary_highlight || [];

        let versionsHtml = versions.map((v, i) => {
            const id = putCopyText(v.text);
            return `
            <div class="wl-paraphrase-card" style="animation-delay: ${i * 100}ms">
                <div class="wl-paraphrase-header">
                    <span class="wl-paraphrase-label">${escHtml(v.label)}</span>
                    <button class="speak-btn" data-text="${escAttr(v.text)}" title="Listen">&#x1F50A;</button>
                    <button class="wl-btn-small wl-copy-target" data-copy-id="${id}">Copy</button>
                </div>
                <div class="wl-paraphrase-text">${escHtml(v.text)}</div>
                <div class="wl-paraphrase-diff">${escHtml(v.key_differences)}</div>
            </div>
        `;
        }).join('');

        let vocabHtml = '';
        if (vocabHL.length > 0) {
            vocabHtml = `
                <div class="wl-vocab-highlight">
                    <h3 class="wl-section-title">Key vocabulary by register</h3>
                    ${vocabHL.map(v => `
                        <div class="wl-vocab-item">
                            <span class="wl-vocab-word">${escHtml(v.word)}</span>
                            <span class="wl-register-tag wl-register-${v.register || 'neutral'}">${escHtml(v.register || 'neutral')}</span>
                            <span class="wl-vocab-note">${escHtml(v.note)}</span>
                            <button class="wl-save-word wl-btn-tiny" data-word="${escAttr(v.word)}" data-note="${escAttr(v.note)}">+ Notebook</button>
                        </div>
                    `).join('')}
                </div>`;
        }

        const overallHtml = result.overall
            ? `<div class="wl-overall">${escHtml(result.overall)}</div>`
            : '';

        container.innerHTML = `
            <div class="wl-result-card">
                ${overallHtml}
                <div class="wl-paraphrases">${versionsHtml}</div>
                ${vocabHtml}
            </div>`;
    }

    /** Build a simple diff display between original and corrected text. */
    function buildDiffHtml(original, corrected) {
        if (!original || !corrected) return '';

        const origWords = original.split(/(\s+)/);
        const corrWords = corrected.split(/(\s+)/);

        // v72: LCS is O(m·n). At ~1k×1k that's 1M ops — fine. At 2k×2k
        // it's 4M and starts visibly hitching on Android. Past ~200k
        // product, skip the word-level diff entirely and just render the
        // corrected text with a notice. The user still sees the result;
        // they just don't get inline highlighting on this very long input.
        if (origWords.length * corrWords.length > 200000) {
            return `<div class="wl-diff-warning">Text is too long for word-by-word highlighting. Showing corrected version only.</div>
                    <div class="wl-diff-fallback">${escHtml(corrected)}</div>`;
        }

        // Simple word-level diff using LCS approach
        const lcs    = longestCommonSubseq(origWords, corrWords);
        let html     = '';
        let oi       = 0;
        let ci       = 0;
        let li       = 0;

        while (oi < origWords.length || ci < corrWords.length) {
            if (li < lcs.length && oi < origWords.length && ci < corrWords.length
                && origWords[oi] === lcs[li] && corrWords[ci] === lcs[li]) {
                html += escHtml(origWords[oi]);
                oi++; ci++; li++;
            } else {
                // Collect deletions
                while (oi < origWords.length && (li >= lcs.length || origWords[oi] !== lcs[li])) {
                    if (origWords[oi].trim()) {
                        html += `<span class="wl-diff-del">${escHtml(origWords[oi])}</span>`;
                    } else {
                        html += origWords[oi];
                    }
                    oi++;
                }
                // Collect insertions
                while (ci < corrWords.length && (li >= lcs.length || corrWords[ci] !== lcs[li])) {
                    if (corrWords[ci].trim()) {
                        html += `<span class="wl-diff-ins">${escHtml(corrWords[ci])}</span>`;
                    } else {
                        html += corrWords[ci];
                    }
                    ci++;
                }
            }
        }

        return html || `<span class="wl-no-diff">No differences found — your text is already natural!</span>`;
    }

    /** LCS for word arrays. */
    function longestCommonSubseq(a, b) {
        const m = a.length;
        const n = b.length;
        const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                dp[i][j] = (a[i - 1] === b[j - 1])
                    ? dp[i - 1][j - 1] + 1
                    : Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }

        const result = [];
        let i = m, j = n;
        while (i > 0 && j > 0) {
            if (a[i - 1] === b[j - 1]) {
                result.unshift(a[i - 1]);
                i--; j--;
            } else if (dp[i - 1][j] > dp[i][j - 1]) {
                i--;
            } else {
                j--;
            }
        }
        return result;
    }

    /** Score label. */
    function getScoreLabel(score) {
        if (score >= 95) return 'Native-level';
        if (score >= 85) return 'Very natural';
        if (score >= 70) return 'Good, minor issues';
        if (score >= 50) return 'Understandable';
        return 'Needs work';
    }

    // --- UI Helpers ---

    function setProcessing(on) {
        isProcessing = on;
        const btn = document.getElementById('wl-submit');
        if (btn) {
            btn.disabled  = on;
            btn.innerHTML = on
                ? '<span class="wl-spinner"></span> Analyzing...'
                : 'Analyze <kbd>Ctrl+Enter</kbd>';
        }
    }

    function showLoading() {
        const container = document.getElementById('wl-results');
        if (container) {
            container.innerHTML = `
                <div class="wl-loading">
                    <div class="wl-loading-dots">
                        <span></span><span></span><span></span>
                    </div>
                    <p>Analyzing your text...</p>
                </div>`;
            container.classList.add('visible');
        }
    }

    function showError(msg) {
        const container = document.getElementById('wl-results');
        if (container) {
            container.innerHTML = `<div class="wl-error">${escHtml(msg)}</div>`;
            container.classList.add('visible');
        }
    }

    function clearResults() {
        const container = document.getElementById('wl-results');
        if (container) {
            container.innerHTML = '';
            container.classList.remove('visible');
        }
    }

    function updateCharCount() {
        const input   = document.getElementById('wl-input');
        const counter = document.getElementById('wl-char-count');
        if (input && counter) {
            const len = (input.value || '').length;
            counter.textContent = `${len} characters`;
            counter.classList.toggle('wl-long', len > 2000);
        }
    }

    function loadLastDraft() {
        const draft = window.DB.getPref('wl_draft', '');
        if (draft) {
            const input = document.getElementById('wl-input');
            if (input) input.value = draft;
        }
    }

    function saveDraft() {
        const input = document.getElementById('wl-input');
        if (input) window.DB.setPref('wl_draft', input.value || '');
    }

    // Auto-save draft every 5 seconds
    setInterval(saveDraft, 5000);

    /** Toggle history panel. */
    function toggleHistory() {
        const panel = document.getElementById('wl-history-panel');
        if (!panel) return;

        const isVisible = panel.classList.toggle('visible');
        if (isVisible) renderHistory();
    }

    function renderHistory() {
        const panel   = document.getElementById('wl-history-list');
        if (!panel) return;

        const history = window.DB.loadWritingHistory();
        if (history.length === 0) {
            panel.innerHTML = '<p class="wl-empty">No history yet. Start writing!</p>';
            return;
        }

        panel.innerHTML = history.slice(0, 30).map(entry => {
            const date    = new Date(entry.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            const mode    = (window.WRITING_MODES || []).find(m => m.id === entry.mode);
            const preview = (entry.input || '').slice(0, 80) + ((entry.input || '').length > 80 ? '...' : '');
            const score   = entry.output?.score;

            return `
                <div class="wl-history-item" onclick="WritingLab.loadFromHistory('${entry.id}')">
                    <div class="wl-history-meta">
                        <span class="wl-history-mode">${mode?.icon || ''} ${mode?.label || entry.mode}</span>
                        <span class="wl-history-date">${date}</span>
                        ${typeof score === 'number' ? `<span class="wl-history-score">${score}</span>` : ''}
                    </div>
                    <div class="wl-history-preview">${escHtml(preview)}</div>
                </div>`;
        }).join('');
    }

    function loadFromHistory(id) {
        const history = window.DB.loadWritingHistory();
        const entry   = history.find(e => e.id === id);
        if (!entry) return;

        const input = document.getElementById('wl-input');
        if (input) input.value = entry.input || '';

        // Set mode
        currentMode = entry.mode || 'polish';
        document.querySelectorAll('.wl-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === currentMode));

        // Re-render result
        if (entry.output) {
            renderResult(entry.output, entry.mode);
        }

        updateCharCount();
        toggleHistory(); // close panel
    }

    // --- Utilities ---

    function escHtml(str) {
        const div       = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    }

    function escAttr(str) {
        // v72: HTML attribute escaping (was JS-style — unsafe for AI text
        // that may contain quotes, backticks, or apostrophes).
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/\n/g, ' ');
    }

    function copyCorrected() {
        const el = document.getElementById('wl-corrected-text');
        if (el) {
            navigator.clipboard.writeText(el.textContent).then(() => {
                window.App?.showToast?.('Copied to clipboard!');
            });
        }
    }

    function copyText(btn, text) {
        navigator.clipboard.writeText(text).then(() => {
            const orig       = btn.textContent;
            btn.textContent  = 'Copied!';
            setTimeout(() => btn.textContent = orig, 1500);
        });
    }

    // Public API
    return {
        init,
        loadFromHistory,
        copyCorrected,
        copyText
    };

})();
