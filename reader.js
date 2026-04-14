// ============================================================
// reader.js — Reading Extraction Module
// ============================================================

window.Reader = (function() {

    let lastExtraction = null;
    let isProcessing   = false;

    function init() {
        bindEvents();
    }

    function bindEvents() {
        document.getElementById('rd-extract')?.addEventListener('click', handleExtract);
        document.getElementById('rd-clear')?.addEventListener('click', clearAll);
        document.getElementById('rd-input')?.addEventListener('input', updateWordCount);
        document.getElementById('rd-save-all')?.addEventListener('click', saveAllToNotebook);
        document.getElementById('rd-results')?.addEventListener('click', handleResultClick);

        // Keyboard shortcut
        document.getElementById('rd-input')?.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                handleExtract();
            }
        });
    }

    async function handleExtract() {
        if (isProcessing) return;

        const input = document.getElementById('rd-input');
        const text  = (input?.value || '').trim();

        if (!text) {
            window.App?.showToast?.('Paste an article or paragraph first.');
            return;
        }

        if (text.split(/\s+/).length < 20) {
            window.App?.showToast?.('Please paste a longer text (at least a few sentences).');
            return;
        }

        if (!window.AIEngine.hasAPIKey()) {
            window.App?.showToast?.('Set your API key in Settings first.');
            window.App?.openSettings?.();
            return;
        }

        setProcessing(true);
        showLoading();

        const level = document.getElementById('rd-level')?.value || 'advanced';
        const focus = document.getElementById('rd-focus')?.value || 'all';

        const prompt = buildExtractionPrompt(level, focus);

        try {
            const result = await window.AIEngine.callClaudeJSON(prompt, text);
            lastExtraction = result;
            renderExtraction(result);

            window.DB.bumpSession('reading');
            window.App?.refreshStats?.();
        } catch (err) {
            showError(window.AIEngine.friendlyError(err));
        } finally {
            setProcessing(false);
        }
    }

    function buildExtractionPrompt(level, focus) {
        let focusInstruction = '';
        if (focus === 'academic')  focusInstruction = 'Focus especially on academic and formal vocabulary.';
        if (focus === 'idioms')    focusInstruction = 'Focus especially on idioms, phrasal verbs, and fixed expressions.';
        if (focus === 'technical') focusInstruction = 'Focus especially on domain-specific and technical terms.';

        // Get existing notebook words to avoid duplicates
        const existing = window.DB.loadNotebook().map(w => w.word.toLowerCase());
        const skipNote = existing.length > 0
            ? `\n\nThe user already knows these words (skip them): ${existing.slice(0, 100).join(', ')}`
            : '';

        return `You are an advanced English vocabulary extraction expert helping a PhD-level native Chinese speaker.

Analyze the article the user provides and extract vocabulary that would help them sound more native.

${focusInstruction}

Target level: ${level} (focus on words/phrases a well-educated non-native speaker might not use naturally)

Return a JSON object:
{
  "summary": "2-3 sentence summary of the article's main point",
  "words": [
    {
      "word": "the word or phrase",
      "pos": "part of speech",
      "meaning_cn": "concise Chinese meaning",
      "meaning_en": "concise English definition in context",
      "register": "formal|neutral|casual|academic|technical",
      "context": "the exact sentence from the article where it appears",
      "usage_note": "brief note on when/how to use this naturally",
      "collocations": ["common collocation 1", "common collocation 2"]
    }
  ],
  "phrases": [
    {
      "phrase": "multi-word expression or idiom",
      "meaning_cn": "Chinese meaning",
      "meaning_en": "English explanation",
      "register": "formal|neutral|casual",
      "context": "sentence from article",
      "usage_note": "when to use this"
    }
  ],
  "grammar_patterns": [
    {
      "pattern": "a notable grammar structure found in the text",
      "example": "the sentence using it",
      "explanation": "how to use this pattern naturally"
    }
  ],
  "reading_level": "estimated CEFR level (B2/C1/C2)",
  "style_notes": "brief note on the writing style and register of this article"
}

Extract 8-15 individual words and 3-6 phrases. Prioritize words that:
1. Are common in educated native speech but often missed by Chinese speakers
2. Have nuanced register differences (e.g., "regarding" vs "about")
3. Are useful collocations, not just single vocabulary items
4. Would help the reader write and speak more naturally

${skipNote}

Return ONLY valid JSON, no markdown fences.`;
    }

    function renderExtraction(result) {
        const container = document.getElementById('rd-results');
        if (!container) return;

        const words   = result.words   || [];
        const phrases = result.phrases || [];
        const grammar = result.grammar_patterns || [];

        // Summary section
        const summaryHtml = result.summary
            ? `<div class="rd-summary">
                 <div class="rd-summary-header">
                   <span class="rd-level-badge">${escHtml(result.reading_level || 'C1')}</span>
                   <span class="rd-style-note">${escHtml(result.style_notes || '')}</span>
                 </div>
                 <p>${escHtml(result.summary)}</p>
               </div>`
            : '';

        // Words section
        const wordsHtml = words.length > 0
            ? `<div class="rd-section">
                 <div class="rd-section-header">
                   <h3 class="wl-section-title">Vocabulary (${words.length})</h3>
                   <button class="wl-btn-small" id="rd-save-all">Save all to notebook</button>
                 </div>
                 ${words.map((w, i) => renderWordCard(w, i, 'word')).join('')}
               </div>`
            : '';

        // Phrases section
        const phrasesHtml = phrases.length > 0
            ? `<div class="rd-section">
                 <h3 class="wl-section-title">Expressions &amp; phrases (${phrases.length})</h3>
                 ${phrases.map((p, i) => renderWordCard(p, i, 'phrase')).join('')}
               </div>`
            : '';

        // Grammar section
        const grammarHtml = grammar.length > 0
            ? `<div class="rd-section">
                 <h3 class="wl-section-title">Notable grammar patterns</h3>
                 ${grammar.map(g => `
                     <div class="rd-grammar-card">
                         <div class="rd-grammar-pattern">${escHtml(g.pattern)}</div>
                         <div class="rd-grammar-example">"${escHtml(g.example)}"</div>
                         <div class="rd-grammar-explain">${escHtml(g.explanation)}</div>
                     </div>
                 `).join('')}
               </div>`
            : '';

        container.innerHTML = `
            <div class="rd-extraction">
                ${summaryHtml}
                ${wordsHtml}
                ${phrasesHtml}
                ${grammarHtml}
            </div>`;
        container.classList.add('visible');

        // Re-bind save-all (since it was re-rendered)
        document.getElementById('rd-save-all')?.addEventListener('click', saveAllToNotebook);
    }

    function renderWordCard(item, index, type) {
        const word     = item.word || item.phrase || '';
        const meaningCn = item.meaning_cn || '';
        const meaningEn = item.meaning_en || '';
        const register = item.register || 'neutral';
        const context  = item.context || '';
        const usage    = item.usage_note || '';
        const collos   = (item.collocations || []).join(' · ');
        const pos      = item.pos || '';

        return `
            <div class="rd-word-card" style="animation-delay: ${index * 50}ms">
                <div class="rd-word-header">
                    <span class="rd-word-text">${escHtml(word)}</span>
                    <button class="speak-btn" data-text="${escAttr(word)}" title="Listen">&#x1F50A;</button>
                    ${pos ? `<span class="rd-pos">${escHtml(pos)}</span>` : ''}
                    <span class="wl-register-tag wl-register-${register}">${register}</span>
                    <button class="wl-btn-tiny rd-save-word" data-word="${escAttr(word)}" data-cn="${escAttr(meaningCn)}" data-en="${escAttr(meaningEn)}" data-register="${escAttr(register)}" data-context="${escAttr(context)}" data-collo="${escAttr(collos)}">+ Notebook</button>
                </div>
                <div class="rd-word-meanings">
                    ${meaningCn ? `<span class="rd-meaning-cn">${escHtml(meaningCn)}</span>` : ''}
                    ${meaningEn ? `<span class="rd-meaning-en">${escHtml(meaningEn)}</span>` : ''}
                </div>
                ${context ? `<div class="rd-word-context">"${escHtml(context)}"</div>` : ''}
                ${usage ? `<div class="rd-word-usage">${escHtml(usage)}</div>` : ''}
                ${collos ? `<div class="rd-word-collos">${escHtml(collos)}</div>` : ''}
            </div>`;
    }

    function handleResultClick(e) {
        const saveBtn = e.target.closest('.rd-save-word');
        if (!saveBtn) return;

        const word = saveBtn.dataset.word || '';
        window.DB.upsertNotebookWord({
            word     : word,
            meaning  : saveBtn.dataset.cn   || '',
            enDef    : saveBtn.dataset.en    || '',
            register : saveBtn.dataset.register || 'neutral',
            context  : saveBtn.dataset.context  || '',
            collo    : saveBtn.dataset.collo    || '',
            source   : 'Reader',
            tags     : ['reader']
        });

        saveBtn.textContent = 'Saved';
        saveBtn.disabled    = true;
        window.App?.showToast?.(`"${word}" saved to notebook.`);
        window.App?.updateNotebookBadge?.();
    }

    function saveAllToNotebook() {
        if (!lastExtraction) return;

        let count = 0;
        const items = [...(lastExtraction.words || []), ...(lastExtraction.phrases || [])];

        for (const item of items) {
            const word = item.word || item.phrase || '';
            if (!word) continue;

            window.DB.upsertNotebookWord({
                word     : word,
                meaning  : item.meaning_cn    || '',
                enDef    : item.meaning_en     || '',
                register : item.register       || 'neutral',
                context  : item.context        || '',
                collo    : (item.collocations || []).join(' · '),
                source   : 'Reader',
                tags     : ['reader']
            });
            count++;
        }

        window.App?.showToast?.(`Saved ${count} items to notebook.`);
        window.App?.updateNotebookBadge?.();

        // Update all save buttons
        document.querySelectorAll('.rd-save-word').forEach(btn => {
            btn.textContent = 'Saved';
            btn.disabled    = true;
        });
    }

    // --- UI Helpers ---

    function setProcessing(on) {
        isProcessing = on;
        const btn = document.getElementById('rd-extract');
        if (btn) {
            btn.disabled  = on;
            btn.innerHTML = on
                ? '<span class="wl-spinner"></span> Extracting...'
                : 'Extract vocabulary <kbd>Ctrl+Enter</kbd>';
        }
    }

    function showLoading() {
        const container = document.getElementById('rd-results');
        if (container) {
            container.innerHTML = `
                <div class="wl-loading">
                    <div class="wl-loading-dots"><span></span><span></span><span></span></div>
                    <p>Analyzing text and extracting vocabulary...</p>
                </div>`;
            container.classList.add('visible');
        }
    }

    function showError(msg) {
        const container = document.getElementById('rd-results');
        if (container) {
            container.innerHTML = `<div class="wl-error">${escHtml(msg)}</div>`;
            container.classList.add('visible');
        }
    }

    function clearAll() {
        const input     = document.getElementById('rd-input');
        const container = document.getElementById('rd-results');
        if (input) input.value = '';
        if (container) { container.innerHTML = ''; container.classList.remove('visible'); }
        lastExtraction = null;
        updateWordCount();
    }

    function updateWordCount() {
        const input   = document.getElementById('rd-input');
        const counter = document.getElementById('rd-word-count');
        if (input && counter) {
            const words = (input.value || '').trim().split(/\s+/).filter(Boolean).length;
            counter.textContent = `${words} words`;
        }
    }

    function escHtml(str) {
        const d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML;
    }
    function escAttr(str) {
        return (str || '').replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/\n/g, ' ');
    }

    return { init, saveAllToNotebook };
})();
