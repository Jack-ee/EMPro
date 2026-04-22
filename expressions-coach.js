/**
 * Expression Coach Module — expressions-coach.js
 *
 * Three drill modes for native English phrasing:
 *   1. Fill-in-the-blank — clickable word bank (no typing)
 *   2. Scenario pick — multiple choice
 *   3. Rephrase drill — AI-evaluated via Claude API
 */

const ExpressionCoach = (() => {

    // ─── State ───────────────────────────────────────────────────
    let container     = null;
    let progress      = {};
    let currentExpr   = null;
    let currentMode   = "fill-blank";
    let currentCat    = "all";
    let queue         = [];
    let queueIndex    = 0;
    let filledSlots   = [];   // tracks which word is in each blank slot

    // Storage helpers — profile-scoped via DB
    function loadFromStorage(name, fallback) {
        try {
            const raw = window.DB?.getPref('__ec_' + name, null);
            return raw ? JSON.parse(raw) : fallback;
        } catch { return fallback; }
    }
    function saveToStorage(name, data) {
        window.DB?.setPref('__ec_' + name, JSON.stringify(data));
    }

    // ─── Init ────────────────────────────────────────────────────
    function init(el) {
        container = el;
        migrateOldStorage();
        loadProgress();
        loadCustomExpressions();
        render();
    }

    // ─── One-time migration from old non-scoped keys ─────────────
    function migrateOldStorage() {
        try {
            // Migrate expr_progress → profile-scoped
            const oldProgress = localStorage.getItem('expr_progress');
            if (oldProgress && !window.DB?.getPref('__ec_progress', null)) {
                window.DB?.setPref('__ec_progress', oldProgress);
                localStorage.removeItem('expr_progress');
                console.log('[ExprCoach] Migrated expr_progress to profile-scoped storage');
            }
            // Migrate expr_custom → profile-scoped
            const oldCustom = localStorage.getItem('expr_custom');
            if (oldCustom && !window.DB?.getPref('__ec_custom', null)) {
                window.DB?.setPref('__ec_custom', oldCustom);
                localStorage.removeItem('expr_custom');
                console.log('[ExprCoach] Migrated expr_custom to profile-scoped storage');
            }
        } catch (e) {
            console.warn('[ExprCoach] Migration error:', e);
        }
    }

    // ─── Progress persistence ────────────────────────────────────
    function loadProgress() {
        progress = loadFromStorage('progress', {});
    }
    function saveProgress() {
        saveToStorage('progress', progress);
    }
    function getProgress(id) {
        if (!progress[id]) {
            progress[id] = { seen: 0, practiced: 0, mastered: false, lastType: null, lastDate: null };
        }
        return progress[id];
    }
    function markPracticed(id, type) {
        const p      = getProgress(id);
        p.seen      += 1;
        p.practiced += 1;
        p.lastType   = type;
        p.lastDate   = new Date().toISOString().slice(0, 10);
        if (p.practiced >= 6) p.mastered = true;
        saveProgress();
    }

    // ─── Queue builder ───────────────────────────────────────────
    function buildQueue() {
        let pool = window.EXPRESSIONS || [];
        if (currentCat !== "all") pool = pool.filter(e => e.cat === currentCat);
        const unmastered = pool.filter(e => !getProgress(e.id).mastered);
        const mastered   = pool.filter(e =>  getProgress(e.id).mastered);
        queue      = shuffle(unmastered).concat(shuffle(mastered));
        queueIndex = 0;
    }

    function nextExpr() {
        if (queue.length === 0) buildQueue();
        if (queueIndex >= queue.length) { queueIndex = 0; queue = shuffle(queue); }
        currentExpr = queue[queueIndex++];
        filledSlots = [];
        renderExercise();
    }

    function prevExpr() {
        if (queue.length === 0 || queueIndex <= 1) return;
        queueIndex -= 2; // -2 because queueIndex already points to *next* item
        if (queueIndex < 0) queueIndex = 0;
        currentExpr = queue[queueIndex++];
        filledSlots = [];
        renderExercise();
    }

    // ─── Distractor generator ────────────────────────────────────
    function getDistractors(correctAnswers, count) {
        const allWords = [];
        const correctSet = new Set(correctAnswers.map(a => a.toLowerCase()));
        (window.EXPRESSIONS || []).forEach(e => {
            (e.blankAnswers || []).forEach(w => {
                if (!correctSet.has(w.toLowerCase())) allWords.push(w);
            });
        });
        const fillers = [
            "make", "very", "quite", "really", "about", "from",
            "should", "could", "would", "into", "onto", "upon",
            "carefully", "quickly", "simply", "directly", "exactly",
            "improve", "remove", "adjust", "arrange", "ensure",
            "clearly", "correctly", "naturally", "entirely"
        ];
        fillers.forEach(f => { if (!correctSet.has(f)) allWords.push(f); });
        const unique = [...new Set(allWords.map(w => w.toLowerCase()))];
        return shuffle(unique).slice(0, count);
    }

    // ─── Render: main layout ─────────────────────────────────────
    function render() {
        const cats  = window.EXPR_CATEGORIES || {};
        const exprs = window.EXPRESSIONS || [];
        const total     = exprs.length;
        const mastered  = exprs.filter(e => getProgress(e.id).mastered).length;
        const practiced = exprs.filter(e => getProgress(e.id).practiced > 0).length;

        container.innerHTML = `
        <div class="ec-wrapper">
            <!-- Compact toolbar: dropdowns + stats + start -->
            <div class="ec-toolbar">
                <select class="ec-select" id="ec-mode-select">
                    <option value="fill-blank" ${currentMode === 'fill-blank' ? 'selected' : ''}>Fill Blank</option>
                    <option value="scenario"   ${currentMode === 'scenario'   ? 'selected' : ''}>Scenario</option>
                    <option value="rephrase"   ${currentMode === 'rephrase'   ? 'selected' : ''}>Rephrase</option>
                </select>
                <select class="ec-select ec-select-cat" id="ec-cat-select">
                    <option value="all" ${currentCat === 'all' ? 'selected' : ''}>All (${total})</option>
                    ${Object.entries(cats).map(([key, c]) => {
                        const count = exprs.filter(e => e.cat === key).length;
                        return `<option value="${key}" ${currentCat === key ? 'selected' : ''}>${c.icon} ${c.label} (${count})</option>`;
                    }).join('')}
                </select>
                <div class="ec-toolbar-stats">
                    <span class="ec-ts" title="Practiced"><span class="ec-ts-num ec-practiced">${practiced}</span>&#x2705;</span>
                    <span class="ec-ts" title="Mastered"><span class="ec-ts-num ec-mastered">${mastered}</span>&#x2B50;</span>
                </div>
                <button class="ec-btn-primary" id="ec-start-btn">&#x25B6; Start</button>
            </div>

            <div class="ec-exercise-area" id="ec-exercise-area">
                <div class="ec-start-prompt">
                    <p>Select mode and category above, then press Start.</p>
                </div>
            </div>

            <details class="ec-add-section">
                <summary class="ec-add-toggle">&#x2795; Add New Expression</summary>
                <div class="ec-add-form">
                    <input type="text" id="ec-new-expr"    class="ec-input" placeholder="Expression (e.g. 'clean it up and create a production version')">
                    <input type="text" id="ec-new-chinese" class="ec-input" placeholder="Chinese meaning">
                    <input type="text" id="ec-new-context" class="ec-input" placeholder="Original context sentence">
                    <select id="ec-new-cat" class="ec-input">
                        ${Object.entries(cats).map(([k, c]) => `<option value="${k}">${c.icon} ${c.label}</option>`).join('')}
                    </select>
                    <button class="ec-btn-primary" id="ec-add-btn">Add to Collection</button>
                    <div id="ec-add-feedback" class="ec-feedback"></div>
                </div>
            </details>

            <details class="ec-browse-section">
                <summary class="ec-add-toggle">&#x1F4D6; Browse All Expressions</summary>
                <div class="ec-browse-list" id="ec-browse-list"></div>
            </details>
        </div>`;

        // Events: dropdowns
        container.querySelector('#ec-mode-select')?.addEventListener('change', (e) => {
            currentMode = e.target.value;
            if (currentExpr) { buildQueue(); nextExpr(); }
        });
        container.querySelector('#ec-cat-select')?.addEventListener('change', (e) => {
            currentCat = e.target.value;
            buildQueue();
            if (currentExpr) nextExpr();
        });
        container.querySelector('#ec-start-btn')?.addEventListener('click', () => { buildQueue(); nextExpr(); });
        container.querySelector('#ec-add-btn')?.addEventListener('click', addNewExpression);
        container.querySelector('.ec-browse-section')?.addEventListener('toggle', (e) => {
            if (e.target.open) renderBrowseList();
        });
    }

    // ─── Render: exercise by mode ────────────────────────────────
    function supportsMode(expr, mode) {
        if (!expr) return false;
        switch (mode) {
            case 'fill-blank': return (expr.blanks?.[0] || '').includes('_____');
            case 'scenario'  : return (expr.options || []).length >= 2;
            case 'rephrase'  : return Boolean(expr.rephrase);
            default          : return false;
        }
    }

    function renderExercise() {
        if (!currentExpr) return;
        const area = container.querySelector('#ec-exercise-area');
        if (!area) return;

        // If current mode not supported, try others then skip
        if (!supportsMode(currentExpr, currentMode)) {
            const fallbackModes = ['fill-blank', 'scenario', 'rephrase'];
            const alt = fallbackModes.find(m => m !== currentMode && supportsMode(currentExpr, m));
            if (alt) {
                currentMode = alt;
                // Update dropdown to match
                const sel = container.querySelector('#ec-mode-select');
                if (sel) sel.value = alt;
            } else {
                // No mode works (custom expression with no data) — skip silently
                nextExpr();
                return;
            }
        }

        const p   = getProgress(currentExpr.id);
        const cat = (window.EXPR_CATEGORIES || {})[currentExpr.cat] || {};
        const dots = Math.min(p.practiced, 6);

        let exerciseHTML = '';
        switch (currentMode) {
            case 'fill-blank': exerciseHTML = renderFillBlank(); break;
            case 'scenario'  : exerciseHTML = renderScenario();  break;
            case 'rephrase'  : exerciseHTML = renderRephrase();  break;
        }

        const poolSize = queue.length;
        const curIdx   = Math.min(queueIndex, poolSize);

        area.innerHTML = `
        <div class="ec-card">
            <div class="ec-card-top">
                <span class="ec-card-cat" style="background:${cat.color || '#666'}20;color:${cat.color || '#666'}">
                    ${cat.icon || ''} ${cat.label || currentExpr.cat}
                </span>
                <div class="ec-card-nav-inline">
                    <button class="ec-nav-btn" id="ec-prev-btn" ${queueIndex <= 1 ? 'disabled' : ''}>&#x25C0;</button>
                    <span class="ec-nav-counter">${curIdx}/${poolSize}</span>
                    <button class="ec-nav-btn" id="ec-next-btn">&#x25B6;</button>
                </div>
                <span class="ec-card-progress">
                    ${Array.from({length: 6}, (_, i) => `<span class="ec-dot ${i < dots ? 'filled' : ''}"></span>`).join('')}
                    ${p.mastered ? ' &#x2705;' : ''}
                </span>
            </div>
            ${exerciseHTML}
            <div class="ec-card-nav">
                <button class="ec-btn-ghost" id="ec-reveal-btn">&#x1F441; Show Answer</button>
            </div>
        </div>`;

        area.querySelector('#ec-prev-btn')?.addEventListener('click', prevExpr);
        area.querySelector('#ec-next-btn')?.addEventListener('click', nextExpr);
        area.querySelector('#ec-reveal-btn')?.addEventListener('click', () => revealAnswer(area));
        bindExerciseEvents(area);
    }

    // ═════════════════════════════════════════════════════════════
    //  FILL-IN-THE-BLANK — Clickable Word Bank
    // ═════════════════════════════════════════════════════════════

    function renderFillBlank() {
        const e       = currentExpr;
        const blanks  = e.blanks?.[0] || '';
        const answers = e.blankAnswers || [];
        const blankCount = (blanks.match(/_____/g) || []).length;

        // Reset slot state
        filledSlots = new Array(blankCount).fill(null);

        // Build sentence with clickable blank slots
        let slotIdx = 0;
        const display = blanks.replace(/_____/g, () => {
            const i = slotIdx++;
            return `<span class="ec-slot" data-slot="${i}"><span class="ec-slot-num">${i + 1}</span></span>`;
        });

        // Generate word bank: correct answers + distractors
        const distractorCount = Math.max(2, Math.min(4, blankCount));
        const distractors     = getDistractors(answers, distractorCount);
        const bankWords       = shuffle([...answers, ...distractors]).map((w, i) => ({
            word : w,
            id   : `chip-${i}`
        }));

        return `
        <div class="ec-exercise ec-fill">
            <div class="ec-prompt-label">Tap words to fill the blanks:</div>
            <div class="ec-fill-sentence" id="ec-fill-sentence">${display}</div>
            <div class="ec-word-bank" id="ec-word-bank">
                ${bankWords.map(w => `
                    <button class="ec-chip" data-chip-id="${w.id}" data-word="${escAttr(w.word)}">${escHtml(w.word)}</button>
                `).join('')}
            </div>
            <button class="ec-btn-primary ec-check-btn" id="ec-fill-check">Check</button>
            <div class="ec-result" id="ec-fill-result"></div>
        </div>
        <div class="ec-context-hint">
            <div class="ec-hint-label">&#x1F4A1; Context:</div>
            <div class="ec-hint-text">${escHtml(e.general)}</div>
        </div>`;
    }

    function handleChipClick(chip, area) {
        if (chip.disabled) return;
        const word = chip.dataset.word;
        // Find first empty slot
        const emptyIdx = filledSlots.indexOf(null);
        if (emptyIdx === -1) return;

        // Place word in slot
        filledSlots[emptyIdx] = { word: word, chipId: chip.dataset.chipId };
        chip.classList.add('ec-chip-used');
        chip.disabled = true;

        // Update slot display
        const slot = area.querySelector(`.ec-slot[data-slot="${emptyIdx}"]`);
        if (slot) {
            slot.innerHTML = `<span class="ec-slot-word">${escHtml(word)}</span>`;
            slot.classList.add('ec-slot-filled');
        }

        // Clear any previous wrong markers
        area.querySelectorAll('.ec-slot-wrong').forEach(s => s.classList.remove('ec-slot-wrong'));
    }

    function handleSlotClick(slot, area) {
        const idx = parseInt(slot.dataset.slot);
        if (filledSlots[idx] === null) return;

        // Return chip to bank
        const chipId = filledSlots[idx].chipId;
        const chip = area.querySelector(`[data-chip-id="${chipId}"]`);
        if (chip) {
            chip.classList.remove('ec-chip-used');
            chip.disabled = false;
        }

        // Clear slot
        filledSlots[idx] = null;
        slot.innerHTML = `<span class="ec-slot-num">${idx + 1}</span>`;
        slot.classList.remove('ec-slot-filled', 'ec-slot-correct', 'ec-slot-wrong');
    }

    function checkFillBlank(area) {
        const e       = currentExpr;
        const answers = e.blankAnswers || [];
        let allCorrect = true;
        let allFilled  = true;

        filledSlots.forEach((entry, i) => {
            const slot = area.querySelector(`.ec-slot[data-slot="${i}"]`);
            if (!slot) return;

            if (!entry) {
                allFilled  = false;
                allCorrect = false;
                slot.classList.add('ec-slot-wrong');
                return;
            }

            const expected = (answers[i] || '').toLowerCase();
            const actual   = entry.word.toLowerCase();
            const correct  = actual === expected;

            slot.classList.remove('ec-slot-correct', 'ec-slot-wrong');
            slot.classList.add(correct ? 'ec-slot-correct' : 'ec-slot-wrong');
            if (!correct) allCorrect = false;
        });

        const resultEl = area.querySelector('#ec-fill-result');
        if (!allFilled) {
            resultEl.innerHTML = `<div class="ec-result-wrong">Fill all blanks first.</div>`;
            return;
        }

        if (allCorrect) {
            markPracticed(e.id, 'fill-blank');
            area.querySelectorAll('.ec-chip').forEach(c => c.disabled = true);
            area.querySelectorAll('.ec-slot').forEach(s => s.style.pointerEvents = 'none');
            resultEl.innerHTML = `
                <div class="ec-result-correct">&#x2705; Correct!</div>
                <div class="ec-result-expr">
                    <strong>Expression:</strong> ${escHtml(e.expr)}<br>
                    <strong>&#x4E2D;&#x6587;:</strong> ${escHtml(e.chinese)}
                </div>
                <div class="ec-result-original">
                    <strong>Original context:</strong> ${escHtml(e.original)}
                </div>
                ${saveExprBtnHTML(e)}
                <button class="ec-btn-primary ec-next-btn">Next &#x2192;</button>`;
        } else {
            resultEl.innerHTML = `<div class="ec-result-wrong">&#x274C; Not quite &#x2014; tap a filled blank to change it, or reveal the answer.</div>`;
        }
        resultEl.querySelector('.ec-next-btn')?.addEventListener('click', nextExpr);
        bindSaveToNotebook(resultEl);
        updateStats();
    }

    // ═════════════════════════════════════════════════════════════
    //  SCENARIO PICK
    // ═════════════════════════════════════════════════════════════

    function renderScenario() {
        const e           = currentExpr;
        const correctText = e.options[0];
        const options     = shuffle([...e.options]).map((opt, i) => ({ text: opt, idx: i }));

        return `
        <div class="ec-exercise ec-scenario">
            <div class="ec-prompt-label">Which sounds most natural?</div>
            <div class="ec-scenario-context">${escHtml(e.general)}</div>
            <div class="ec-scenario-options">
                ${options.map((o, i) => `
                    <button class="ec-option-btn" data-correct="${o.text === correctText}">
                        <span class="ec-option-letter">${String.fromCharCode(65 + i)}</span>
                        ${escHtml(o.text)}
                    </button>
                `).join('')}
            </div>
            <div class="ec-result" id="ec-scenario-result"></div>
        </div>`;
    }

    function checkScenario(btn, area) {
        const e       = currentExpr;
        const correct = btn.dataset.correct === 'true';

        area.querySelectorAll('.ec-option-btn').forEach(b => {
            b.disabled = true;
            if (b.dataset.correct === 'true') b.classList.add('ec-correct');
        });
        if (correct) {
            btn.classList.add('ec-correct');
            markPracticed(e.id, 'scenario');
        } else {
            btn.classList.add('ec-wrong');
        }

        const resultEl = area.querySelector('#ec-scenario-result');
        resultEl.innerHTML = `
            <div class="${correct ? 'ec-result-correct' : 'ec-result-wrong'}">
                ${correct ? '&#x2705; Correct!' : '&#x274C; Not quite.'}
            </div>
            <div class="ec-result-expr">
                <strong>Native phrasing:</strong> ${escHtml(e.expr)}<br>
                <strong>&#x4E2D;&#x6587;:</strong> ${escHtml(e.chinese)}<br>
                <strong>Pattern:</strong> <code>${escHtml(e.pattern)}</code>
            </div>
            ${saveExprBtnHTML(e)}
            <button class="ec-btn-primary ec-next-btn">Next &#x2192;</button>`;
        resultEl.querySelector('.ec-next-btn')?.addEventListener('click', nextExpr);
        bindSaveToNotebook(resultEl);
        updateStats();
    }

    // ═════════════════════════════════════════════════════════════
    //  REPHRASE DRILL (AI-powered)
    // ═════════════════════════════════════════════════════════════

    function renderRephrase() {
        const e = currentExpr;
        return `
        <div class="ec-exercise ec-rephrase">
            <div class="ec-prompt-label">Rephrase this more naturally:</div>
            <div class="ec-rephrase-prompt">"${escHtml(e.rephrase)}"</div>
            <textarea class="ec-rephrase-input" id="ec-rephrase-input" rows="3"
                      placeholder="Write your version here..." spellcheck="true"></textarea>
            <button class="ec-btn-primary ec-check-btn" id="ec-rephrase-check">Evaluate with AI</button>
            <div class="ec-result" id="ec-rephrase-result"></div>
        </div>
        <div class="ec-context-hint">
            <div class="ec-hint-label">&#x1F3AF; Target pattern:</div>
            <div class="ec-hint-text"><code>${escHtml(e.pattern)}</code></div>
        </div>`;
    }

    async function checkRephrase(area) {
        const e         = currentExpr;
        const userInput = area.querySelector('#ec-rephrase-input')?.value?.trim();
        if (!userInput) return;

        const resultEl = area.querySelector('#ec-rephrase-result');
        const checkBtn = area.querySelector('#ec-rephrase-check');
        checkBtn.disabled    = true;
        checkBtn.textContent = 'Evaluating...';
        resultEl.innerHTML   = '<div class="ec-loading">Asking AI to evaluate...</div>';

        try {
            const evaluation = await evaluateWithAI(e, userInput);
            markPracticed(e.id, 'rephrase');

            resultEl.innerHTML = `
                <div class="ec-ai-result">
                    <div class="ec-ai-score">Score: <strong>${evaluation.score}/10</strong></div>
                    <div class="ec-ai-feedback">${escHtml(evaluation.feedback)}</div>
                    ${evaluation.improved ? `<div class="ec-ai-improved"><strong>Suggested:</strong> ${escHtml(evaluation.improved)}</div>` : ''}
                </div>
                <div class="ec-result-expr">
                    <strong>Target expression:</strong> ${escHtml(e.expr)}<br>
                    <strong>&#x4E2D;&#x6587;:</strong> ${escHtml(e.chinese)}
                </div>
                <div class="ec-result-original">
                    <strong>Original context:</strong> ${escHtml(e.original)}
                </div>
                ${saveExprBtnHTML(e)}
                <button class="ec-btn-primary ec-next-btn">Next &#x2192;</button>`;
        } catch (err) {
            const friendlyMsg  = window.AIEngine?.friendlyError?.(err) || 'AI evaluation unavailable.';
            const similarity   = computeSimilarity(userInput.toLowerCase(), e.expr.toLowerCase());
            resultEl.innerHTML = `
                <div class="ec-ai-result">
                    <div class="ec-ai-score">Pattern match: <strong>${Math.round(similarity * 100)}%</strong></div>
                    <div class="ec-ai-feedback">${escHtml(friendlyMsg)} Fallback comparison used.</div>
                </div>
                <div class="ec-result-expr">
                    <strong>Target expression:</strong> ${escHtml(e.expr)}<br>
                    <strong>&#x4E2D;&#x6587;:</strong> ${escHtml(e.chinese)}
                </div>
                ${saveExprBtnHTML(e)}
                <button class="ec-btn-primary ec-next-btn">Next &#x2192;</button>`;
        }

        checkBtn.disabled    = false;
        checkBtn.textContent = 'Evaluate with AI';
        resultEl.querySelector('.ec-next-btn')?.addEventListener('click', nextExpr);
        bindSaveToNotebook(resultEl);
        updateStats();
    }

    async function evaluateWithAI(expr, userInput) {
        const prompt = `You are an English expression coach. Evaluate the learner's rephrase attempt.

TARGET EXPRESSION: "${expr.expr}"
PATTERN: "${expr.pattern}"
ORIGINAL CLUMSY SENTENCE: "${expr.rephrase}"
LEARNER'S ATTEMPT: "${userInput}"

Evaluate how natural the learner's phrasing is and whether they captured the target expression pattern.

Return a JSON object:
{"score": <1-10>, "feedback": "<1-2 sentences in English, then 1 sentence in Chinese>", "improved": "<your suggested best version, or null if score >= 8>"}`;

        return await window.AIEngine.callClaudeJSON(
            prompt,
            userInput,
            { maxTokens: 500 }
        );
    }

    // ─── Bind exercise events ────────────────────────────────────
    function bindExerciseEvents(area) {
        // Fill-blank: word bank chips
        area.querySelectorAll('.ec-chip').forEach(chip => {
            chip.addEventListener('click', () => handleChipClick(chip, area));
        });
        // Fill-blank: click filled slot to remove
        area.querySelector('#ec-fill-sentence')?.addEventListener('click', (e) => {
            const slot = e.target.closest('.ec-slot-filled');
            if (slot) handleSlotClick(slot, area);
        });
        // Fill-blank: check button
        area.querySelector('#ec-fill-check')?.addEventListener('click', () => checkFillBlank(area));
        // Scenario: option buttons
        area.querySelectorAll('.ec-option-btn').forEach(btn => {
            btn.addEventListener('click', () => checkScenario(btn, area));
        });
        // Rephrase: check button + Ctrl+Enter
        area.querySelector('#ec-rephrase-check')?.addEventListener('click', () => checkRephrase(area));
        area.querySelector('#ec-rephrase-input')?.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
                ev.preventDefault();
                area.querySelector('#ec-rephrase-check')?.click();
            }
        });
    }

    // ─── Reveal answer ───────────────────────────────────────────
    function revealAnswer(area) {
        const e = currentExpr;
        if (!e) return;

        let answerHTML = '';
        if (currentMode === 'fill-blank') {
            answerHTML = (e.blankAnswers || []).map((a, i) =>
                `<span class="ec-reveal-chip">(${i + 1}) ${escHtml(a)}</span>`
            ).join(' ');
        } else if (currentMode === 'rephrase') {
            answerHTML = `<strong>${escHtml(e.expr)}</strong>`;
        }

        const resultEl = area.querySelector('.ec-result') || area.querySelector('#ec-fill-result');
        if (resultEl) {
            resultEl.innerHTML = `
                <div class="ec-result-reveal">
                    <div class="ec-reveal-label">Answer:</div>
                    <div>${answerHTML || escHtml(e.expr)}</div>
                    <div class="ec-result-expr" style="margin-top:8px">
                        <strong>&#x4E2D;&#x6587;:</strong> ${escHtml(e.chinese)}<br>
                        <strong>Pattern:</strong> <code>${escHtml(e.pattern)}</code>
                    </div>
                    <div class="ec-result-original" style="margin-top:8px">
                        <strong>Original:</strong> ${escHtml(e.original)}
                    </div>
                </div>
                ${saveExprBtnHTML(e)}
                <button class="ec-btn-primary ec-next-btn" style="margin-top:8px">Next &#x2192;</button>`;
            resultEl.querySelector('.ec-next-btn')?.addEventListener('click', nextExpr);
            bindSaveToNotebook(resultEl);
        }
    }

    // ─── Browse list ─────────────────────────────────────────────
    function renderBrowseList() {
        const listEl = container.querySelector('#ec-browse-list');
        if (!listEl) return;
        const cats  = window.EXPR_CATEGORIES || {};
        const exprs = window.EXPRESSIONS || [];
        const grouped = {};
        exprs.forEach(e => {
            if (!grouped[e.cat]) grouped[e.cat] = [];
            grouped[e.cat].push(e);
        });

        listEl.innerHTML = Object.entries(grouped).map(([cat, items]) => {
            const c = cats[cat] || {};
            return `
            <div class="ec-browse-cat">
                <h3 class="ec-browse-cat-title" style="color:${c.color || 'var(--text-primary)'}">${c.icon || ''} ${c.label || cat}</h3>
                ${items.map(e => {
                    const p = getProgress(e.id);
                    return `
                    <div class="ec-browse-item ${p.mastered ? 'ec-mastered' : ''}">
                        <div class="ec-browse-expr">${escHtml(e.expr)}</div>
                        <div class="ec-browse-zh">${escHtml(e.chinese)}</div>
                        <div class="ec-browse-pattern"><code>${escHtml(e.pattern)}</code></div>
                        <div class="ec-browse-meta">Practiced: ${p.practiced}x ${p.mastered ? '&#x2705;' : ''}</div>
                    </div>`;
                }).join('')}
            </div>`;
        }).join('');
    }

    // ─── Add new expression ──────────────────────────────────────
    function addNewExpression() {
        const expr    = container.querySelector('#ec-new-expr')?.value?.trim();
        const chinese = container.querySelector('#ec-new-chinese')?.value?.trim();
        const context = container.querySelector('#ec-new-context')?.value?.trim();
        const cat     = container.querySelector('#ec-new-cat')?.value;
        const fb      = container.querySelector('#ec-add-feedback');

        if (!expr) { if (fb) fb.textContent = 'Expression is required.'; return; }

        const id = cat.slice(0, 3) + '_' + String(Date.now()).slice(-4);
        const newItem = {
            id, cat, expr,
            chinese      : chinese || '',
            pattern      : expr,
            original     : context || '',
            general      : context || '',
            blanks       : [],
            blankAnswers : [],
            options      : [expr],
            rephrase     : ''
        };

        let custom = loadFromStorage('custom', []);
        custom.push(newItem);
        saveToStorage('custom', custom);
        window.EXPRESSIONS.push(newItem);

        container.querySelector('#ec-new-expr').value   = '';
        container.querySelector('#ec-new-chinese').value = '';
        container.querySelector('#ec-new-context').value  = '';
        if (fb) { fb.textContent = `Added "${expr}"`; fb.style.color = 'var(--success)'; }
        buildQueue();
    }

    // ─── Update stats ────────────────────────────────────────────
    function updateStats() {
        const exprs     = window.EXPRESSIONS || [];
        const mastered  = exprs.filter(e => getProgress(e.id).mastered).length;
        const practiced = exprs.filter(e => getProgress(e.id).practiced > 0).length;
        const mEl = container.querySelector('.ec-mastered');
        const pEl = container.querySelector('.ec-practiced');
        if (mEl) mEl.textContent = mastered;
        if (pEl) pEl.textContent = practiced;
    }

    // ─── Load custom expressions ─────────────────────────────────
    function loadCustomExpressions() {
        try {
            const custom   = loadFromStorage('custom', []);
            const existing = new Set((window.EXPRESSIONS || []).map(e => e.id));
            custom.forEach(item => { if (!existing.has(item.id)) window.EXPRESSIONS.push(item); });
        } catch {}
    }

    // ─── Save to Notebook ──────────────────────────────────────
    function saveExprBtnHTML(expr) {
        return `<button class="ec-btn-secondary ec-save-nb" data-expr-id="${expr.id}"
                    style="margin-top:6px">&#x1F4D5; Save to Notebook</button>`;
    }

    function bindSaveToNotebook(area) {
        area.querySelectorAll('.ec-save-nb').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.exprId;
                const expr = (window.EXPRESSIONS || []).find(e => e.id === id);
                if (!expr || !window.DB) return;

                window.DB.upsertNotebookWord({
                    word    : expr.expr,
                    meaning : expr.chinese,
                    collo   : expr.pattern,
                    context : expr.original,
                    source  : 'Expression Coach',
                    tags    : [expr.cat]
                });
                btn.textContent = '&#x2705; Saved';
                btn.disabled    = true;
                window.App?.updateNotebookBadge?.();
                window.App?.showToast?.(`Saved: ${expr.expr}`);
            });
        });
    }

    // ─── Utilities ───────────────────────────────────────────────
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
    function computeSimilarity(a, b) {
        const m = a.length, n = b.length;
        const dp = Array.from({length: m + 1}, () => Array(n + 1).fill(0));
        for (let i = 0; i <= m; i++) dp[i][0] = i;
        for (let j = 0; j <= n; j++) dp[0][j] = j;
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
            }
        }
        return Math.max(m, n) === 0 ? 1 : 1 - dp[m][n] / Math.max(m, n);
    }

    return {
        init,
        getProgress   : () => progress,
        getCategories : () => window.EXPR_CATEGORIES,
        getTotal      : () => (window.EXPRESSIONS || []).length,
        getMastered   : () => (window.EXPRESSIONS || []).filter(e => getProgress(e.id).mastered).length,
    };

})();

// Expose as global so app.js bootstrap can invoke ExpressionCoach.init().
// (Top-level `const` declarations don't auto-attach to `window` in modern
// browsers, unlike top-level `var` — this assignment is required.)
window.ExpressionCoach = ExpressionCoach;
