// ============================================================
// app.js — English Master Pro main bootstrap
// ============================================================
// Responsibilities:
//   1. Expose window.App — the shared helper surface used by every
//      module: showToast, speak/stopSpeak, openSettings,
//      updateNotebookBadge, refreshStats.
//   2. On DOMContentLoaded, initialize every feature module
//      (MyWords, ExpressionCoach, SentenceDrill, WritingLab,
//      VocabDrill, Reader, SpeakingCoach).
//   3. Wire the top-level nav (tab switching) and the Settings +
//      Notebook modals and all their controls.
// ============================================================

(function() {
    'use strict';

    // ─── Toast ──────────────────────────────────────────────
    function showToast(msg, ms) {
        const dur       = Math.max(1500, Number(ms) || 2200);
        const host      = document.getElementById('toast-container');
        if (!host) { console.log('[toast]', msg); return; }

        const el         = document.createElement('div');
        el.className     = 'toast';
        el.textContent   = String(msg == null ? '' : msg);
        host.appendChild(el);

        // Trigger enter animation on next frame
        requestAnimationFrame(() => el.classList.add('toast-show'));

        setTimeout(() => {
            el.classList.remove('toast-show');
            setTimeout(() => el.remove(), 250);
        }, dur);
    }

    // ─── Speech synthesis ───────────────────────────────────
    // Android quirk: speechSynthesis.getVoices() often returns [] on
    // first call; voices arrive asynchronously via onvoiceschanged.
    // We keep a cached voice list and resolve a usable voice lazily.
    let cachedVoices = [];
    function refreshVoices() {
        try {
            cachedVoices = window.speechSynthesis?.getVoices?.() || [];
        } catch {
            cachedVoices = [];
        }
        return cachedVoices;
    }
    if ('speechSynthesis' in window) {
        refreshVoices();
        window.speechSynthesis.onvoiceschanged = () => {
            refreshVoices();
            // If Settings is open, repopulate the voice dropdown
            populateVoiceSelect();
        };
    }

    // Preferred voice substrings, in priority order. We check voice.name
    // for these (case-insensitive). Google and newer Microsoft voices
    // are dramatically less robotic than the old Microsoft David/Zira
    // bundled with Windows — those mechanical pauses at every comma are
    // a known problem with older SAPI5 voices.
    const PREFERRED_EN_VOICES = [
        'Google US English',
        'Google UK English Female',
        'Google UK English Male',
        'Microsoft Aria',       // Windows 11 online
        'Microsoft Jenny',      // Windows 11 online
        'Microsoft Guy',
        'Samantha',             // macOS / iOS
        'Karen',                // macOS en-AU
        'Daniel',               // macOS en-GB
        'Microsoft Mark',       // less robotic than David
        'Microsoft Zira'        // fallback — still better than David for some sentences
    ];

    function resolveVoice() {
        const wanted = window.DB?.getPref?.('tts_voice', '') || '';
        const voices = cachedVoices.length ? cachedVoices : refreshVoices();

        // User explicitly picked a voice — honor it.
        if (wanted && wanted !== '__default__') {
            return voices.find(v => v.voiceURI === wanted)
                || voices.find(v => v.name === wanted)
                || null;
        }

        // System Default: try to find a natural-sounding English voice
        // before falling back to whatever the OS chose (often robotic).
        for (const pref of PREFERRED_EN_VOICES) {
            const match = voices.find(v => (v.name || '').toLowerCase().includes(pref.toLowerCase()));
            if (match) return match;
        }
        return null;  // ultimate fallback — let the browser decide
    }

    // speak(text, rate?, onEnd?, opts?)
    //   opts.lang — 'en-US' (default) | 'zh-CN' | BCP-47 tag.
    //   When lang is non-default English, we pick a matching voice from
    //   the available voices list; on Android where getVoices()==[], we
    //   still set utterance.lang so the system default TTS picks the
    //   right engine.
    function speak(text, rate, onEnd, opts) {
        if (!text || !('speechSynthesis' in window)) {
            if (typeof onEnd === 'function') onEnd();
            return;
        }
        const wantLang = (opts && opts.lang) || '';
        try {
            window.speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(String(text));

            // Voice / lang selection
            if (wantLang) {
                // Caller specified a language — find a voice matching it
                const voices = refreshVoices();
                const match  = voices.find(v => (v.lang || '').toLowerCase().startsWith(wantLang.toLowerCase().split('-')[0]));
                if (match) u.voice = match;
                u.lang = wantLang;
            } else {
                const v = resolveVoice();
                if (v) u.voice = v;
                u.lang = (v && v.lang) || 'en-US';
            }

            u.rate    = Number(rate) || parseFloat(window.DB?.getPref?.('speech_speed', '0.9')) || 0.9;
            u.pitch   = 1.05;   // slight lift helps voices like Google US English sound less flat
            u.volume  = 1;
            u.onend   = () => { if (typeof onEnd === 'function') onEnd(); };
            u.onerror = () => { if (typeof onEnd === 'function') onEnd(); };
            window.speechSynthesis.speak(u);
        } catch (e) {
            console.warn('[speak] failed:', e);
            if (typeof onEnd === 'function') onEnd();
        }
    }

    function stopSpeak() {
        try { window.speechSynthesis?.cancel?.(); } catch {}
    }

    // ─── Header stats ───────────────────────────────────────
    function updateNotebookBadge() {
        const nb        = window.DB?.loadNotebook?.() || [];
        const count     = nb.length;

        const headerEl  = document.getElementById('stat-notebook');
        if (headerEl) headerEl.textContent = String(count);

        const btnBadge  = document.getElementById('notebook-badge');
        if (btnBadge) {
            btnBadge.textContent   = String(count);
            btnBadge.style.display = count > 0 ? '' : 'none';
        }
    }

    function refreshStats() {
        const stats     = window.DB?.loadStats?.() || {};
        const streakEl  = document.getElementById('stat-streak');
        if (streakEl) streakEl.textContent = String(stats.streakDays || 0);
        updateNotebookBadge();
    }

    // ─── Settings modal ─────────────────────────────────────
    function openSettings() {
        const modal = document.getElementById('settings-modal');
        if (!modal) return;
        hydrateSettingsUI();
        modal.classList.add('open');
    }
    function closeSettings() {
        document.getElementById('settings-modal')?.classList.remove('open');
    }

    function hydrateSettingsUI() {
        // Voice
        populateVoiceSelect();

        // Speed
        const speedEl   = document.getElementById('settings-speed');
        const speedVal  = document.getElementById('settings-speed-val');
        const savedSpd  = parseFloat(window.DB.getPref('speech_speed', '0.9')) || 0.9;
        if (speedEl)    speedEl.value        = String(savedSpd);
        if (speedVal)   speedVal.textContent = savedSpd.toFixed(2);

        // Auto-speak
        const autoEl    = document.getElementById('settings-auto-speak');
        if (autoEl) autoEl.checked = window.DB.getPref('auto_speak', 'true') === 'true';

        // Group size
        const gsEl      = document.getElementById('settings-group-size');
        if (gsEl) gsEl.value = window.DB.getPref('group_size', '20');

        // Show CN by default
        const cnEl      = document.getElementById('settings-show-cn');
        if (cnEl) cnEl.checked = window.DB.getPref('show_cn_default', 'false') === 'true';

        // AI provider / model
        populateProviderSelect();
        populateModelSelect();

        // API key (masked echo — only show if already saved)
        const keyEl     = document.getElementById('api-key-input');
        const keyLbl    = document.getElementById('api-key-label');
        if (keyEl) {
            const k = window.DB.getAPIKey();
            keyEl.value       = k ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' + k.slice(-4) : '';
            keyEl.placeholder = window.AIEngine.getProviderDef().keyHint || 'API key';
        }
        if (keyLbl) keyLbl.textContent = `${window.AIEngine.getProviderDef().label} key`;

        // Sync token
        const tokEl     = document.getElementById('sync-github-token');
        if (tokEl) {
            const t = window.SyncManager?.getToken?.() || '';
            tokEl.value = t ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' + t.slice(-4) : '';
        }

        // Debug panel toggle
        const dbgEl     = document.getElementById('pref-debug-panel');
        if (dbgEl) dbgEl.checked = window.DB.getPref('debug_panel_enabled', 'false') === 'true';
    }

    function populateVoiceSelect() {
        const sel = document.getElementById('settings-voice');
        if (!sel) return;
        const voices    = refreshVoices();
        const saved     = window.DB?.getPref?.('tts_voice', '__default__') || '__default__';

        // Filter: only English and Chinese voices — those are the two languages
        // the app actually uses (EN for learning content, ZH for translations).
        // Covers en-*, zh-*, and cmn-* (Mandarin BCP-47 tag).
        const isRelevant = (v) => {
            const lang = (v.lang || '').toLowerCase();
            return lang.startsWith('en') || lang.startsWith('zh') || lang.startsWith('cmn');
        };

        // Android fallback: always include a "System Default" option because
        // getVoices() may return [] permanently on some devices.
        let html = `<option value="__default__">System Default${voices.length ? '' : ' (voice list unavailable)'}</option>`;

        // Build filtered list: English voices first, then Chinese
        const filtered = voices.filter(isRelevant);
        const en       = filtered.filter(v => (v.lang || '').toLowerCase().startsWith('en'));
        const zh       = filtered.filter(v => !((v.lang || '').toLowerCase().startsWith('en')));

        // Escape hatch: if the user has previously saved a voice that's now
        // being filtered out (e.g. a French voice from before this filter),
        // still include it so they don't silently lose their setting.
        const savedVoice = voices.find(v => (v.voiceURI === saved) || (v.name === saved));
        const savedOutsideFilter = savedVoice && !isRelevant(savedVoice);

        [...en, ...zh].forEach(v => {
            const val = v.voiceURI || v.name;
            html += `<option value="${escapeAttr(val)}">${escapeHtml(v.name)} \u2014 ${escapeHtml(v.lang || '')}</option>`;
        });

        if (savedOutsideFilter) {
            const val = savedVoice.voiceURI || savedVoice.name;
            html += `<option value="${escapeAttr(val)}">${escapeHtml(savedVoice.name)} \u2014 ${escapeHtml(savedVoice.lang || '')} (saved)</option>`;
        }

        sel.innerHTML = html;
        sel.value     = saved;
    }

    function populateProviderSelect() {
        const sel = document.getElementById('settings-ai-provider');
        if (!sel) return;
        const current = window.AIEngine.getProvider();
        const opts = Object.entries(window.AIEngine.PROVIDERS).map(
            ([key, def]) => `<option value="${key}">${escapeHtml(def.label)}</option>`
        ).join('');
        sel.innerHTML = opts;
        sel.value     = current;
    }

    function populateModelSelect() {
        const sel = document.getElementById('settings-ai-model');
        if (!sel) return;
        const prov    = window.AIEngine.getProviderDef();
        const current = window.AIEngine.getModel();
        sel.innerHTML = (prov.models || []).map(
            m => `<option value="${escapeAttr(m)}">${escapeHtml(m)}</option>`
        ).join('');
        sel.value = current;
    }

    function bindSettingsHandlers() {
        // Close
        document.getElementById('settings-close')?.addEventListener('click', closeSettings);
        document.getElementById('settings-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'settings-modal') closeSettings();
        });

        // Voice / speed / auto-speak
        document.getElementById('settings-voice')?.addEventListener('change', (e) => {
            window.DB.setPref('tts_voice', e.target.value);
        });
        const speedEl = document.getElementById('settings-speed');
        speedEl?.addEventListener('input', (e) => {
            const v = parseFloat(e.target.value) || 0.9;
            document.getElementById('settings-speed-val').textContent = v.toFixed(2);
            window.DB.setPref('speech_speed', String(v));
        });
        document.getElementById('settings-auto-speak')?.addEventListener('change', (e) => {
            window.DB.setPref('auto_speak', e.target.checked ? 'true' : 'false');
        });

        // Study
        document.getElementById('settings-group-size')?.addEventListener('change', (e) => {
            const n = Math.max(5, Math.min(100, parseInt(e.target.value, 10) || 20));
            e.target.value = String(n);
            window.DB.setPref('group_size', String(n));
            window.MyWords?.render?.();
        });
        document.getElementById('settings-show-cn')?.addEventListener('change', (e) => {
            window.DB.setPref('show_cn_default', e.target.checked ? 'true' : 'false');
            window.MyWords?.render?.();
        });

        // AI provider / model
        document.getElementById('settings-ai-provider')?.addEventListener('change', (e) => {
            window.DB.setPref('ai_provider', e.target.value);
            // Reset model pref so AIEngine.getModel() falls back to the new provider's default
            window.DB.setPref('ai_model', '');
            populateModelSelect();
            // Update API key label + hint for the new provider
            const keyEl  = document.getElementById('api-key-input');
            const keyLbl = document.getElementById('api-key-label');
            if (keyEl)  keyEl.placeholder  = window.AIEngine.getProviderDef().keyHint || 'API key';
            if (keyLbl) keyLbl.textContent = `${window.AIEngine.getProviderDef().label} key`;
        });
        document.getElementById('settings-ai-model')?.addEventListener('change', (e) => {
            window.DB.setPref('ai_model', e.target.value);
        });

        // Save API key
        document.getElementById('btn-save-api-key')?.addEventListener('click', () => {
            const el = document.getElementById('api-key-input');
            const v  = (el?.value || '').trim();
            if (!v || v.startsWith('\u2022')) { showToast('Enter a new API key first.'); return; }
            window.DB.setAPIKey(v);
            el.value = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' + v.slice(-4);
            showToast('API key saved.');
        });

        // Test API
        document.getElementById('btn-test-api')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            if (!window.AIEngine.hasAPIKey()) { showToast('Save an API key first.'); return; }
            const originalText = btn.textContent;
            btn.disabled    = true;
            btn.textContent = 'Testing\u2026';
            try {
                const out = await window.AIEngine.callClaude(
                    'You are a terse assistant. Reply with exactly: OK',
                    'ping',
                    { maxTokens: 20 }
                );
                showToast(out.trim().toLowerCase().includes('ok') ? 'API key works!' : `Got: ${out.slice(0, 60)}`);
            } catch (err) {
                showToast(window.AIEngine.friendlyError(err));
            } finally {
                btn.disabled    = false;
                btn.textContent = originalText;
            }
        });

        // Sync token
        document.getElementById('btn-save-sync-token')?.addEventListener('click', () => {
            const el = document.getElementById('sync-github-token');
            const v  = (el?.value || '').trim();
            if (!v || v.startsWith('\u2022')) { showToast('Enter a new GitHub token first.'); return; }
            window.SyncManager?.setToken?.(v);
            el.value = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' + v.slice(-4);
            showToast('Sync token saved.');
            window.SyncManager?.setupSync?.();
        });
        document.getElementById('btn-sync-push')?.addEventListener('click', () => window.SyncManager?.push?.(true));
        document.getElementById('btn-sync-pull')?.addEventListener('click', () => window.SyncManager?.pull?.(true));

        // Debug panel toggle
        document.getElementById('pref-debug-panel')?.addEventListener('change', (e) => {
            window.DB.setPref('debug_panel_enabled', e.target.checked ? 'true' : 'false');
            // The module exposes itself as window.Debug; older builds used
            // window.DebugPanel. Accept either so settings toggle never
            // forces a reload when the live API is available.
            const debugApi = window.Debug || window.DebugPanel;
            if (debugApi?.setEnabled) {
                debugApi.setEnabled(e.target.checked);
            } else {
                // Fall back to reload so debug-panel.js picks up the new pref on next boot
                showToast('Reloading to apply\u2026');
                setTimeout(() => location.reload(), 600);
            }
        });

        // Export
        document.getElementById('btn-export')?.addEventListener('click', () => {
            try {
                // Privacy: ask before bundling the API key into the backup file.
                // Default no — most users export to move learning data, not keys.
                const includeKey = confirm(
                    'Include your API key in the backup file?\n\n' +
                    'OK = include (convenient, but the key is plaintext in the file).\n' +
                    'Cancel = exclude (safer; you\'ll re-enter the key after import).'
                );
                const json = window.DB.exportAll({ includeApiKey: includeKey });
                const blob = new Blob([json], { type: 'application/json' });
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement('a');
                a.href     = url;
                a.download = `english-master-pro-backup-${new Date().toISOString().slice(0, 10)}.json`;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
                showToast(includeKey ? 'Backup downloaded (with API key).' : 'Backup downloaded (no API key).');
            } catch (err) {
                showToast('Export failed: ' + (err.message || err));
            }
        });

        // Import — true overwrite: clears profile keys before applying the backup
        // so stale entries don't survive. The confirm prompt promises this; now
        // it actually does it.
        document.getElementById('btn-import')?.addEventListener('click', () => {
            const inp      = document.createElement('input');
            inp.type       = 'file';
            inp.accept     = 'application/json,.json';
            inp.onchange   = (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const rd = new FileReader();
                rd.onload = () => {
                    if (!confirm('Import will overwrite current data. Continue?')) return;
                    const ok = window.DB.importAll(rd.result, { replace: true });
                    if (ok) {
                        showToast('Imported. Reloading\u2026');
                        setTimeout(() => location.reload(), 800);
                    } else {
                        showToast('Import failed \u2014 invalid file.');
                    }
                };
                rd.readAsText(file);
            };
            inp.click();
        });

        // Clear words only
        document.getElementById('btn-clear-words')?.addEventListener('click', () => {
            if (!confirm('Remove ALL vocabulary? This cannot be undone.')) return;
            window.DB.saveNotebook([]);
            updateNotebookBadge();
            window.MyWords?.refreshStudyList?.();
            window.MyWords?.render?.();
            showToast('All words cleared.');
        });

        // Factory reset — two-stage so the user can choose whether to also
        // wipe API key and sync credentials. The previous version silently
        // left those behind, which was a privacy footgun on shared devices.
        document.getElementById('btn-factory-reset')?.addEventListener('click', () => {
            if (!confirm('FACTORY RESET: wipe all app data for this profile? This cannot be undone.')) return;
            if (!confirm('Are you absolutely sure? All words, history, and settings will be lost.')) return;
            const wipeCreds = confirm(
                'Also clear API key and cloud-sync credentials?\n\n' +
                'OK = clear everything (full reset, including keys/tokens).\n' +
                'Cancel = keep API key and sync token (only learning data is wiped).'
            );
            window.DB.factoryReset({ clearCredentials: wipeCreds });
            showToast(wipeCreds ? 'Full reset complete. Reloading\u2026' : 'Learning data wiped. Reloading\u2026');
            setTimeout(() => location.reload(), 800);
        });
    }

    // ─── Notebook modal ─────────────────────────────────────
    function openNotebook() {
        const modal = document.getElementById('notebook-modal');
        if (!modal) return;
        renderNotebookList('');
        const searchEl = document.getElementById('notebook-search');
        if (searchEl) searchEl.value = '';
        modal.classList.add('open');
    }
    function closeNotebook() {
        document.getElementById('notebook-modal')?.classList.remove('open');
    }

    function renderNotebookList(query) {
        const host = document.getElementById('notebook-list');
        if (!host) return;
        const nb    = window.DB?.loadNotebook?.() || [];
        const q     = String(query || '').toLowerCase().trim();
        const items = q
            ? nb.filter(w => (w.word || '').toLowerCase().includes(q) || (w.meaning || '').toLowerCase().includes(q))
            : nb;

        if (items.length === 0) {
            host.innerHTML = `<p style="color:var(--text-tertiary);font-size:13px;text-align:center;padding:20px 0">No words yet. Add some in My Words.</p>`;
            return;
        }
        // Newest first
        items.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        host.innerHTML = items.slice(0, 500).map(w => `
            <div class="notebook-item">
                <div class="notebook-item-main">
                    <strong>${escapeHtml(w.word || '')}</strong>
                    ${w.phonetic ? `<span class="notebook-item-phon">${escapeHtml(w.phonetic)}</span>` : ''}
                </div>
                ${w.meaning ? `<div class="notebook-item-meaning">${escapeHtml(w.meaning)}</div>` : ''}
            </div>
        `).join('');
    }

    function bindNotebookHandlers() {
        document.getElementById('btn-notebook')?.addEventListener('click', openNotebook);
        document.getElementById('notebook-close')?.addEventListener('click', closeNotebook);
        document.getElementById('notebook-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'notebook-modal') closeNotebook();
        });
        document.getElementById('notebook-search')?.addEventListener('input', (e) => {
            renderNotebookList(e.target.value);
        });
    }

    // ─── Tab navigation ─────────────────────────────────────
    // Tab IDs in markup: my-words | speaking-coach | vocab-drill |
    // writing-lab | reader. Each maps to #view-<id>.
    function bindTabs() {
        const tabs   = document.querySelectorAll('.nav-tab[data-nav]');
        const views  = document.querySelectorAll('.app-view');

        // Restore the last-active tab from localStorage. Falls back to
        // whichever tab is marked .active in the HTML (My Words by default).
        // This is what fixes the "page jumps to My Words after a sync
        // reload" complaint — we now remember where the user was.
        try {
            const saved = window.DB?.getPref?.('active_tab', null);
            if (saved) {
                const tab = document.querySelector(`.nav-tab[data-nav="${saved}"]`);
                if (tab) {
                    tabs.forEach(x  => x.classList.toggle('active', x === tab));
                    views.forEach(v => v.classList.toggle('active', v.id === `view-${saved}`));
                }
            }
        } catch {}

        tabs.forEach(t => t.addEventListener('click', () => {
            const target = t.dataset.nav;
            tabs.forEach(x  => x.classList.toggle('active', x === t));
            views.forEach(v => v.classList.toggle('active', v.id === `view-${target}`));
            // Persist for next reload — a config-change reload, a
            // service-worker update, or a manual refresh will all
            // restore this tab.
            try { window.DB?.setPref?.('active_tab', target); } catch {}
            // Stop any ongoing playback when switching tabs
            stopSpeak();
            window.MyWords?.stopAutoplay?.();
            window.SentenceDrill?.stopListen?.();
        }));
    }

    // ─── Expressions sub-tabs (drill / sentences / …) ───────
    function bindExpressionSubTabs() {
        const tabs   = document.querySelectorAll('.sc-tabs .sc-tab[data-panel]');
        const panels = document.querySelectorAll('.sc-panel');

        // Restore the last-active sub-tab (Core / Mine / Phrases / …)
        try {
            const saved = window.DB?.getPref?.('active_subtab', null);
            if (saved) {
                const tab = document.querySelector(`.sc-tabs .sc-tab[data-panel="${saved}"]`);
                if (tab) {
                    tabs.forEach(x   => x.classList.toggle('active', x === tab));
                    panels.forEach(p => p.classList.toggle('active', p.id === saved));
                    // If we restored Mine, ensure its content is rendered
                    if (saved === 'sc-panel-mine') {
                        const el = document.getElementById('sc-panel-mine');
                        if (el && window.SentenceDrill?.initMine) window.SentenceDrill.initMine(el);
                    }
                }
            }
        } catch {}

        tabs.forEach(t => t.addEventListener('click', () => {
            const panelId = t.dataset.panel;
            tabs.forEach(x   => x.classList.toggle('active', x === t));
            panels.forEach(p => p.classList.toggle('active', p.id === panelId));
            // Persist for next reload
            try { window.DB?.setPref?.('active_subtab', panelId); } catch {}
            stopSpeak();
            window.SentenceDrill?.stopListen?.();
            // When switching into Mine, re-render so newly-added MyWords
            // entries show up immediately (initMine only runs at boot).
            if (panelId === 'sc-panel-mine') {
                const el = document.getElementById('sc-panel-mine');
                if (el && window.SentenceDrill?.initMine) window.SentenceDrill.initMine(el);
            }
        }));
    }

    // ─── HTML helpers ───────────────────────────────────────
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    function escapeAttr(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ─── Global click delegation for speakable surfaces ─────
    // Two surface conventions are recognized:
    //   1. .speak-btn[data-text] — explicit speaker buttons rendered next
    //      to words, options, sentence cards, etc.
    //   2. [data-speak] — entire speakable rows / boxes (English
    //      definitions, collocation chips, example sentences). Tapping
    //      anywhere in the box triggers speech, matching the visual
    //      affordance (cursor: pointer in CSS).
    // closest() walks up from the click target, so when a .speak-btn is
    // nested inside a [data-speak] container, the inner button wins —
    // which is correct: it preserves any per-button data-text override.
    function bindGlobalSpeakButtons() {
        document.addEventListener('click', (e) => {
            const el = e.target.closest('.speak-btn[data-text], [data-speak]');
            if (!el) return;
            const text = (el.dataset.text || el.dataset.speak || '').trim();
            if (!text) return;
            e.preventDefault();
            e.stopPropagation();
            speak(text);
        });
    }

    // ─── Active-session tracker ─────────────────────────────
    // Modules that run a multi-step interactive flow (autoplay, drilling,
    // analysis-in-flight) can call beginSession/endSession to suppress
    // auto-reload from the service worker. The SW update path consults
    // isStudySessionActive() before reloading so a fresh deploy doesn't
    // yank the user out of a sentence playback or a writing review.
    //
    // Activity is also implicitly tracked: any keystroke or text input
    // in the document marks the user as "active" for 60s afterward,
    // so reloads don't fire while they're mid-sentence in writing-lab
    // or typing into a drill input on PC.
    const _sessionTokens   = new Set();
    let   _lastActivityAt  = 0;
    const ACTIVITY_TIMEOUT = 60000;  // 60s after last keystroke = still "active"

    function _markActivity() { _lastActivityAt = Date.now(); }

    // Capture-phase listeners so we see input even when modules
    // stopPropagation. Passive so we never block typing.
    document.addEventListener('input',   _markActivity, { capture: true, passive: true });
    document.addEventListener('keydown', _markActivity, { capture: true, passive: true });

    function beginSession(label) {
        const token = label || `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        _sessionTokens.add(token);
        return token;
    }
    function endSession(token) {
        if (token) _sessionTokens.delete(token);
    }
    function isStudySessionActive() {
        // Explicit module-declared sessions
        if (_sessionTokens.size > 0)                          return true;
        // Module-specific activity: autoplay, sentence listen, TTS speaking
        if (window.MyWords?.isAutoplayActive?.())             return true;
        if (window.SentenceDrill?.isListenActive?.())         return true;
        try {
            if (window.speechSynthesis?.speaking)             return true;
        } catch {}
        // Implicit: the user is currently focused in an editable field
        const ae = document.activeElement;
        if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable)) {
            return true;
        }
        // Implicit: the user typed within the last ACTIVITY_TIMEOUT
        if (_lastActivityAt && (Date.now() - _lastActivityAt) < ACTIVITY_TIMEOUT) {
            return true;
        }
        return false;
    }

    // ─── Public API ─────────────────────────────────────────
    window.App = {
        showToast,
        speak,
        stopSpeak,
        openSettings,
        closeSettings,
        openNotebook,
        closeNotebook,
        updateNotebookBadge,
        refreshStats,
        // Helpers other modules can use for safe HTML rendering
        escHtml: escapeHtml,
        escAttr: escapeAttr,
        // Study-session lifecycle (suppresses auto-reload during playback)
        beginSession,
        endSession,
        isStudySessionActive
    };

    // ─── Boot ───────────────────────────────────────────────
    function boot() {
        try {
            // Verify required globals are actually present before initializing
            // modules — a missing global is a clearer error than a cascade of
            // undefined-method failures deep inside a feature.
            const missing = [];
            ['APP_CONFIG', 'DB', 'AIEngine', 'MyWords'].forEach(n => {
                if (!window[n]) missing.push(n);
            });
            if (missing.length) {
                console.error('[app] Missing required globals:', missing.join(', '));
                showToast('Startup error: ' + missing.join(', ') + ' not loaded.');
            }

            // Wire top-level UI first — these must work even if a module init fails.
            bindTabs();
            bindExpressionSubTabs();
            bindSettingsHandlers();
            bindNotebookHandlers();
            bindGlobalSpeakButtons();
            document.getElementById('btn-settings')?.addEventListener('click', openSettings);

            // Initialize feature modules. Wrap each in try/catch so one
            // broken module cannot prevent the others from loading.
            safeCall('MyWords',         () => window.MyWords?.init?.());
            safeCall('WritingLab',      () => window.WritingLab?.init?.());
            safeCall('VocabDrill',      () => window.VocabDrill?.init?.());
            safeCall('Reader',          () => window.Reader?.init?.());
            safeCall('SpeakingCoach',   () => window.SpeakingCoach?.init?.());
            safeCall('ExpressionCoach', () => {
                const el = document.getElementById('sc-panel-drill');
                if (el && window.ExpressionCoach?.init) window.ExpressionCoach.init(el);
            });
            safeCall('SentenceDrill', () => {
                const elCurated = document.getElementById('sc-panel-curated');
                const elMine    = document.getElementById('sc-panel-mine');
                if (elCurated && window.SentenceDrill?.initCurated) {
                    window.SentenceDrill.initCurated(elCurated);
                }
                if (elMine && window.SentenceDrill?.initMine) {
                    window.SentenceDrill.initMine(elMine);
                }
            });

            // Header stats
            refreshStats();

            console.log('[app] Boot complete.');
        } catch (err) {
            console.error('[app] Boot error:', err);
            showToast('Startup error \u2014 check console.');
        }
    }

    function safeCall(label, fn) {
        try { fn(); }
        catch (e) { console.error(`[app] ${label}.init failed:`, e); }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

})();
