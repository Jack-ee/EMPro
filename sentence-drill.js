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
            <div class="ec-toolbar sd-toolbar">
                <div class="ec-toolbar-stats">
                    <span class="ec-ts"><span class="ec-ts-num">${sentences.length}</span> total</span>
                    <span class="ec-ts"><span class="ec-ts-num ec-practiced" id="sd-practiced">${practiced}</span>&#x2705;</span>
                    <span class="ec-ts"><span class="ec-ts-num ec-mastered" id="sd-mastered">${mastered}</span>&#x2B50;</span>
                    ${total > 0 ? `<span class="ec-ts">${score}/${total}</span>` : ''}
                </div>
                <div class="sd-toolbar-actions">
                    <button class="ec-btn-ghost" id="sd-listen-btn" title="Listen mode \u2014 auto-pronounce every sentence">&#x1F3A7;<span class="sd-btn-label"> Listen</span></button>
                    <button class="ec-btn-primary" id="sd-start-btn">&#x25B6;<span class="sd-btn-label"> Start</span></button>
                </div>
            </div>
            <div id="sd-exercise-area">
                <div class="ec-start-prompt">
                    <p>${sentences.length} sentences with ${countTargets()} vocabulary targets ready to practice.</p>
                </div>
            </div>
        </div>`;

        container.querySelector('#sd-start-btn')?.addEventListener('click', () => {
            stopListen();
            renderExercise();
        });
        container.querySelector('#sd-listen-btn')?.addEventListener('click', () => {
            startListen();
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

    function startListen() {
        if (listenActive) return;
        if (sentences.length === 0) {
            window.App?.showToast?.('No sentences loaded.');
            return;
        }
        // Restore last position from saved state if available
        const state = loadState();
        listenIdx    = Math.min(Math.max(0, state.idx || 0), sentences.length - 1);
        listenActive = true;
        listenPaused = false;
        listenToken++;
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
    }

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
        listenIdx = (listenIdx + 1) % sentences.length;
        currentIdx = listenIdx;
        saveState();
        listenToken++;
        if (listenTimer) { clearTimeout(listenTimer); listenTimer = null; }
        window.App?.stopSpeak?.();
        renderListenView();
        if (!listenPaused) playListenLoop(listenToken);
    }

    function prevListen() {
        if (!listenActive) return;
        listenIdx = (listenIdx - 1 + sentences.length) % sentences.length;
        currentIdx = listenIdx;
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

    // Core playback loop. Uses a token so that if the user hits
    // Pause/Next/Prev mid-utterance, the stale onEnd callback from the
    // old utterance sees myToken !== listenToken and returns silently.
    function playListenLoop(myToken) {
        if (!listenActive || listenPaused || myToken !== listenToken) return;
        const s = sentences[listenIdx];
        if (!s) { stopListen(); return; }

        const baseRate = getListenRate();
        const slowRate = baseRate * LISTEN_SLOW_MULT;
        const cnOn     = isListenCNEnabled();

        // Advance helper — runs after the English playback finishes,
        // and optionally plays Chinese before moving to the next sentence.
        const advanceToNext = () => {
            if (myToken !== listenToken || !listenActive || listenPaused) return;
            listenIdx = (listenIdx + 1) % sentences.length;
            currentIdx = listenIdx;
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
    function renderListenView() {
        const area = container?.querySelector('#sd-exercise-area');
        if (!area) return;
        const s = sentences[listenIdx];
        if (!s) return;

        area.innerHTML = `
        <div class="ec-card sd-listen-card">
            <div class="ec-card-top sd-listen-top">
                <span class="ec-card-cat sd-listen-badge" style="background:var(--accent-bg);color:var(--accent)">
                    &#x1F3A7; ${listenIdx + 1}/${sentences.length}
                </span>
                <span id="sd-listen-phase" class="sd-listen-phase">&#x1F50A; EN</span>
            </div>

            <div class="sd-listen-sentence" id="sd-listen-en">${escHtml(s.sentence_en)}</div>
            <div class="sd-listen-cn ${isListenCNEnabled() ? '' : 'sd-listen-cn-muted'}" id="sd-listen-cn">${escHtml(s.sentence_cn)}</div>

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
        </div>`;

        area.querySelector('#sd-listen-playpause')?.addEventListener('click', () => {
            if (listenPaused) resumeListen(); else pauseListen();
        });
        area.querySelector('#sd-listen-prev')?.addEventListener('click', prevListen);
        area.querySelector('#sd-listen-next')?.addEventListener('click', nextListen);
        area.querySelector('#sd-listen-restart')?.addEventListener('click', restartCurrent);
        area.querySelector('#sd-listen-cn-btn')?.addEventListener('click', toggleListenCN);
        area.querySelector('#sd-listen-exit')?.addEventListener('click', () => {
            stopListen();
            render();  // back to toolbar + start prompt
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
            listenIdx = (listenIdx + 1) % sentences.length;
            currentIdx = listenIdx;
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

    return { init, stopListen, isListenActive: () => listenActive };
})();
