// ============================================================
// app.js — English Master Pro Main Hub
// ============================================================

window.App = (function() {

    let currentView = 'my-words';

    function init() {
        // Profile name
        const profile = window.DB.getProfile();
        document.title = `EM Pro — ${profile.name}`;

        // Initialize modules
        window.MyWords?.init?.();
        window.WritingLab?.init?.();
        window.VocabDrill?.init?.();
        window.Reader?.init?.();
        window.SpeakingCoach?.init?.();

        // Expression Coach — inside Expressions > Drill panel
        const drillPanel = document.getElementById('sc-panel-drill');
        if (drillPanel && typeof ExpressionCoach !== 'undefined') {
            ExpressionCoach.init(drillPanel);
        }

        // Sentence Drill — inside Expressions > Sentences panel
        const sentPanel = document.getElementById('sc-panel-sentences');
        if (sentPanel && typeof SentenceDrill !== 'undefined') {
            SentenceDrill.init(sentPanel);
        }

        // Render scenario cards for Speaking Coach
        renderScenarioCards();

        // Bind navigation
        document.querySelectorAll('[data-nav]').forEach(el => {
            el.addEventListener('click', () => navigateTo(el.dataset.nav));
        });

        // Settings
        document.getElementById('btn-settings')?.addEventListener('click', openSettings);
        document.getElementById('settings-close')?.addEventListener('click', closeSettings);
        document.getElementById('btn-save-api-key')?.addEventListener('click', saveAPIKey);
        document.getElementById('btn-test-api')?.addEventListener('click', testAPIKey);
        document.getElementById('btn-save-sync-token')?.addEventListener('click', saveSyncToken);
        document.getElementById('btn-sync-push')?.addEventListener('click', manualPush);
        document.getElementById('btn-sync-pull')?.addEventListener('click', manualPull);
        document.getElementById('btn-export')?.addEventListener('click', exportData);
        document.getElementById('btn-import')?.addEventListener('click', importData);
        document.getElementById('btn-factory-reset')?.addEventListener('click', factoryReset);
        document.getElementById('btn-clear-words')?.addEventListener('click', clearAllWords);

        // Notebook
        document.getElementById('btn-notebook')?.addEventListener('click', openNotebook);
        document.getElementById('notebook-close')?.addEventListener('click', closeNotebook);
        document.getElementById('notebook-search')?.addEventListener('input', renderNotebook);

        // Load API key into settings field
        const keyInput = document.getElementById('api-key-input');
        if (keyInput) {
            const k       = window.DB.getAPIKey();
            keyInput.value = k ? k.slice(0, 8) + '...' + k.slice(-4) : '';
        }

        refreshStats();
        updateNotebookBadge();
        initSettings();
        checkFirstRun();
    }

    // --- Navigation ---
    function navigateTo(view) {
        currentView = view;
        // Stop any in-progress autoplay / speech when switching views
        window.MyWords?.stopAutoplay?.();
        stopSpeak();
        document.querySelectorAll('.app-view').forEach(v => {
            v.classList.toggle('active', v.id === `view-${view}`);
        });
        document.querySelectorAll('[data-nav]').forEach(el => {
            el.classList.toggle('active', el.dataset.nav === view);
        });
    }

    // --- Settings Modal ---
    function openSettings() {
        document.getElementById('settings-modal').classList.add('open');
        refreshAIProviderUI();
        const keyInput = document.getElementById('api-key-input');
        const k        = window.DB.getAPIKey();
        if (keyInput) keyInput.value = k || '';
        // Load sync token (read via SyncManager — raw localStorage, not profile-prefixed)
        const syncInput = document.getElementById('sync-github-token');
        const st        = window.SyncManager?.getToken?.() || '';
        if (syncInput) syncInput.value = st;
        // Install button visibility: show if prompt is available, or if we're
        // running in a browser (not already installed as standalone PWA)
        const installBtn  = document.getElementById('btn-install-app');
        const installHint = document.getElementById('install-hint');
        const isStandalone = window.matchMedia('(display-mode: standalone)').matches
                          || window.navigator.standalone === true;
        if (installBtn) {
            if (isStandalone) {
                installBtn.style.display = 'none';
                if (installHint) installHint.textContent = '\u2713 Already installed on this device.';
            } else if (window.deferredInstallPrompt) {
                installBtn.style.display = '';
            } else {
                installBtn.style.display = 'none';
            }
        }
        // Re-trigger voice population (user gesture context helps Android Chrome)
        populateVoices.startPolling();
    }

    function closeSettings() {
        document.getElementById('settings-modal').classList.remove('open');
    }

    function saveAPIKey() {
        const keyInput = document.getElementById('api-key-input');
        const key      = (keyInput?.value || '').trim();
        window.DB.setAPIKey(key);
        showToast(key ? 'API key saved.' : 'API key cleared.');
    }

    function saveSyncToken() {
        const input = document.getElementById('sync-github-token');
        const token = (input?.value || '').trim();
        window.SyncManager?.setToken?.(token);
        if (token) {
            showToast('GitHub token saved. Looking for existing sync...');
            // Call setupSync which will search for an existing Gist and pull
            // it if found (preserving data from other devices), or create a
            // new one if this is the first device to sync.
            setTimeout(() => window.SyncManager?.setupSync?.(), 500);
        } else {
            showToast('GitHub token cleared. Sync disabled.');
            window.SyncManager?.updateSyncUI?.();
        }
    }

    function manualPush() {
        window.SyncManager?.push?.(true);
    }

    function manualPull() {
        window.SyncManager?.pull?.(true);
    }

    async function testAPIKey() {
        const btn = document.getElementById('btn-test-api');
        if (!btn) return;

        btn.disabled  = true;
        btn.textContent = 'Testing...';

        try {
            const result = await window.AIEngine.callClaude(
                'Respond with exactly: {"status":"ok"}',
                'Test connection.',
                { maxTokens: 50 }
            );
            showToast('API connection successful!');
            btn.textContent = 'Connected';
        } catch (err) {
            showToast(window.AIEngine.friendlyError(err));
            btn.textContent = 'Failed';
        } finally {
            setTimeout(() => {
                btn.disabled    = false;
                btn.textContent = 'Test connection';
            }, 2000);
        }
    }

    function exportData() {
        const json = window.DB.exportAll();
        const blob = new Blob([json], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `english-master-pro-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('Data exported.');
    }

    function importData() {
        const input    = document.createElement('input');
        input.type     = 'file';
        input.accept   = '.json';
        input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return;
            const reader    = new FileReader();
            reader.onload   = () => {
                if (window.DB.importAll(reader.result)) {
                    showToast('Data imported. Reloading...');
                    setTimeout(() => location.reload(), 1000);
                } else {
                    showToast('Import failed. Invalid file.');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    function clearAllWords() {
        const count = window.DB.loadNotebook().length;
        if (count === 0) { showToast('No words to clear.'); return; }
        if (!confirm(`Clear all ${count} words from notebook? This cannot be undone.`)) return;
        window.DB.saveNotebook([]);
        refreshStats();
        updateNotebookBadge();
        window.MyWords?.refreshStudyList?.();
        window.MyWords?.render?.();
        showToast(`Cleared ${count} words.`);
    }

    function factoryReset() {
        if (!confirm('This will delete ALL your data (history, notebook, settings). Are you sure?')) return;
        if (!confirm('Really? This cannot be undone.')) return;
        window.DB.factoryReset();
        showToast('All data cleared. Reloading...');
        setTimeout(() => location.reload(), 1000);
    }

    // --- Notebook Modal ---
    function openNotebook() {
        document.getElementById('notebook-modal').classList.add('open');
        renderNotebook();
    }

    function closeNotebook() {
        document.getElementById('notebook-modal').classList.remove('open');
    }

    function renderNotebook() {
        const list      = document.getElementById('notebook-list');
        const searchEl  = document.getElementById('notebook-search');
        if (!list) return;

        let words  = window.DB.loadNotebook();
        const query = (searchEl?.value || '').toLowerCase().trim();

        if (query) {
            words = words.filter(w =>
                (w.word || '').toLowerCase().includes(query) ||
                (w.meaning || '').includes(query) ||
                (w.collo || '').toLowerCase().includes(query)
            );
        }

        // Sort by most recent
        words.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

        if (words.length === 0) {
            list.innerHTML = `<p class="nb-empty">${query ? 'No matches found.' : 'Your notebook is empty. Words will appear here as you learn.'}</p>`;
            return;
        }

        list.innerHTML = words.map(w => {
            const tags = (w.tags || []).map(t => `<span class="nb-tag">${escHtml(t)}</span>`).join('');
            const reg  = w.register && w.register !== 'neutral'
                ? `<span class="nb-register nb-register-${w.register}">${w.register}</span>`
                : '';

            return `
                <div class="nb-item">
                    <div class="nb-item-header">
                        <span class="nb-word">${escHtml(w.word)}</span>
                        ${reg}
                        ${tags}
                        <button class="nb-delete" onclick="App.deleteWord('${escAttr(w.word)}')" title="Remove">&times;</button>
                    </div>
                    ${w.meaning ? `<div class="nb-meaning">${escHtml(w.meaning)}</div>` : ''}
                    ${w.enDef   ? `<div class="nb-endef">${escHtml(w.enDef)}</div>` : ''}
                    ${w.collo   ? `<div class="nb-collo">${escHtml(w.collo)}</div>` : ''}
                    ${w.context ? `<div class="nb-context">"${escHtml(w.context)}"</div>` : ''}
                    <div class="nb-meta">
                        ${w.source  ? `<span>from: ${escHtml(w.source)}</span>` : ''}
                        <span>${new Date(w.addedAt || 0).toLocaleDateString()}</span>
                    </div>
                </div>`;
        }).join('');
    }

    function deleteWord(word) {
        window.DB.removeNotebookWord(word);
        renderNotebook();
        updateNotebookBadge();
        showToast('Removed from notebook.');
    }

    function updateNotebookBadge() {
        const badge = document.getElementById('notebook-badge');
        const count = window.DB.loadNotebook().length;
        if (badge) {
            badge.textContent = count;
            badge.style.display = count > 0 ? '' : 'none';
        }
    }

    // --- Stats ---
    function refreshStats() {
        const stats = window.DB.loadStats();

        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };

        setVal('stat-streak',    stats.streakDays || 0);
        setVal('stat-notebook',  window.DB.loadNotebook().length);
    }

    // --- First Run ---
    function checkFirstRun() {
        if (!window.DB.getAPIKey()) {
            setTimeout(() => {
                showToast('Welcome! Set your Claude API key in Settings to get started.', 5000);
            }, 800);
        }
    }

    // --- Scenario Cards for Speaking Coach ---
    function renderScenarioCards() {
        const grid = document.querySelector('.sc-scenario-grid');
        if (!grid || !window.SpeakingCoach) return;

        // Access scenario data from the SCENARIOS constant inside speaking-coach.js
        // We render the cards here because the HTML container is in index.html
        const scenarios = [
            { id: 'meeting_disagree', title: 'Disagree politely in a meeting', icon: '\uD83E\uDD1D' },
            { id: 'email_followup',   title: 'Follow up on unanswered email',  icon: '\u2709\uFE0F' },
            { id: 'present_results',  title: 'Present research results',       icon: '\uD83D\uDCCA' },
            { id: 'small_talk',       title: 'Small talk at a conference',     icon: '\u2615' },
            { id: 'ask_favor',        title: 'Ask a colleague for help',       icon: '\uD83D\uDE4F' },
            { id: 'give_feedback',    title: 'Give constructive feedback',     icon: '\uD83D\uDCDD' },
            { id: 'decline_invite',   title: 'Decline an invitation',          icon: '\uD83D\uDE45' },
            { id: 'explain_delay',    title: 'Explain a project delay',        icon: '\u23F0' }
        ];

        grid.innerHTML = scenarios.map(s => `
            <button class="sc-scenario-card" data-id="${s.id}">
                <span class="sc-scenario-icon">${s.icon}</span>
                <span class="sc-scenario-name">${escHtml(s.title)}</span>
            </button>
        `).join('');
    }

    // --- Global TTS ---
    // Dual-mode: native speechSynthesis on desktop, Google Translate audio fallback on Android
    let ttsMode     = 'detecting';  // 'detecting' | 'native' | 'google'
    let ttsAudioEl  = null;

    function getTTSAudio() {
        if (!ttsAudioEl) {
            ttsAudioEl = document.createElement('audio');
            ttsAudioEl.style.display = 'none';
            document.body.appendChild(ttsAudioEl);
        }
        return ttsAudioEl;
    }

    function speakGoogle(text, rate, onEnd) {
        const audio   = getTTSAudio();
        const encoded = encodeURIComponent(text.slice(0, 200));
        // Detach any prior end handler so we don't fire the previous callback
        audio.onended = null;
        audio.onerror = null;
        audio.src          = 'https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=' + encoded;
        audio.playbackRate = Math.max(0.5, Math.min(rate || 0.85, 2.0));
        if (typeof onEnd === 'function') {
            audio.onended = () => { audio.onended = null; onEnd(); };
            audio.onerror = () => { audio.onerror = null; onEnd(); };
        }
        audio.play().catch(err => {
            console.warn('[TTS-Google] play() error:', err.message);
            if (typeof onEnd === 'function') onEnd();
        });
    }

    function speakNative(text, rate, onEnd) {
        if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
            window.speechSynthesis.cancel();
        }
        const u       = new SpeechSynthesisUtterance(text);
        u.lang        = 'en-US';
        u.rate        = rate || parseFloat(window.DB.getPref('speech_speed', '0.85'));

        const voices   = window.speechSynthesis.getVoices();
        const savedId  = window.DB.getPref('voice_id', '');
        const selected = savedId ? voices.find(v => v.voiceURI === savedId) : null;
        const fallback = voices.find(v => v.lang.startsWith('en') && v.name.includes('Google'))
                      || voices.find(v => v.lang.startsWith('en-US'))
                      || voices.find(v => v.lang.startsWith('en'));
        if (selected || fallback) u.voice = selected || fallback;

        let done = false;
        const fire = () => { if (!done) { done = true; if (typeof onEnd === 'function') onEnd(); } };
        u.onend   = fire;
        u.onerror = (e) => { console.warn('[TTS-Native] Error:', e.error); fire(); };
        window.speechSynthesis.speak(u);
    }

    function speak(text, rate, onEnd) {
        // onEnd: optional callback fired when audio finishes (or fails).
        //        Used by autoplay to chain word→example→next word.
        if (!text) { if (typeof onEnd === 'function') onEnd(); return; }
        const autoSpeak = window.DB.getPref('auto_speak', 'true');
        // If called from navigate (no explicit rate) and auto-speak is off, skip
        if (!rate && autoSpeak === 'false') { if (typeof onEnd === 'function') onEnd(); return; }

        const r = rate || parseFloat(window.DB.getPref('speech_speed', '0.85'));

        // Already decided which engine to use
        if (ttsMode === 'google') {
            speakGoogle(text, r, onEnd);
            return;
        }
        if (ttsMode === 'native') {
            speakNative(text, r, onEnd);
            return;
        }

        // --- Detection mode: probe native, fall back if stuck ---
        if (!window.speechSynthesis) {
            ttsMode = 'google';
            console.log('[TTS] No speechSynthesis API, using Google TTS');
            speakGoogle(text, r, onEnd);
            return;
        }

        const u       = new SpeechSynthesisUtterance(text);
        u.lang        = 'en-US';
        u.rate        = r;
        let started   = false;
        let ended     = false;
        const fire    = () => { if (!ended) { ended = true; if (typeof onEnd === 'function') onEnd(); } };

        u.onstart = () => {
            started = true;
            ttsMode = 'native';
            console.log('[TTS] Native engine works, using native mode');
        };
        u.onend = fire;
        u.onerror = (e) => {
            if (!started) {
                ttsMode = 'google';
                console.log('[TTS] Native error (' + e.error + '), switching to Google TTS');
                speakGoogle(text, r, onEnd);
            } else {
                fire();
            }
        };

        window.speechSynthesis.speak(u);

        // If no onstart after 2s, native is stuck — switch to Google
        setTimeout(() => {
            if (!started && ttsMode === 'detecting') {
                ttsMode = 'google';
                console.log('[TTS] Native stuck (no onstart after 2s), switching to Google TTS');
                window.speechSynthesis.cancel();
                speakGoogle(text, r, onEnd);
            }
        }, 2000);
    }

    // Stop any in-progress TTS. Used by autoplay to interrupt cleanly.
    function stopSpeak() {
        try {
            if (window.speechSynthesis) window.speechSynthesis.cancel();
        } catch {}
        if (ttsAudioEl) {
            ttsAudioEl.onended = null;
            ttsAudioEl.onerror = null;
            try { ttsAudioEl.pause(); } catch {}
            try { ttsAudioEl.currentTime = 0; } catch {}
        }
    }

    // Delegated speak-btn handler
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.speak-btn');
        if (!btn) return;
        const text = btn.dataset.text || '';
        if (text) {
            // Force speak even if auto-speak is off (explicit click)
            const r = parseFloat(window.DB.getPref('speech_speed', '0.85'));
            speak(text, r);
            btn.classList.add('speaking');
            setTimeout(() => btn.classList.remove('speaking'), 1200);
        }
    });

    // Delegated handler for speakable rows (whole row triggers TTS)
    document.addEventListener('click', (e) => {
        const row = e.target.closest('.mw-speakable');
        if (!row) return;
        // Don't double-fire if a speak-btn was clicked inside
        if (e.target.closest('.speak-btn')) return;
        const text = row.dataset.speak || '';
        if (text) {
            const r = parseFloat(window.DB.getPref('speech_speed', '0.85'));
            speak(text, r);
            row.classList.add('mw-speaking');
            setTimeout(() => row.classList.remove('mw-speaking'), 800);
        }
    });

    // --- Settings Initialization ---
    // --- Voice population (hoisted so openSettings can re-trigger) ---
    // On many Android devices, getVoices() returns [] forever even though TTS works
    // fine with the system default. Solution: always provide "System Default" as the
    // first option, and append named voices only when the API actually returns them.
    function populateVoices() {
        const sel = document.getElementById('settings-voice');
        if (!sel) return;

        const voices   = window.speechSynthesis?.getVoices() || [];
        const enVoices = voices.filter(v => v.lang.startsWith('en'));
        const list     = enVoices.length > 0 ? enVoices
                       : voices.length   > 0 ? voices    // fallback: all voices
                       : [];

        // Always start with System Default (voice=null in speak())
        let html = '<option value="">🔊 System Default</option>';
        html += list.map(v =>
            `<option value="${v.voiceURI}">${v.name} (${v.lang})</option>`
        ).join('');
        sel.innerHTML = html;

        // Restore saved selection
        const saved = window.DB.getPref('voice_id', '');
        if (saved) sel.value = saved;

        // Stop polling once voices are loaded
        if (list.length > 0 && populateVoices._pollTimer) {
            clearInterval(populateVoices._pollTimer);
            populateVoices._pollTimer = null;
        }
    }

    // Android Chrome often returns [] from getVoices() on first call.
    // Poll every 250ms up to 3 seconds until voices appear.
    populateVoices.startPolling = function() {
        // Run once immediately
        populateVoices();
        // Clear any previous polling
        if (populateVoices._pollTimer) clearInterval(populateVoices._pollTimer);
        let attempts = 0;
        populateVoices._pollTimer = setInterval(() => {
            attempts++;
            populateVoices();
            if (attempts >= 12) {  // 12 × 250ms = 3s max
                clearInterval(populateVoices._pollTimer);
                populateVoices._pollTimer = null;
                // If still no voices after 3s, pre-set Google TTS mode
                // so first speak doesn't wait 2s for detection timeout
                const voices = window.speechSynthesis?.getVoices() || [];
                if (voices.length === 0 && ttsMode === 'detecting') {
                    ttsMode = 'google';
                    console.log('[TTS] No voices after polling, pre-setting Google TTS mode');
                }
            }
        }, 250);
    };

    function initSettings() {
        // Populate voice selector — use polling for Android compatibility
        populateVoices.startPolling();
        if (window.speechSynthesis?.onvoiceschanged !== undefined) {
            window.speechSynthesis.onvoiceschanged = populateVoices;
        }

        // Voice select
        document.getElementById('settings-voice')?.addEventListener('change', (e) => {
            window.DB.setPref('voice_id', e.target.value);
            // Preview
            speak('Hello, this is my voice.', parseFloat(window.DB.getPref('speech_speed', '0.85')));
        });

        // Speed slider
        const speedSlider = document.getElementById('settings-speed');
        const speedVal    = document.getElementById('settings-speed-val');
        const savedSpeed  = window.DB.getPref('speech_speed', '0.85');
        if (speedSlider) speedSlider.value = savedSpeed;
        if (speedVal)    speedVal.textContent = savedSpeed;
        speedSlider?.addEventListener('input', (e) => {
            const v = e.target.value;
            if (speedVal) speedVal.textContent = v;
            window.DB.setPref('speech_speed', v);
        });

        // Auto-speak checkbox
        const autoCheck = document.getElementById('settings-auto-speak');
        if (autoCheck) autoCheck.checked = window.DB.getPref('auto_speak', 'true') === 'true';
        autoCheck?.addEventListener('change', (e) => {
            window.DB.setPref('auto_speak', e.target.checked ? 'true' : 'false');
        });

        // Show CN default checkbox
        const cnCheck = document.getElementById('settings-show-cn');
        if (cnCheck) cnCheck.checked = window.DB.getPref('show_cn_default', 'false') === 'true';
        cnCheck?.addEventListener('change', (e) => {
            window.DB.setPref('show_cn_default', e.target.checked ? 'true' : 'false');
        });

        // Group size
        const groupInput = document.getElementById('settings-group-size');
        const savedGroup = window.DB.getPref('group_size', '20');
        if (groupInput) groupInput.value = savedGroup;
        groupInput?.addEventListener('change', (e) => {
            const v = Math.max(5, Math.min(100, parseInt(e.target.value) || 20));
            e.target.value = v;
            window.DB.setPref('group_size', String(v));
        });

        // AI Provider & Model
        initAIProviderSettings();
    }

    function initAIProviderSettings() {
        const provSel  = document.getElementById('settings-ai-provider');
        const modelSel = document.getElementById('settings-ai-model');
        if (!provSel || !modelSel) return;

        const providers = window.AIEngine?.PROVIDERS || {};

        // Populate provider dropdown
        provSel.innerHTML = Object.entries(providers).map(([id, p]) =>
            `<option value="${id}">${p.label}</option>`
        ).join('');

        // Restore saved provider
        const savedProv = window.DB.getPref('ai_provider', 'claude');
        provSel.value = savedProv;

        // Populate model dropdown for current provider
        populateModelDropdown();

        // Provider change → update model list + key hint
        provSel.addEventListener('change', () => {
            window.DB.setPref('ai_provider', provSel.value);
            window.DB.setPref('ai_model', ''); // reset model to default
            populateModelDropdown();
            refreshAIProviderUI();
        });

        // Model change
        modelSel.addEventListener('change', () => {
            window.DB.setPref('ai_model', modelSel.value);
        });
    }

    function populateModelDropdown() {
        const provSel  = document.getElementById('settings-ai-provider');
        const modelSel = document.getElementById('settings-ai-model');
        if (!provSel || !modelSel) return;

        const providers = window.AIEngine?.PROVIDERS || {};
        const prov      = providers[provSel.value] || {};
        const models    = prov.models || [];
        const saved     = window.DB.getPref('ai_model', '');

        modelSel.innerHTML = models.map(m =>
            `<option value="${m}">${m}</option>`
        ).join('');
        modelSel.value = saved && models.includes(saved) ? saved : (prov.default || models[0] || '');
        window.DB.setPref('ai_model', modelSel.value);
    }

    function refreshAIProviderUI() {
        const provSel  = document.getElementById('settings-ai-provider');
        const keyInput = document.getElementById('api-key-input');
        const keyLabel = document.getElementById('api-key-label');
        if (!provSel) return;

        const providers = window.AIEngine?.PROVIDERS || {};
        const prov      = providers[provSel.value] || {};

        // Update key placeholder hint
        if (keyInput) keyInput.placeholder = prov.keyHint || 'API key...';
        if (keyLabel) keyLabel.textContent = `${prov.label || 'API'} Key`;
    }

    // --- Toast ---
    function showToast(msg, duration) {
        duration = duration || 3000;
        let container = document.getElementById('toast-container');
        if (!container) {
            container    = document.createElement('div');
            container.id = 'toast-container';
            document.body.appendChild(container);
        }

        const toast       = document.createElement('div');
        toast.className   = 'toast';
        toast.textContent = msg;
        container.appendChild(toast);

        requestAnimationFrame(() => toast.classList.add('show'));
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    // --- Utilities ---
    function escHtml(str) {
        const div       = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    }
    function escAttr(str) {
        return (str || '').replace(/'/g, "\\'").replace(/\n/g, ' ');
    }

    // Public API
    return {
        init,
        navigateTo,
        openSettings,
        closeSettings,
        openNotebook,
        closeNotebook,
        deleteWord,
        showToast,
        refreshStats,
        updateNotebookBadge,
        speak,
        stopSpeak
    };
})();

// Boot
document.addEventListener('DOMContentLoaded', () => window.App.init());
