// ============================================================
// vocab-drill.js — Contextual Vocabulary Drill Module
// ============================================================

window.VocabDrill = (function() {

    let currentDrill    = null;
    let drillQueue      = [];
    let drillIndex      = 0;
    let drillScore      = 0;
    let drillTotal      = 0;
    let isProcessing    = false;

    // --- Pre-built synonym groups for instant drills (no API needed) ---
    const SYNONYM_BANK = [
        {
            group   : ["however", "nevertheless", "nonetheless", "yet", "still", "that said"],
            meaning : "expressing contrast",
            examples: {
                "however"      : { register: "neutral",  ex: "The data looks promising. However, we need more samples." },
                "nevertheless" : { register: "formal",   ex: "The results were inconclusive; nevertheless, the study advanced our understanding." },
                "nonetheless"  : { register: "formal",   ex: "The project was delayed. Nonetheless, the team met the final deadline." },
                "yet"          : { register: "neutral",  ex: "She studied hard, yet she didn't pass the exam." },
                "still"        : { register: "casual",   ex: "I know it's expensive. Still, I think it's worth it." },
                "that said"    : { register: "casual",   ex: "The restaurant is pricey. That said, the food is incredible." }
            }
        },
        {
            group   : ["therefore", "thus", "hence", "consequently", "as a result", "so"],
            meaning : "expressing cause and effect",
            examples: {
                "therefore"     : { register: "formal",  ex: "The sample size was insufficient; therefore, the conclusions are tentative." },
                "thus"          : { register: "formal",  ex: "The algorithm optimizes for speed, thus reducing computation time." },
                "hence"         : { register: "formal",  ex: "The data was corrupted, hence the anomalous results." },
                "consequently"  : { register: "formal",  ex: "Funding was cut. Consequently, three projects were shelved." },
                "as a result"   : { register: "neutral", ex: "Sales dropped 20%. As a result, the company restructured." },
                "so"            : { register: "casual",  ex: "I was running late, so I took a taxi." }
            }
        },
        {
            group   : ["suggest", "propose", "recommend", "advise", "advocate", "urge"],
            meaning : "making suggestions",
            examples: {
                "suggest"   : { register: "neutral", ex: "I'd suggest starting with a smaller sample." },
                "propose"   : { register: "formal",  ex: "We propose a three-phase implementation strategy." },
                "recommend" : { register: "neutral", ex: "I'd recommend backing up your data before updating." },
                "advise"    : { register: "formal",  ex: "The committee advises against further delays." },
                "advocate"  : { register: "formal",  ex: "Several researchers advocate a more cautious approach." },
                "urge"      : { register: "neutral", ex: "I urge you to reconsider before the deadline." }
            }
        },
        {
            group   : ["important", "significant", "crucial", "vital", "essential", "critical"],
            meaning : "expressing importance",
            examples: {
                "important"   : { register: "neutral", ex: "It's important to proofread before submitting." },
                "significant" : { register: "formal",  ex: "The study found a statistically significant correlation." },
                "crucial"     : { register: "neutral", ex: "Timing is crucial in competitive markets." },
                "vital"       : { register: "neutral", ex: "Clean water is vital for public health." },
                "essential"   : { register: "neutral", ex: "Version control is essential for team projects." },
                "critical"    : { register: "formal",  ex: "A critical review of existing literature reveals several gaps." }
            }
        },
        {
            group   : ["begin", "start", "commence", "initiate", "launch", "kick off"],
            meaning : "starting something",
            examples: {
                "begin"    : { register: "neutral", ex: "Let's begin with a brief overview." },
                "start"    : { register: "casual",  ex: "We can start whenever you're ready." },
                "commence" : { register: "formal",  ex: "The trial will commence on Monday at 9 AM." },
                "initiate" : { register: "formal",  ex: "The board voted to initiate an investigation." },
                "launch"   : { register: "neutral", ex: "We plan to launch the product next quarter." },
                "kick off" : { register: "casual",  ex: "Let's kick off the meeting with updates." }
            }
        },
        {
            group   : ["think", "believe", "consider", "reckon", "suppose", "maintain"],
            meaning : "expressing opinion",
            examples: {
                "think"    : { register: "neutral", ex: "I think the approach has merit." },
                "believe"  : { register: "neutral", ex: "We believe this method is more efficient." },
                "consider" : { register: "formal",  ex: "Many scholars consider this theory outdated." },
                "reckon"   : { register: "casual",  ex: "I reckon we'll be done by Friday." },
                "suppose"  : { register: "neutral", ex: "I suppose we could try a different angle." },
                "maintain" : { register: "formal",  ex: "The authors maintain that further research is needed." }
            }
        },
        {
            group   : ["get", "obtain", "acquire", "secure", "procure", "gain"],
            meaning : "obtaining something",
            examples: {
                "get"     : { register: "casual",  ex: "Can you get me the latest report?" },
                "obtain"  : { register: "formal",  ex: "Participants must obtain written consent." },
                "acquire" : { register: "formal",  ex: "The company acquired three startups last year." },
                "secure"  : { register: "neutral", ex: "We managed to secure additional funding." },
                "procure" : { register: "formal",  ex: "The department procured new equipment for the lab." },
                "gain"    : { register: "neutral", ex: "Students gain hands-on experience through internships." }
            }
        },
        {
            group   : ["show", "demonstrate", "illustrate", "indicate", "reveal", "exhibit"],
            meaning : "presenting evidence",
            examples: {
                "show"        : { register: "neutral", ex: "The results show a clear trend." },
                "demonstrate" : { register: "formal",  ex: "These findings demonstrate the feasibility of the approach." },
                "illustrate"  : { register: "formal",  ex: "Figure 3 illustrates the relationship between variables." },
                "indicate"    : { register: "formal",  ex: "Preliminary data indicate a positive outcome." },
                "reveal"      : { register: "neutral", ex: "The survey revealed surprising preferences." },
                "exhibit"     : { register: "formal",  ex: "Participants exhibited higher engagement levels." }
            }
        },
        {
            group   : ["help", "assist", "facilitate", "aid", "support", "lend a hand"],
            meaning : "providing help",
            examples: {
                "help"        : { register: "neutral", ex: "Can you help me with this analysis?" },
                "assist"      : { register: "formal",  ex: "A teaching assistant will assist with grading." },
                "facilitate"  : { register: "formal",  ex: "The new platform facilitates cross-team collaboration." },
                "aid"         : { register: "formal",  ex: "Visual cues aid comprehension in language learning." },
                "support"     : { register: "neutral", ex: "The evidence supports this hypothesis." },
                "lend a hand" : { register: "casual",  ex: "Could you lend a hand with the setup?" }
            }
        },
        {
            group   : ["problem", "issue", "challenge", "obstacle", "hurdle", "setback"],
            meaning : "describing difficulties",
            examples: {
                "problem"   : { register: "neutral", ex: "The main problem is insufficient data." },
                "issue"     : { register: "neutral", ex: "We've identified a few issues with the prototype." },
                "challenge" : { register: "neutral", ex: "Scaling the model remains a major challenge." },
                "obstacle"  : { register: "neutral", ex: "Regulatory requirements pose a significant obstacle." },
                "hurdle"    : { register: "neutral", ex: "The first hurdle is getting stakeholder buy-in." },
                "setback"   : { register: "neutral", ex: "The supply chain disruption was a major setback." }
            }
        }
    ];

    // Collocation bank
    const COLLOCATION_BANK = [
        { word: "make",  correct: "a decision",     wrong: ["a choose", "a decide", "a select"] },
        { word: "do",    correct: "research",        wrong: ["a research", "make research", "take research"] },
        { word: "take",  correct: "into account",    wrong: ["into consider", "in account", "to account"] },
        { word: "draw",  correct: "a conclusion",    wrong: ["a concluding", "the conclude", "out conclusion"] },
        { word: "raise", correct: "a concern",       wrong: ["a worry up", "up concern", "a concerning"] },
        { word: "reach", correct: "a consensus",     wrong: ["to consensing", "a consense", "the agree"] },
        { word: "pay",   correct: "attention to",    wrong: ["focus at", "notice at", "attention at"] },
        { word: "bear",  correct: "in mind",         wrong: ["in brain", "on mind", "in head"] },
        { word: "catch", correct: "someone's eye",   wrong: ["someone's look", "the eye of", "someone's sight"] },
        { word: "break", correct: "the ice",         wrong: ["the cold", "the freeze", "the silence awkward"] },
        { word: "meet",  correct: "a deadline",      wrong: ["the deadline up", "a due date on", "time the deadline"] },
        { word: "run",   correct: "a risk",          wrong: ["a danger", "the risky", "a chance bad"] },
        { word: "shed",  correct: "light on",        wrong: ["lights at", "a light for", "lighting on"] },
        { word: "strike",correct: "a balance",       wrong: ["the balance up", "a balancing", "out balance"] },
        { word: "have",  correct: "second thoughts", wrong: ["two thoughts", "again thoughts", "re-thoughts"] },
        { word: "give",  correct: "someone the benefit of the doubt", wrong: ["someone the good doubt", "someone doubt benefit", "benefit doubt to"] },
        { word: "keep",  correct: "someone posted",  wrong: ["someone updated on", "someone in the post", "post someone"] },
        { word: "come",  correct: "to terms with",   wrong: ["to agreement with", "at terms for", "terms about"] },
        { word: "play",  correct: "it by ear",       wrong: ["it with ear", "by the ear", "ear on it"] },
        { word: "turn",  correct: "a blind eye",     wrong: ["a close eye", "blind the eye", "eye blindly"] }
    ];

    function init() {
        bindEvents();
    }

    function bindEvents() {
        document.getElementById('vd-start-synonym')?.addEventListener('click', () => startSynonymDrill());
        document.getElementById('vd-start-collocation')?.addEventListener('click', () => startCollocationDrill());
        document.getElementById('vd-start-ai-drill')?.addEventListener('click', () => startAIDrill());
        document.getElementById('vd-results')?.addEventListener('click', handleResultClick);
    }

    // =====================================================
    // SYNONYM DRILL — pick the best word for the context
    // =====================================================

    function startSynonymDrill() {
        const shuffled = [...SYNONYM_BANK].sort(() => Math.random() - 0.5);
        drillQueue     = [];
        drillIndex     = 0;
        drillScore     = 0;
        drillTotal     = 0;

        // Generate 8 questions from random groups
        for (const group of shuffled.slice(0, 8)) {
            const entries = Object.entries(group.examples);
            // Pick a target word and its context
            const [targetWord, targetData] = entries[Math.floor(Math.random() * entries.length)];

            // Build options: the correct answer + 3 distractors from same group
            const others  = entries.filter(([w]) => w !== targetWord).sort(() => Math.random() - 0.5).slice(0, 3);
            const options = [
                { word: targetWord, correct: true, register: targetData.register },
                ...others.map(([w, d]) => ({ word: w, correct: false, register: d.register }))
            ].sort(() => Math.random() - 0.5);

            drillQueue.push({
                type     : 'synonym',
                sentence : targetData.ex.replace(new RegExp(`\\b${escRegex(targetWord)}\\b`, 'i'), '________'),
                answer   : targetWord,
                register : targetData.register,
                meaning  : group.meaning,
                options  : options,
                allWords : group.examples
            });
        }

        currentDrill = 'synonym';
        renderDrillQuestion();
    }

    // =====================================================
    // COLLOCATION DRILL — pick the natural collocation
    // =====================================================

    function startCollocationDrill() {
        const shuffled = [...COLLOCATION_BANK].sort(() => Math.random() - 0.5);
        drillQueue     = [];
        drillIndex     = 0;
        drillScore     = 0;
        drillTotal     = 0;

        for (const item of shuffled.slice(0, 10)) {
            const options = [
                { text: item.correct, correct: true },
                ...item.wrong.map(w => ({ text: w, correct: false }))
            ].sort(() => Math.random() - 0.5);

            drillQueue.push({
                type    : 'collocation',
                word    : item.word,
                answer  : item.correct,
                options : options
            });
        }

        currentDrill = 'collocation';
        renderDrillQuestion();
    }

    // =====================================================
    // AI-GENERATED DRILL — Claude creates context-aware questions
    // =====================================================

    async function startAIDrill() {
        if (isProcessing) return;
        if (!window.AIEngine.hasAPIKey()) {
            window.App?.showToast?.('Set your API key in Settings first.');
            return;
        }

        isProcessing = true;
        const container = document.getElementById('vd-results');
        container.innerHTML = `<div class="wl-loading"><div class="wl-loading-dots"><span></span><span></span><span></span></div><p>Claude is generating vocabulary exercises...</p></div>`;
        container.classList.add('visible');

        const prompt = (window.VOCAB_DRILL_PROMPTS && window.VOCAB_DRILL_PROMPTS.generateDrill) || '';
        if (!prompt) {
            container.innerHTML = '<div class="wl-error">AI drill prompt not configured.</div>';
            isProcessing = false;
            return;
        }

        // Pull words from notebook if available, otherwise use general
        const notebook = window.DB.loadNotebook();
        let wordHint   = '';
        if (notebook.length >= 5) {
            const sample = [...notebook].sort(() => Math.random() - 0.5).slice(0, 10).map(w => w.word);
            wordHint = `\n\nOptionally incorporate some of these words the user is learning: ${sample.join(', ')}`;
        }

        try {
            const result = await window.AIEngine.callClaudeJSON(prompt, `Generate 6 vocabulary drill questions for an advanced English learner (PhD level, native Chinese speaker).${wordHint}`);
            drillQueue = (result.questions || []).map(q => ({ ...q, type: 'ai' }));
            drillIndex = 0;
            drillScore = 0;
            drillTotal = 0;
            currentDrill = 'ai';
            renderDrillQuestion();
        } catch (err) {
            container.innerHTML = `<div class="wl-error">${window.AIEngine.friendlyError(err)}</div>`;
        } finally {
            isProcessing = false;
        }
    }

    // =====================================================
    // RENDER ENGINE
    // =====================================================

    function renderDrillQuestion() {
        const container = document.getElementById('vd-results');
        const header    = document.getElementById('vd-header');
        if (!container) return;

        // Hide drill selector when active
        if (header) header.style.display = 'none';

        if (drillIndex >= drillQueue.length) {
            renderDrillComplete();
            return;
        }

        const q       = drillQueue[drillIndex];
        drillTotal    = drillQueue.length;
        const progress = `${drillIndex + 1} / ${drillTotal}`;

        let questionHtml = '';

        if (q.type === 'synonym') {
            questionHtml = `
                <div class="vd-question-card">
                    <div class="vd-progress-bar">
                        <div class="vd-progress-fill" style="width: ${((drillIndex) / drillTotal) * 100}%"></div>
                    </div>
                    <div class="vd-q-meta">
                        <span class="vd-q-num">${progress}</span>
                        <span class="vd-q-type">Synonym drill</span>
                        <span class="vd-q-topic">${escHtml(q.meaning)}</span>
                    </div>
                    <p class="vd-q-prompt">Choose the best word to complete this sentence:</p>
                    <div class="vd-sentence">${escHtml(q.sentence)}</div>
                    <div class="vd-register-hint">Target register: <span class="wl-register-tag wl-register-${q.register}">${q.register}</span> <button class="speak-btn" data-text="${escAttr(q.sentence.replace('________', q.answer))}" title="Listen to full sentence">&#x1F50A;</button></div>
                    <div class="vd-options">
                        ${q.options.map(o => `
                            <button class="vd-option" data-word="${escAttr(o.word)}" data-correct="${o.correct}" data-register="${o.register}">
                                ${escHtml(o.word)}
                                <span class="vd-opt-register wl-register-tag wl-register-${o.register}">${o.register}</span>
                            </button>
                        `).join('')}
                    </div>
                    <div class="vd-feedback" id="vd-feedback"></div>
                </div>`;
        } else if (q.type === 'collocation') {
            questionHtml = `
                <div class="vd-question-card">
                    <div class="vd-progress-bar">
                        <div class="vd-progress-fill" style="width: ${((drillIndex) / drillTotal) * 100}%"></div>
                    </div>
                    <div class="vd-q-meta">
                        <span class="vd-q-num">${progress}</span>
                        <span class="vd-q-type">Collocation drill</span>
                    </div>
                    <p class="vd-q-prompt">Which phrase naturally follows this word?</p>
                    <div class="vd-sentence vd-collocation-word">${escHtml(q.word)} + ... <button class="speak-btn" data-text="${escAttr(q.word + ' ' + q.answer)}" title="Listen">&#x1F50A;</button></div>
                    <div class="vd-options">
                        ${q.options.map(o => `
                            <button class="vd-option" data-word="${escAttr(o.text)}" data-correct="${o.correct}">
                                ${escHtml(q.word)} ${escHtml(o.text)}
                            </button>
                        `).join('')}
                    </div>
                    <div class="vd-feedback" id="vd-feedback"></div>
                </div>`;
        } else if (q.type === 'ai') {
            const opts = (q.options || []).map(o => {
                const isCorrect = o === q.answer || o === q.correct_answer;
                return `<button class="vd-option" data-word="${escAttr(o)}" data-correct="${isCorrect}">${escHtml(o)}</button>`;
            });
            questionHtml = `
                <div class="vd-question-card">
                    <div class="vd-progress-bar">
                        <div class="vd-progress-fill" style="width: ${((drillIndex) / drillTotal) * 100}%"></div>
                    </div>
                    <div class="vd-q-meta">
                        <span class="vd-q-num">${progress}</span>
                        <span class="vd-q-type">AI drill</span>
                    </div>
                    <p class="vd-q-prompt">${escHtml(q.question || q.prompt || 'Choose the best answer:')}</p>
                    ${q.sentence ? `<div class="vd-sentence">${escHtml(q.sentence)}</div>` : ''}
                    <div class="vd-options">${opts.join('')}</div>
                    <div class="vd-feedback" id="vd-feedback"></div>
                </div>`;
        }

        container.innerHTML = questionHtml;
        container.classList.add('visible');
    }

    function handleResultClick(e) {
        const btn = e.target.closest('.vd-option');
        if (!btn || btn.disabled) return;

        const q         = drillQueue[drillIndex];
        const isCorrect = btn.dataset.correct === 'true';
        const feedbackEl = document.getElementById('vd-feedback');

        // Disable all buttons
        document.querySelectorAll('.vd-option').forEach(b => {
            b.disabled = true;
            if (b.dataset.correct === 'true') b.classList.add('vd-correct');
        });

        if (isCorrect) {
            btn.classList.add('vd-correct');
            drillScore++;
        } else {
            btn.classList.add('vd-wrong');
        }

        // Show feedback
        let feedback = '';
        if (q.type === 'synonym') {
            const answerData = q.allWords[q.answer];
            feedback = isCorrect
                ? `Correct! "${q.answer}" fits this ${q.register} context perfectly.`
                : `The best choice was "${q.answer}" (${q.register}). ${answerData?.ex || ''}`;

            // Offer to save wrong answers to notebook
            if (!isCorrect) {
                feedback += `<button class="wl-btn-tiny vd-save-btn" onclick="VocabDrill.saveToNotebook('${escAttr(q.answer)}', '${escAttr(q.meaning)}', '${escAttr(q.register)}')">+ Save to notebook</button>`;
            }
        } else if (q.type === 'collocation') {
            feedback = isCorrect
                ? `Correct! "${q.word} ${q.answer}" is a natural English collocation.`
                : `The natural collocation is "${q.word} ${q.answer}".`;

            if (!isCorrect) {
                feedback += `<button class="wl-btn-tiny vd-save-btn" onclick="VocabDrill.saveToNotebook('${escAttr(q.word + ' ' + q.answer)}', 'collocation', 'neutral')">+ Save to notebook</button>`;
            }
        } else if (q.type === 'ai') {
            const correctAns = q.answer || q.correct_answer || '';
            feedback = isCorrect
                ? `Correct! ${q.explanation || ''}`
                : `The answer was "${correctAns}". ${q.explanation || ''}`;
        }

        if (feedbackEl) {
            feedbackEl.innerHTML = `<div class="vd-feedback-msg ${isCorrect ? 'vd-fb-correct' : 'vd-fb-wrong'}">${feedback}</div>`;
            feedbackEl.classList.add('visible');
        }

        // Auto-advance after delay
        setTimeout(() => {
            drillIndex++;
            renderDrillQuestion();
        }, isCorrect ? 1500 : 3000);
    }

    function renderDrillComplete() {
        const container = document.getElementById('vd-results');
        const header    = document.getElementById('vd-header');
        const pct       = drillTotal > 0 ? Math.round((drillScore / drillTotal) * 100) : 0;
        const label     = pct >= 90 ? 'Excellent!' : pct >= 70 ? 'Good work!' : pct >= 50 ? 'Keep practicing!' : 'Room to grow!';

        // Show drill selector again
        if (header) header.style.display = '';

        window.DB.bumpSession(`vocab-${currentDrill}`, pct);
        window.App?.refreshStats?.();

        container.innerHTML = `
            <div class="vd-complete">
                <div class="wl-score">
                    <div class="wl-score-ring" style="--score: ${pct}">
                        <span class="wl-score-value">${pct}</span>
                    </div>
                    <div>
                        <span class="wl-score-label">${label}</span>
                        <p class="vd-complete-detail">${drillScore} / ${drillTotal} correct</p>
                    </div>
                </div>
                <div class="vd-complete-actions">
                    <button class="wl-btn-primary" onclick="VocabDrill.startSynonymDrill()">New synonym drill</button>
                    <button class="wl-btn-secondary" onclick="VocabDrill.startCollocationDrill()">New collocation drill</button>
                </div>
            </div>`;
    }

    // =====================================================
    // UTILITIES
    // =====================================================

    function saveToNotebook(word, meaning, register) {
        window.DB.upsertNotebookWord({
            word     : word,
            meaning  : meaning,
            register : register,
            source   : 'Vocab Drill',
            tags     : ['vocab-drill']
        });
        window.App?.showToast?.(`"${word}" saved to notebook.`);
        window.App?.updateNotebookBadge?.();
    }

    function escHtml(str) {
        const d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML;
    }
    function escAttr(str) {
        return (str || '').replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/\n/g, ' ');
    }
    function escRegex(str) {
        return (str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    return {
        init,
        startSynonymDrill,
        startCollocationDrill,
        startAIDrill,
        saveToNotebook
    };
})();
