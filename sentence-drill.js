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
    function init(el) {
        container = el;
        sentences = window.CUSTOM_SENTENCES || [];
        const state = loadState();
        if (state.idx != null) currentIdx = Math.min(state.idx, sentences.length - 1);
        if (state.score != null) score = state.score;
        if (state.total != null) total = state.total;
        render();
    }

    // ─── Render: toolbar + exercise ──────────────────────────
    function render() {
        if (!container) return;
        const progress  = loadProgress();
        const practiced = Object.keys(progress).length;
        const mastered  = Object.values(progress).filter(p => p.correct >= 2).length;

        container.innerHTML = `
        <div class="ec-wrapper">
            <div class="ec-toolbar">
                <span style="font-size:0.82rem;font-weight:600;color:var(--text-primary)">Sentences</span>
                <div class="ec-toolbar-stats">
                    <span class="ec-ts"><span class="ec-ts-num">${sentences.length}</span> total</span>
                    <span class="ec-ts"><span class="ec-ts-num ec-practiced" id="sd-practiced">${practiced}</span>&#x2705;</span>
                    <span class="ec-ts"><span class="ec-ts-num ec-mastered" id="sd-mastered">${mastered}</span>&#x2B50;</span>
                    ${total > 0 ? `<span class="ec-ts">${score}/${total}</span>` : ''}
                </div>
                <button class="ec-btn-primary" id="sd-start-btn">&#x25B6; Start</button>
            </div>
            <div id="sd-exercise-area">
                <div class="ec-start-prompt">
                    <p>${sentences.length} sentences with ${countTargets()} vocabulary targets ready to practice.</p>
                </div>
            </div>
        </div>`;

        container.querySelector('#sd-start-btn')?.addEventListener('click', () => {
            renderExercise();
        });
    }

    function countTargets() {
        return sentences.reduce((sum, s) => sum + (s.targets?.length || 0), 0);
    }

    // ─── Render exercise card ────────────────────────────────
    function renderExercise() {
        const area = container.querySelector('#sd-exercise-area');
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

    return { init };
})();
