// ============================================================
// speaking-coach.js — Speaking Coach Module
// ============================================================

window.SpeakingCoach = (function() {

    let isProcessing   = false;
    let currentScenario = null;

    // Pre-built scenario bank
    const SCENARIOS = [
        {
            id    : 'meeting_disagree',
            title : 'Disagree politely in a meeting',
            icon  : '\uD83E\uDD1D',
            setup : 'Your colleague proposes cutting the testing phase to save time. You think this is risky.',
            your_attempt_hint: 'I think cutting tests is not a good idea because...'
        },
        {
            id    : 'email_followup',
            title : 'Follow up on an unanswered email',
            icon  : '\u2709\uFE0F',
            setup : 'You emailed a collaborator 5 days ago about a deadline. No reply yet.',
            your_attempt_hint: 'I want to check if you received my previous email about...'
        },
        {
            id    : 'present_results',
            title : 'Present research results',
            icon  : '\uD83D\uDCCA',
            setup : 'You need to summarize your findings in a group meeting. The results are mixed.',
            your_attempt_hint: 'Our experiment showed some interesting results...'
        },
        {
            id    : 'small_talk',
            title : 'Small talk at a conference',
            icon  : '\u2615',
            setup : 'You just met another researcher at a coffee break. You want to learn about their work.',
            your_attempt_hint: 'What is your research about?'
        },
        {
            id    : 'ask_favor',
            title : 'Ask a colleague for help',
            icon  : '\uD83D\uDE4F',
            setup : 'You need a colleague to review your manuscript before the submission deadline next week.',
            your_attempt_hint: 'Can you help me review my paper?'
        },
        {
            id    : 'give_feedback',
            title : 'Give constructive feedback',
            icon  : '\uD83D\uDCDD',
            setup : 'A junior colleague\'s draft has good ideas but poor organization and some errors.',
            your_attempt_hint: 'Your paper has some problems that need to be fixed...'
        },
        {
            id    : 'decline_invite',
            title : 'Decline an invitation gracefully',
            icon  : '\uD83D\uDE45',
            setup : 'A colleague invites you to co-author a paper, but you\'re overcommitted this semester.',
            your_attempt_hint: 'I am very busy now so I cannot join your paper...'
        },
        {
            id    : 'explain_delay',
            title : 'Explain a project delay',
            icon  : '\u23F0',
            setup : 'Your supervisor asks about a deliverable that\'s two weeks late.',
            your_attempt_hint: 'Sorry for the delay, I encountered some problems...'
        }
    ];

    // Native phrasing bank — quick reference patterns with Chinese
    const PHRASING_BANK = [
        {
            category : 'Hedging (softening claims)',
            icon     : '\uD83E\uDD14',
            pairs    : [
                { chinglish: 'I think this is wrong.',              native: 'I\'m not entirely sure this holds up.',     cn: '\u6211\u4E0D\u592A\u786E\u5B9A\u8FD9\u4E2A\u7ECF\u5F97\u8D77\u63A8\u6572\u3002', note: 'Hedging sounds more collegial in academic/professional contexts.' },
                { chinglish: 'This method is the best.',            native: 'This approach seems particularly promising.', cn: '\u8FD9\u4E2A\u65B9\u6CD5\u770B\u8D77\u6765\u7279\u522B\u6709\u524D\u666F\u3002', note: 'Avoid absolute claims; native speakers hedge by default.' },
                { chinglish: 'We must do this.',                    native: 'It might be worth considering...',           cn: '\u8FD9\u4E2A\u4E5F\u8BB8\u503C\u5F97\u8003\u8651\u4E00\u4E0B\u2026\u2026', note: '"Must" sounds dictatorial; soften with modal + gerund.' },
                { chinglish: 'The result proves our theory.',       native: 'The results lend support to our hypothesis.', cn: '\u7ED3\u679C\u4E3A\u6211\u4EEC\u7684\u5047\u8BBE\u63D0\u4F9B\u4E86\u652F\u6301\u3002', note: '"Prove" is too strong for most research claims.' },
                { chinglish: 'Obviously, this is correct.',         native: 'It appears that this is the case.',          cn: '\u770B\u8D77\u6765\u60C5\u51B5\u786E\u5B9E\u5982\u6B64\u3002', note: '"Obviously" can sound dismissive; "it appears" invites agreement.' }
            ]
        },
        {
            category : 'Professional email openers',
            icon     : '\u2709\uFE0F',
            pairs    : [
                { chinglish: 'Dear Professor, I want to ask you...', native: 'Hi Professor X, I was wondering if...',      cn: 'X\u6559\u6388\u60A8\u597D\uFF0C\u6211\u60F3\u95EE\u4E00\u4E0B\u662F\u5426\u2026\u2026', note: '"I was wondering if" is the standard polite request form.' },
                { chinglish: 'I am writing to inform you that...',   native: 'Just a quick heads up \u2014 ...',            cn: '\u7B80\u5355\u63D0\u4E2A\u9192\u2014\u2014', note: 'For internal/semi-formal emails, be direct and warm.' },
                { chinglish: 'Sorry to bother you.',                native: 'Hope you don\'t mind me reaching out.',       cn: '\u5E0C\u671B\u60A8\u4E0D\u4ECB\u610F\u6211\u8054\u7CFB\u60A8\u3002', note: 'Avoid excessive apology; it signals low confidence.' },
                { chinglish: 'Please reply as soon as possible.',   native: 'Would be great to hear back when you get a chance.', cn: '\u65B9\u4FBF\u7684\u65F6\u5019\u56DE\u590D\u6211\u5C31\u597D\u3002', note: 'Soften urgency unless truly urgent.' },
                { chinglish: 'Please find the attachment.',         native: 'I\'ve attached ... for your reference.',      cn: '\u968F\u4FE1\u9644\u4E0A\u2026\u2026\u4F9B\u60A8\u53C2\u8003\u3002', note: '"Please find" is outdated; just say what you attached.' }
            ]
        },
        {
            category : 'Transition phrases',
            icon     : '\uD83D\uDD17',
            pairs    : [
                { chinglish: 'On the other hand...',               native: 'That said, ...',                              cn: '\u8BDD\u867D\u5982\u6B64\uFF0C\u2026\u2026', note: '"That said" is more natural in speech than "on the other hand."' },
                { chinglish: 'As we all know...',                  native: 'As you might expect, ...',                    cn: '\u6B63\u5982\u60A8\u53EF\u80FD\u9884\u6599\u7684\uFF0C\u2026\u2026', note: '"As we all know" sounds preachy; assume less about the audience.' },
                { chinglish: 'In my opinion...',                   native: 'The way I see it, ...',                       cn: '\u5728\u6211\u770B\u6765\uFF0C\u2026\u2026', note: 'More conversational and less formal-stiff.' },
                { chinglish: 'What\'s more...',                    native: 'On top of that, ...',                         cn: '\u9664\u6B64\u4E4B\u5916\uFF0C\u2026\u2026', note: '"What\'s more" sounds textbook-ish in conversation.' },
                { chinglish: 'First... Second... Third...',        native: 'To start with... Another thing is... And finally...', cn: '\u9996\u5148\u2026\u2026\u53E6\u5916\u2026\u2026\u6700\u540E\u2026\u2026', note: 'Numbered lists sound robotic in speech; vary your connectors.' }
            ]
        },
        {
            category : 'Agreeing and disagreeing',
            icon     : '\uD83E\uDD1D',
            pairs    : [
                { chinglish: 'I agree with you.',                  native: 'That\'s a fair point.',                       cn: '\u8FD9\u8BF4\u5F97\u6709\u9053\u7406\u3002', note: 'Acknowledges the argument, not just the person.' },
                { chinglish: 'I don\'t agree.',                    native: 'I see it a bit differently.',                 cn: '\u6211\u7684\u770B\u6CD5\u7565\u6709\u4E0D\u540C\u3002', note: 'Face-saving disagreement that invites discussion.' },
                { chinglish: 'You are right.',                     native: 'That\'s spot on.',                            cn: '\u5B8C\u5168\u6B63\u786E\u3002', note: '"Spot on" is warm and emphatic; good for meetings.' },
                { chinglish: 'I don\'t think so.',                 native: 'I\'m not so sure about that.',                cn: '\u6211\u5BF9\u6B64\u4E0D\u592A\u786E\u5B9A\u3002', note: 'Softer pushback that doesn\'t shut down dialogue.' },
                { chinglish: 'I totally agree.',                   native: 'Absolutely \u2014 couldn\'t agree more.',     cn: '\u5B8C\u5168\u540C\u610F\u2014\u2014\u518D\u8D5E\u540C\u4E0D\u8FC7\u4E86\u3002', note: 'Stronger than plain "I agree" without sounding excessive.' }
            ]
        },
        {
            category : 'Expressing uncertainty',
            icon     : '\uD83E\uDD37',
            pairs    : [
                { chinglish: 'I am not sure.',                     native: 'I\'d have to double-check on that.',          cn: '\u6211\u5F97\u518D\u786E\u8BA4\u4E00\u4E0B\u3002', note: 'Shows responsibility rather than just uncertainty.' },
                { chinglish: 'Maybe it is correct.',               native: 'It looks about right, but let me verify.',    cn: '\u770B\u8D77\u6765\u5DEE\u4E0D\u591A\uFF0C\u4F46\u6211\u518D\u786E\u8BA4\u4E00\u4E0B\u3002', note: 'Combines hedging with a concrete next step.' },
                { chinglish: 'I don\'t know about this.',          native: 'I\'m honestly not up to speed on that.',      cn: '\u8BF4\u5B9E\u8BDD\uFF0C\u6211\u5BF9\u8FD9\u4E2A\u4E0D\u592A\u719F\u3002', note: '"Not up to speed" sounds professional, not ignorant.' },
                { chinglish: 'I have no idea.',                    native: 'Your guess is as good as mine.',              cn: '\u6211\u4E5F\u4E0D\u786E\u5B9A\uFF0C\u54B1\u4FE9\u534A\u65A4\u516B\u4E24\u3002', note: 'Conversational and disarming, good among peers.' }
            ]
        },
        {
            category : 'Asking for clarification',
            icon     : '\u2753',
            pairs    : [
                { chinglish: 'I don\'t understand.',               native: 'Could you walk me through that?',             cn: '\u60A8\u80FD\u7ED9\u6211\u8BE6\u7EC6\u8BF4\u8BF4\u5417\uFF1F', note: '"Walk me through" implies you want step-by-step explanation.' },
                { chinglish: 'What do you mean?',                  native: 'Just to make sure I\'m following \u2014 ...',  cn: '\u6211\u786E\u8BA4\u4E00\u4E0B\u6211\u7684\u7406\u89E3\u2014\u2014', note: 'Frames it as your comprehension, not their clarity.' },
                { chinglish: 'Can you say it again?',              native: 'Sorry, could you run that by me one more time?', cn: '\u62B1\u6B49\uFF0C\u60A8\u80FD\u518D\u8BF4\u4E00\u904D\u5417\uFF1F', note: '"Run that by me" is natural for meetings and calls.' },
                { chinglish: 'I want to confirm...',               native: 'Just to clarify \u2014 are we saying that...?', cn: '\u6211\u786E\u8BA4\u4E00\u4E0B\u2014\u2014\u6211\u4EEC\u662F\u8BF4\u2026\u2026\uFF1F', note: 'Invites correction without sounding confrontational.' }
            ]
        },
        {
            category : 'Making suggestions',
            icon     : '\uD83D\uDCA1',
            pairs    : [
                { chinglish: 'I suggest we should...',             native: 'How about we try...?',                         cn: '\u6211\u4EEC\u8BD5\u8BD5\u2026\u2026\u600E\u4E48\u6837\uFF1F', note: 'Questions feel collaborative; statements feel directive.' },
                { chinglish: 'I think we need to change this.',    native: 'What if we approached it from a different angle?', cn: '\u5982\u679C\u6211\u4EEC\u6362\u4E2A\u89D2\u5EA6\u5462\uFF1F', note: '"What if" softens the suggestion into an exploration.' },
                { chinglish: 'You should do it this way.',         native: 'One thing that might work is...',              cn: '\u6709\u4E00\u4E2A\u53EF\u80FD\u53EF\u884C\u7684\u529E\u6CD5\u662F\u2026\u2026', note: 'Avoids direct instruction; offers an option instead.' },
                { chinglish: 'We can try my method.',              native: 'It might be worth giving ... a shot.',         cn: '\u4E5F\u8BB8\u503C\u5F97\u8BD5\u8BD5\u2026\u2026', note: '"Give it a shot" is casual and low-pressure.' }
            ]
        },
        {
            category : 'Giving updates & status',
            icon     : '\uD83D\uDCCB',
            pairs    : [
                { chinglish: 'The progress is 80%.',               native: 'We\'re about 80% of the way there.',           cn: '\u6211\u4EEC\u5DF2\u7ECF\u5B8C\u6210\u4E86\u5927\u7EA680%\u3002', note: '"Of the way there" sounds more natural than bare percentages.' },
                { chinglish: 'I am still working on it.',          native: 'It\'s still a work in progress.',              cn: '\u8FD8\u5728\u8FDB\u884C\u4E2D\u3002', note: '"Work in progress" is standard professional vocabulary.' },
                { chinglish: 'We met a problem.',                  native: 'We\'ve hit a bit of a snag with...',           cn: '\u6211\u4EEC\u5728\u2026\u2026\u4E0A\u9047\u5230\u4E86\u4E00\u4E9B\u56F0\u96BE\u3002', note: '"Snag" downplays severity; good for early problem reports.' },
                { chinglish: 'It will be finished next week.',     native: 'We\'re on track to wrap up by next week.',     cn: '\u6211\u4EEC\u9884\u8BA1\u4E0B\u5468\u53EF\u4EE5\u5B8C\u6210\u3002', note: '"On track" signals confidence; "wrap up" is natural for deadlines.' }
            ]
        },
        {
            category : 'Expressing gratitude',
            icon     : '\uD83D\uDE4F',
            pairs    : [
                { chinglish: 'Thank you very much for your help.',  native: 'Really appreciate you taking the time for this.', cn: '\u975E\u5E38\u611F\u8C22\u60A8\u62BD\u51FA\u65F6\u95F4\u3002', note: 'Specific about what you appreciate feels more genuine.' },
                { chinglish: 'Thanks for your hard work.',          native: 'Thanks for going above and beyond on this.',  cn: '\u611F\u8C22\u60A8\u5728\u8FD9\u4E0A\u9762\u7684\u989D\u5916\u4ED8\u51FA\u3002', note: '"Above and beyond" acknowledges exceptional effort specifically.' },
                { chinglish: 'I am grateful.',                      native: 'I can\'t tell you how much this means to me.', cn: '\u6211\u65E0\u6CD5\u8868\u8FBE\u8FD9\u5BF9\u6211\u610F\u4E49\u6709\u591A\u5927\u3002', note: 'Emotional and personal; good for significant favors.' },
                { chinglish: 'Thank you for your cooperation.',     native: 'Thanks for being so flexible about this.',    cn: '\u611F\u8C22\u60A8\u5728\u8FD9\u4EF6\u4E8B\u4E0A\u7684\u7075\u6D3B\u914D\u5408\u3002', note: '"Cooperation" sounds transactional; name what they did.' }
            ]
        },
        {
            category : 'Ending conversations',
            icon     : '\uD83D\uDC4B',
            pairs    : [
                { chinglish: 'I have nothing more to say.',        native: 'I think we\'ve covered everything.',           cn: '\u6211\u89C9\u5F97\u6211\u4EEC\u90FD\u8BA8\u8BBA\u5230\u4E86\u3002', note: 'Frames ending positively as completion, not absence.' },
                { chinglish: 'Let\'s stop here.',                  native: 'Shall we leave it here for today?',           cn: '\u6211\u4EEC\u4ECA\u5929\u5C31\u5230\u8FD9\u91CC\u5427\uFF1F', note: 'Question form is softer and invites agreement.' },
                { chinglish: 'See you next time.',                 native: 'Looking forward to catching up again soon.',   cn: '\u671F\u5F85\u5F88\u5FEB\u518D\u804A\u3002', note: '"Catching up" is warm and personal.' },
                { chinglish: 'If you have questions, ask me.',     native: 'Don\'t hesitate to reach out if anything comes up.', cn: '\u6709\u4EFB\u4F55\u95EE\u9898\u968F\u65F6\u8054\u7CFB\u6211\u3002', note: '"Don\'t hesitate" is the standard professional closing.' }
            ]
        }
    ];

    let currentPhrasingPage    = 0;  // category index
    let currentPhrasingPairIdx = 0;  // pair index within current category

    function init() {
        bindEvents();
        renderScenarios();
        renderPhrasingReference();
    }

    function bindEvents() {
        // Scenario cards
        document.getElementById('sc-scenarios')?.addEventListener('click', (e) => {
            const card = e.target.closest('.sc-scenario-card');
            if (card) startScenario(card.dataset.id);
        });

        // Submit response
        document.getElementById('sc-submit')?.addEventListener('click', handleScenarioSubmit);
        document.getElementById('sc-response-input')?.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                handleScenarioSubmit();
            }
        });

        // Free-form native check
        document.getElementById('sc-freeform-submit')?.addEventListener('click', handleFreeformCheck);
        document.getElementById('sc-freeform-input')?.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                handleFreeformCheck();
            }
        });

        // Tab switching within speaking coach
        document.querySelectorAll('.sc-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const target = tab.dataset.panel;
                document.querySelectorAll('.sc-tab').forEach(t => t.classList.toggle('active', t.dataset.panel === target));
                document.querySelectorAll('.sc-panel').forEach(p => p.classList.toggle('active', p.id === target));
            });
        });

    }

    // =====================================================
    // SCENARIO PRACTICE
    // =====================================================

    // Populate the grid of scenario cards when the Scenarios panel
    // first renders. Each card has data-id, matched by the click
    // handler bound in bindEvents() which calls startScenario().
    function renderScenarios() {
        const grid = document.querySelector('#sc-scenarios .sc-scenario-grid');
        if (!grid) return;
        grid.innerHTML = SCENARIOS.map(s => `
            <button class="sc-scenario-card" data-id="${s.id}" type="button">
                <span class="sc-scenario-icon">${s.icon}</span>
                <span class="sc-scenario-name">${escHtml(s.title)}</span>
            </button>
        `).join('');
    }

    function startScenario(scenarioId) {
        const scenario = SCENARIOS.find(s => s.id === scenarioId);
        if (!scenario) return;
        currentScenario = scenario;

        const area = document.getElementById('sc-scenario-practice');
        if (!area) return;

        area.innerHTML = `
            <div class="sc-active-scenario">
                <div class="sc-scenario-setup">
                    <span class="sc-scenario-icon">${scenario.icon}</span>
                    <div>
                        <h3 class="sc-scenario-title">${escHtml(scenario.title)}</h3>
                        <p class="sc-scenario-desc">${escHtml(scenario.setup)}</p>
                    </div>
                </div>
                <div class="wl-input-area">
                    <textarea id="sc-response-input" rows="3"
                        placeholder="${escHtml(scenario.your_attempt_hint)}"
                        spellcheck="true"></textarea>
                    <div class="wl-input-footer">
                        <span class="wl-char-count" style="font-style:italic;color:var(--text-tertiary)">Write what you would say, then get native-speaker alternatives</span>
                        <button class="wl-btn-primary" id="sc-submit">Get feedback <kbd>Ctrl+Enter</kbd></button>
                    </div>
                </div>
                <div class="sc-feedback" id="sc-feedback"></div>
            </div>`;

        area.classList.add('visible');

        // Rebind submit
        document.getElementById('sc-submit')?.addEventListener('click', handleScenarioSubmit);
        document.getElementById('sc-response-input')?.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                handleScenarioSubmit();
            }
        });

        document.getElementById('sc-response-input')?.focus();
    }

    async function handleScenarioSubmit() {
        if (isProcessing || !currentScenario) return;

        const input = document.getElementById('sc-response-input');
        const text  = (input?.value || '').trim();

        if (!text) {
            window.App?.showToast?.('Write your response first.');
            return;
        }

        if (!window.AIEngine.hasAPIKey()) {
            window.App?.showToast?.('Set your API key in Settings first.');
            return;
        }

        isProcessing = true;
        const btn = document.getElementById('sc-submit');
        if (btn) { btn.disabled = true; btn.innerHTML = '<span class="wl-spinner"></span> Analyzing...'; }

        const feedback = document.getElementById('sc-feedback');
        if (feedback) {
            feedback.innerHTML = `<div class="wl-loading"><div class="wl-loading-dots"><span></span><span></span><span></span></div><p>Comparing with native phrasing...</p></div>`;
        }

        const prompt = `You are a native English speaking coach helping a PhD-level Chinese speaker sound more natural.

Scenario: ${currentScenario.title}
Context: ${currentScenario.setup}

The user wrote what they would say in this situation. Evaluate it and provide native alternatives.

Return a JSON object:
{
  "naturalness_score": 75,
  "assessment": "1-2 sentence assessment of how natural the response sounds",
  "native_versions": [
    {
      "label": "Polished version",
      "text": "a more natural version keeping the same intent",
      "tone": "professional/warm/casual",
      "changes_explained": "what was changed and why"
    },
    {
      "label": "What a native speaker might actually say",
      "text": "a fully natural version that a native speaker would use",
      "tone": "the tone of this version",
      "changes_explained": "key differences from the user's version"
    }
  ],
  "useful_phrases": [
    {
      "phrase": "a useful phrase from the native versions",
      "when_to_use": "when this phrase is appropriate",
      "register": "formal/neutral/casual"
    }
  ],
  "chinglish_flags": [
    {
      "user_said": "what the user wrote",
      "native_would_say": "what a native speaker would say",
      "chinese_logic": "the Chinese thinking pattern behind it"
    }
  ],
  "encouragement": "one encouraging note about what the user got right"
}

Return ONLY valid JSON, no markdown fences.`;

        try {
            const result = await window.AIEngine.callClaudeJSON(prompt, text);
            renderScenarioFeedback(result);
            window.DB.bumpSession('speaking', result.naturalness_score);
            window.App?.refreshStats?.();
        } catch (err) {
            if (feedback) feedback.innerHTML = `<div class="wl-error">${window.AIEngine.friendlyError(err)}</div>`;
        } finally {
            isProcessing = false;
            if (btn) { btn.disabled = false; btn.innerHTML = 'Get feedback <kbd>Ctrl+Enter</kbd>'; }
        }
    }

    function renderScenarioFeedback(result) {
        const container = document.getElementById('sc-feedback');
        if (!container) return;

        const versions = result.native_versions || [];
        const phrases  = result.useful_phrases || [];
        const flags    = result.chinglish_flags || [];

        container.innerHTML = `
            <div class="sc-feedback-card">
                ${typeof result.naturalness_score === 'number' ? `
                    <div class="wl-score">
                        <div class="wl-score-ring" style="--score: ${result.naturalness_score}">
                            <span class="wl-score-value">${result.naturalness_score}</span>
                        </div>
                        <span class="wl-score-label">${result.assessment || ''}</span>
                    </div>` : ''}

                ${result.encouragement ? `<div class="sc-encouragement">${escHtml(result.encouragement)}</div>` : ''}

                <div class="sc-native-versions">
                    ${versions.map((v, i) => `
                        <div class="sc-native-card" style="animation-delay:${i * 80}ms">
                            <div class="sc-native-header">
                                <span class="sc-native-label">${escHtml(v.label)}</span>
                                <span class="wl-register-tag wl-register-${registerClass(v.tone)}">${escHtml(v.tone)}</span>
                                <button class="speak-btn" data-text="${escAttr(v.text)}" title="Listen">&#x1F50A;</button>
                            </div>
                            <div class="sc-native-text">${escHtml(v.text)}</div>
                            <div class="sc-native-explain">${escHtml(v.changes_explained)}</div>
                        </div>
                    `).join('')}
                </div>

                ${flags.length > 0 ? `
                    <div class="st-chinglish-section">
                        <h3 class="wl-section-title">Phrasing adjustments</h3>
                        ${flags.map(f => `
                            <div class="st-chinglish-card">
                                <div class="st-chinglish-pattern">
                                    <span class="wl-del">${escHtml(f.user_said)}</span>
                                    <span class="wl-arrow-icon">\u2192</span>
                                    <span class="wl-ins">${escHtml(f.native_would_say)}</span>
                                </div>
                                <div class="st-chinglish-explain">${escHtml(f.chinese_logic)}</div>
                            </div>
                        `).join('')}
                    </div>` : ''}

                ${phrases.length > 0 ? `
                    <div class="sc-phrases-section">
                        <h3 class="wl-section-title">Useful phrases to remember</h3>
                        ${phrases.map(p => `
                            <div class="sc-phrase-item">
                                <span class="sc-phrase-text">"${escHtml(p.phrase)}"</span>
                                <span class="wl-register-tag wl-register-${registerClass(p.register)}">${escHtml(p.register)}</span>
                                <span class="sc-phrase-when">${escHtml(p.when_to_use)}</span>
                                <button class="wl-btn-tiny sc-save-phrase" data-word="${escAttr(p.phrase)}" data-note="${escAttr(p.when_to_use)}" data-reg="${escAttr(p.register)}">+ Notebook</button>
                            </div>
                        `).join('')}
                    </div>` : ''}
            </div>`;

        // Bind save/speak buttons
        container.querySelectorAll('.sc-save-phrase').forEach(btn => {
            btn.addEventListener('click', () => {
                window.DB.upsertNotebookWord({
                    word     : btn.dataset.word,
                    collo    : btn.dataset.note || '',
                    register : btn.dataset.reg  || 'neutral',
                    source   : 'Speaking Coach',
                    tags     : ['speaking']
                });
                btn.textContent = 'Saved';
                btn.disabled    = true;
                window.App?.updateNotebookBadge?.();
            });
        });
    }

    // =====================================================
    // FREE-FORM NATIVE CHECK
    // =====================================================

    async function handleFreeformCheck() {
        if (isProcessing) return;

        const input = document.getElementById('sc-freeform-input');
        const text  = (input?.value || '').trim();

        if (!text) { window.App?.showToast?.('Type something first.'); return; }
        if (!window.AIEngine.hasAPIKey()) { window.App?.showToast?.('Set your API key in Settings first.'); return; }

        isProcessing = true;
        const btn = document.getElementById('sc-freeform-submit');
        if (btn) { btn.disabled = true; btn.innerHTML = '<span class="wl-spinner"></span> Checking...'; }

        const resultEl = document.getElementById('sc-freeform-result');

        const prompt = `You are a native English phrasing coach. The user (a Chinese PhD speaker) wants to express the following idea naturally. Compare their phrasing with how a native speaker would say it.

Return a JSON object:
{
  "score": 80,
  "native_version": "what a native speaker would actually say",
  "explanation": "what makes the native version more natural (1-2 sentences)",
  "alternative": "another natural way to say it",
  "key_phrase": { "phrase": "a key phrase to remember", "note": "when to use it" }
}
Return ONLY valid JSON, no markdown fences.`;

        try {
            const result = await window.AIEngine.callClaudeJSON(prompt, text);
            if (resultEl) {
                resultEl.innerHTML = `
                    <div class="sc-freeform-feedback">
                        <div class="sc-ff-score">Naturalness: <strong>${result.score || '--'}</strong>/100</div>
                        <div class="sc-ff-native">
                            <span class="sc-ff-label">Native version:</span>
                            <span class="sc-ff-text">${escHtml(result.native_version)}</span>
                            <button class="speak-btn" data-text="${escAttr(result.native_version)}" title="Listen">&#x1F50A;</button>
                        </div>
                        <div class="sc-ff-explain">${escHtml(result.explanation)}</div>
                        ${result.alternative ? `<div class="sc-ff-alt"><span class="sc-ff-label">Alternative:</span> ${escHtml(result.alternative)}</div>` : ''}
                        ${result.key_phrase ? `<div class="sc-ff-phrase">"${escHtml(result.key_phrase.phrase)}" \u2014 ${escHtml(result.key_phrase.note)}</div>` : ''}
                    </div>`;
            }
        } catch (err) {
            if (resultEl) resultEl.innerHTML = `<div class="wl-error">${window.AIEngine.friendlyError(err)}</div>`;
        } finally {
            isProcessing = false;
            if (btn) { btn.disabled = false; btn.innerHTML = 'How would a native say this?'; }
        }
    }

    // =====================================================
    // PHRASING REFERENCE
    // =====================================================

    function renderPhrasingReference() {
        const container = document.getElementById('sc-phrasing-ref');
        if (!container) return;

        const cat = PHRASING_BANK[currentPhrasingPage];
        if (!cat) return;

        // Clamp pair index so changing categories or live-edits never
        // leave us pointing past the end of the new pair list.
        const pairs    = cat.pairs || [];
        const totalPairs = pairs.length;
        if (currentPhrasingPairIdx >= totalPairs) currentPhrasingPairIdx = 0;
        if (currentPhrasingPairIdx < 0)           currentPhrasingPairIdx = 0;

        // Shortened labels for tabs
        const shortLabels = [
            'Hedging', 'Emails', 'Transitions', 'Agree/Disagree', 'Uncertainty',
            'Clarification', 'Suggestions', 'Updates', 'Gratitude', 'Endings'
        ];

        // Category tab bar
        const tabsHtml = PHRASING_BANK.map((c, i) => `
            <button class="sc-cat-tab ${i === currentPhrasingPage ? 'sc-cat-active' : ''}" data-cat-idx="${i}">
                <span class="sc-cat-icon">${c.icon || ''}</span>
                <span class="sc-cat-name">${shortLabels[i] || escHtml(c.category)}</span>
            </button>
        `).join('');

        // Single-pair fixed card with prev/next navigation. Replaces the
        // old "dump every pair into the page" layout so the user no longer
        // has to scroll the page to see all examples in a category.
        let cardHtml;
        if (totalPairs === 0) {
            cardHtml = `<div class="sc-phr-card"><div class="sc-phr-empty">(no phrases in this category)</div></div>`;
        } else {
            const p          = pairs[currentPhrasingPairIdx];
            const prevDis    = currentPhrasingPairIdx <= 0              ? 'disabled' : '';
            const nextDis    = currentPhrasingPairIdx >= totalPairs - 1 ? 'disabled' : '';
            cardHtml = `
                <div class="sc-phr-card">
                    <div class="sc-phr-card-head">
                        <button class="sd-detail-nav sc-phr-prev" type="button" ${prevDis} title="Previous">&#x25C0;</button>
                        <span class="sc-phrasing-page">${currentPhrasingPairIdx + 1}/${totalPairs}</span>
                        <button class="sd-detail-nav sc-phr-next" type="button" ${nextDis} title="Next">&#x25B6;</button>
                    </div>
                    <div class="sc-phr-card-body">
                        <div class="sc-phrasing-chinglish">
                            <span class="sc-phrasing-label">Typical</span>
                            <span>${escHtml(p.chinglish)}</span>
                        </div>
                        <div class="sc-phrasing-native">
                            <span class="sc-phrasing-label">Native</span>
                            <span>${escHtml(p.native)}</span>
                            <button class="speak-btn" data-text="${escAttr(p.native)}" title="Listen">&#x1F50A;</button>
                        </div>
                        ${p.cn   ? `<div class="sc-phrasing-cn">${escHtml(p.cn)}</div>` : ''}
                        ${p.note ? `<div class="sc-phrasing-note">${escHtml(p.note)}</div>` : ''}
                    </div>
                </div>`;
        }

        container.innerHTML = `
            <div class="sc-cat-tabs">${tabsHtml}</div>
            <h3 class="sc-phrasing-cat-title">${cat.icon} ${escHtml(cat.category)}</h3>
            ${cardHtml}`;

        // Bind category tab clicks — switching category resets pair to 0
        container.querySelectorAll('.sc-cat-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                currentPhrasingPage    = parseInt(btn.dataset.catIdx, 10);
                currentPhrasingPairIdx = 0;
                renderPhrasingReference();
            });
        });

        // Bind prev/next within current category
        container.querySelector('.sc-phr-prev')?.addEventListener('click', () => {
            if (currentPhrasingPairIdx > 0) {
                currentPhrasingPairIdx--;
                renderPhrasingReference();
            }
        });
        container.querySelector('.sc-phr-next')?.addEventListener('click', () => {
            if (currentPhrasingPairIdx < totalPairs - 1) {
                currentPhrasingPairIdx++;
                renderPhrasingReference();
            }
        });
    }

    function registerClass(reg) {
        const r = (reg || '').toLowerCase();
        if (r.includes('formal') || r.includes('professional')) return 'formal';
        if (r.includes('casual') || r.includes('warm'))         return 'casual';
        return 'neutral';
    }

    function escHtml(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
    function escAttr(s) { return (s || '').replace(/[`\\'"]/g, '\\$&').replace(/\n/g, ' '); }

    return { init };
})();
