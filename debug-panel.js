// ============================================================
// debug-panel.js — Temporary diagnostics overlay
//
// Purpose: give us a mobile-side window into layout and PWA
// state without needing a USB cable or remote debugging.
// Remove this file (and the two lines in index.html that load it)
// once we've resolved the open issues.
//
// Interface:
//   - A small "DBG" toggle button fixed to the bottom-right corner.
//   - Tapping it opens a bottom-sheet panel with:
//       • Environment info (viewport, DPR, matched media queries, UA)
//       • Buttons that measure specific UI elements and dump metrics
//       • PWA install / service-worker state
//       • A live log that captures console.log/warn/error
//       • Quick actions: install, unregister SW, clear data, copy dump
// ============================================================

(function() {
    'use strict';

    // Hook console BEFORE the page's own scripts get chatty, so we
    // don't miss early warnings. This runs at script load time because
    // debug-panel.js is placed last in the script order in index.html,
    // but if we move it earlier it still works.
    const logBuffer = [];
    const MAX_LOG = 500;
    const origLog  = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origErr  = console.error.bind(console);

    // Hoist these declarations up so that capture() and dbg() — which
    // reference them via closure and may run at script-load time before
    // build() executes — don't hit the temporal-dead-zone ReferenceError.
    let panelRoot = null;
    let panelBody = null;
    let logPane   = null;
    let isOpen    = false;

    function stringify(args) {
        return Array.from(args).map(a => {
            if (a instanceof Error) return a.stack || a.message;
            if (typeof a === 'object') {
                try { return JSON.stringify(a); } catch { return String(a); }
            }
            return String(a);
        }).join(' ');
    }
    function capture(level, args) {
        logBuffer.push({ t: Date.now(), level, msg: stringify(args) });
        if (logBuffer.length > MAX_LOG) logBuffer.shift();
        if (panelBody && logPane) refreshLog();
    }
    console.log   = function() { capture('log',  arguments); origLog.apply(console,  arguments); };
    console.warn  = function() { capture('warn', arguments); origWarn.apply(console, arguments); };
    console.error = function() { capture('err',  arguments); origErr.apply(console,  arguments); };
    window.addEventListener('error', (e) => capture('err', [e.message, 'at', e.filename + ':' + e.lineno]));
    window.addEventListener('unhandledrejection', (e) => capture('err', ['unhandledrejection:', e.reason]));

    // dbg() — internal logger for debug-panel's own operations.
    // Writes to both the log buffer (so it shows in the Log tab) and
    // to the real console (so PC DevTools also sees it). Level 'dbg'
    // renders in cyan so panel-internal traces visually stand out
    // from the app's own log messages.
    function dbg(...args) {
        const msg = stringify(args);
        logBuffer.push({ t: Date.now(), level: 'dbg', msg });
        if (logBuffer.length > MAX_LOG) logBuffer.shift();
        origLog('[DBG]', ...args);
        if (panelBody && logPane) refreshLog();
    }

    // Install-event tracing: piggyback on whatever index.html does.
    // We listen in *capture* phase so we see the event BEFORE index.html's
    // own handler calls preventDefault. This lets us log whether Chrome
    // even fires the event — the #1 silent failure mode for "can't install".
    window.addEventListener('beforeinstallprompt', (e) => {
        dbg('beforeinstallprompt fired:', 'platforms=' + (e.platforms||[]).join(',') || '(none)');
    }, true);
    window.addEventListener('appinstalled', () => {
        dbg('appinstalled event fired — browser thinks install succeeded');
    });

    // Log startup environment immediately so the Log tab has context
    // from the moment the panel opens.
    dbg('debug-panel.js loaded');
    dbg('viewport:', window.innerWidth + 'x' + window.innerHeight, 'dpr=' + window.devicePixelRatio);
    dbg('screen:',   screen.width + 'x' + screen.height, 'color=' + screen.colorDepth + 'bit');
    dbg('ua:', navigator.userAgent);
    dbg('url:', location.href);
    dbg('referrer:', document.referrer || '(none)');
    dbg('online:', navigator.onLine, '| cookies:', navigator.cookieEnabled, '| storage:', typeof localStorage !== 'undefined');

    // ---------- Styles (inline to avoid touching style.css) ----------
    const CSS = `
    #dbg-toggle {
        position: fixed; bottom: 10px; right: 10px; z-index: 99999;
        width: 44px; height: 44px; border-radius: 22px;
        background: #2d5a3d; color: #fff; border: 2px solid #fff;
        font-size: 12px; font-weight: 700; letter-spacing: 1px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3); cursor: pointer;
    }
    #dbg-panel {
        position: fixed; left: 0; right: 0; bottom: 0; z-index: 99998;
        max-height: 70vh; background: #1a1a1a; color: #e0e0e0;
        font-family: ui-monospace, 'JetBrains Mono', Menlo, monospace;
        font-size: 11px; line-height: 1.4;
        border-top: 2px solid #2d5a3d;
        box-shadow: 0 -4px 20px rgba(0,0,0,0.5);
        display: flex; flex-direction: column;
        transform: translateY(100%); transition: transform 0.2s ease;
    }
    #dbg-panel.open { transform: translateY(0); }
    #dbg-head {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 12px; background: #2d5a3d; color: #fff;
        font-weight: 600; font-size: 12px;
    }
    #dbg-head button {
        background: rgba(255,255,255,0.15); color: #fff;
        border: 1px solid rgba(255,255,255,0.3); border-radius: 4px;
        padding: 3px 8px; font-size: 11px; cursor: pointer;
    }
    #dbg-tabs {
        display: flex; gap: 2px; background: #111; padding: 4px 4px 0;
        border-bottom: 1px solid #333;
    }
    #dbg-tabs button {
        flex: 1; padding: 6px 4px; background: #222; color: #aaa;
        border: none; border-radius: 4px 4px 0 0; font-size: 11px;
        cursor: pointer; font-family: inherit;
    }
    #dbg-tabs button.active { background: #1a1a1a; color: #fff; }
    #dbg-body {
        flex: 1 1 auto; overflow-y: auto; padding: 10px 12px;
        -webkit-overflow-scrolling: touch;
    }
    #dbg-body h4 {
        margin: 10px 0 4px; color: #8fe; font-size: 11px; font-weight: 600;
        text-transform: uppercase; letter-spacing: 0.5px;
    }
    #dbg-body h4:first-child { margin-top: 0; }
    #dbg-body pre {
        white-space: pre-wrap; word-break: break-word; margin: 0;
        color: #cfc; font-size: 10px; line-height: 1.35;
    }
    #dbg-body .row { display: flex; justify-content: space-between; gap: 8px; }
    #dbg-body .k { color: #aaa; }
    #dbg-body .v { color: #fff; font-weight: 500; }
    #dbg-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    #dbg-actions button {
        padding: 8px; background: #333; color: #fff; border: 1px solid #555;
        border-radius: 4px; font-size: 11px; font-family: inherit;
        cursor: pointer;
    }
    #dbg-actions button:active { background: #2d5a3d; }
    #dbg-log-pane .entry {
        border-bottom: 1px solid #222; padding: 2px 0;
        font-size: 10px; word-break: break-word;
    }
    #dbg-log-pane .entry.warn { color: #fc8; }
    #dbg-log-pane .entry.err  { color: #f88; }
    #dbg-log-pane .entry.dbg  { color: #8cf; }
    #dbg-log-pane .ts { color: #666; margin-right: 6px; }
    .dbg-highlight-overlap {
        outline: 2px dashed #f44 !important;
        outline-offset: -2px;
    }`;

    // ---------- Build DOM ----------
    function build() {
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);

        const toggle = document.createElement('button');
        toggle.id = 'dbg-toggle';
        toggle.textContent = 'DBG';
        toggle.addEventListener('click', () => setOpen(!isOpen));
        document.body.appendChild(toggle);

        panelRoot = document.createElement('div');
        panelRoot.id = 'dbg-panel';
        panelRoot.innerHTML = `
            <div id="dbg-head">
                <span>DEBUG PANEL</span>
                <button id="dbg-refresh">Refresh</button>
                <button id="dbg-copy">Copy</button>
                <button id="dbg-close" style="margin-left:auto">Close</button>
            </div>
            <div id="dbg-tabs">
                <button data-tab="env" class="active">Env</button>
                <button data-tab="layout">Layout</button>
                <button data-tab="pwa">PWA</button>
                <button data-tab="icons">Icons</button>
                <button data-tab="actions">Actions</button>
                <button data-tab="log">Log</button>
            </div>
            <div id="dbg-body"></div>
        `;
        document.body.appendChild(panelRoot);
        panelBody = panelRoot.querySelector('#dbg-body');
        panelRoot.querySelector('#dbg-close').addEventListener('click',   () => setOpen(false));
        panelRoot.querySelector('#dbg-refresh').addEventListener('click', renderActiveTab);
        panelRoot.querySelector('#dbg-copy').addEventListener('click',    copyDump);
        panelRoot.querySelectorAll('#dbg-tabs button').forEach(btn => {
            btn.addEventListener('click', () => {
                panelRoot.querySelectorAll('#dbg-tabs button').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentTab = btn.dataset.tab;
                renderActiveTab();
            });
        });
    }

    function setOpen(v) {
        isOpen = v;
        panelRoot.classList.toggle('open', v);
        if (v) renderActiveTab();
    }

    // ---------- Tab renderers ----------
    let currentTab = 'env';

    function renderActiveTab() {
        if (!panelBody) return;
        switch (currentTab) {
            case 'env':     renderEnv();     break;
            case 'layout':  renderLayout();  break;
            case 'pwa':     renderPwa();     break;
            case 'icons':   renderIcons();   break;
            case 'actions': renderActions(); break;
            case 'log':     renderLogTab();  break;
        }
    }

    function kv(k, v) {
        return `<div class="row"><span class="k">${k}</span><span class="v">${escape(String(v))}</span></div>`;
    }
    function escape(s) {
        return s.replace(/[&<>]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c]));
    }

    function renderEnv() {
        const mq = [
            '(max-width: 420px)',
            '(max-width: 480px)',
            '(max-width: 640px)',
            '(max-width: 768px)',
            '(min-width: 769px)',
            '(pointer: coarse)',
            '(pointer: fine)',
            '(hover: hover)',
            '(hover: none)',
            '(display-mode: standalone)',
            '(display-mode: browser)',
            '(prefers-color-scheme: dark)'
        ];
        const mqRows = mq.map(q =>
            kv(q, window.matchMedia(q).matches ? '✓ MATCH' : '·')
        ).join('');

        // Safe-area insets (Android gesture-nav bars, iOS notches)
        const safeArea = (function() {
            const probe = document.createElement('div');
            probe.style.cssText = 'position:fixed;top:0;left:0;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);visibility:hidden;';
            document.body.appendChild(probe);
            const s = getComputedStyle(probe);
            const r = { top: s.paddingTop, right: s.paddingRight, bottom: s.paddingBottom, left: s.paddingLeft };
            document.body.removeChild(probe);
            return `T=${r.top} R=${r.right} B=${r.bottom} L=${r.left}`;
        })();

        panelBody.innerHTML = `
            <h4>Screen & viewport (key numbers)</h4>
            <pre style="color:#8fe;font-size:12px;font-weight:600;line-height:1.6">
CSS viewport     ${window.innerWidth} × ${window.innerHeight} px
Device pixels    ${screen.width} × ${screen.height} px
Device ratio     ${window.devicePixelRatio}  (1 CSS px = ${window.devicePixelRatio} device px)
Orientation      ${screen.orientation?.type || '(unknown)'}
Color depth      ${screen.colorDepth}-bit
Safe-area inset  ${safeArea}</pre>

            <h4>Media queries (which @media rules are firing)</h4>
            ${mqRows}

            <h4>User agent</h4>
            <pre>${escape(navigator.userAgent)}</pre>

            <h4>URL / Profile</h4>
            ${kv('URL', location.href)}
            ${kv('Profile ID', (window.APP_CONFIG && window.APP_CONFIG.PROFILE_ID) || 'unknown')}
            ${kv('Version', (window.APP_CONFIG && window.APP_CONFIG.VERSION) || 'unknown')}
        `;
    }

    function renderLayout() {
        // Elements we care about — extend the list as needed
        const spec = [
            { id: 'mw-single-input',  label: 'Search input' },
            { id: 'mw-add-single',    label: '+ Add button' },
            { id: 'mw-import-btn',    label: 'Import btn' },
            { id: 'mw-batch-enrich',  label: 'AI enrich btn' },
            { id: 'mw-batch-paste',   label: 'Paste btn' },
            { id: 'mw-dm-cards',      label: 'Card mode' },
            { id: 'mw-dm-list',       label: 'List mode' },
            { id: 'mw-dm-quiz',       label: 'Quiz mode' },
            { id: 'mw-toggle-cn',     label: '中 CN' },
            { id: 'mw-prev',          label: '◀ Prev' },
            { id: 'mw-counter',       label: 'Counter' },
            { id: 'mw-next',          label: 'Next ▶' },
            { id: 'mw-autoplay',      label: '▶️ Play' },
            { id: 'mw-shuffle',       label: '🔀 Shuffle' }
        ];

        const rows = spec.map(s => {
            const el = document.getElementById(s.id);
            if (!el) return kv(s.label, '(missing)');
            const r  = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return kv(
                s.label,
                `L=${r.left.toFixed(0)} T=${r.top.toFixed(0)} ` +
                `W=${r.width.toFixed(0)} H=${r.height.toFixed(0)} ` +
                `pad=${cs.padding} mar=${cs.margin}`
            );
        }).join('');

        // Overlap detector — compares right edge of each element to
        // left edge of the element immediately to its right
        const overlaps = findOverlaps(spec);
        const overlapBlock = overlaps.length === 0
            ? '<pre>No overlaps detected.</pre>'
            : '<pre>' + overlaps.map(o =>
                `${o.a} right=${o.aRight.toFixed(1)} overlaps ${o.b} left=${o.bLeft.toFixed(1)} (by ${(o.aRight - o.bLeft).toFixed(1)}px)`
              ).join('\n') + '</pre>';

        panelBody.innerHTML = `
            <h4>Element geometry</h4>
            ${rows}

            <h4>Overlaps</h4>
            ${overlapBlock}

            <h4>Actions</h4>
            <div id="dbg-actions">
                <button id="dbg-highlight-overlap">Highlight overlaps</button>
                <button id="dbg-clear-highlight">Clear highlights</button>
            </div>
        `;
        panelBody.querySelector('#dbg-highlight-overlap').addEventListener('click', () => {
            clearHighlights();
            overlaps.forEach(o => {
                const a = document.getElementById(o.aId);
                const b = document.getElementById(o.bId);
                if (a) a.classList.add('dbg-highlight-overlap');
                if (b) b.classList.add('dbg-highlight-overlap');
            });
        });
        panelBody.querySelector('#dbg-clear-highlight').addEventListener('click', clearHighlights);
    }

    function clearHighlights() {
        document.querySelectorAll('.dbg-highlight-overlap')
            .forEach(e => e.classList.remove('dbg-highlight-overlap'));
    }

    function findOverlaps(spec) {
        // Get rects for every element, group by vertical band, then
        // sort by left and check adjacent pairs for right > left.
        const items = spec.map(s => {
            const el = document.getElementById(s.id);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return null;
            return { id: s.id, label: s.label, rect: r };
        }).filter(Boolean);

        const rows = {};
        items.forEach(i => {
            // Bucket by mid-Y rounded to 10px to group items on the same row
            const band = Math.round(i.rect.top / 10) * 10;
            (rows[band] = rows[band] || []).push(i);
        });

        const results = [];
        Object.values(rows).forEach(row => {
            row.sort((a, b) => a.rect.left - b.rect.left);
            for (let i = 0; i < row.length - 1; i++) {
                const a = row[i], b = row[i + 1];
                if (a.rect.right > b.rect.left + 0.5) {  // >0.5 to ignore sub-pixel noise
                    results.push({
                        a: a.label, aId: a.id, aRight: a.rect.right,
                        b: b.label, bId: b.id, bLeft:  b.rect.left
                    });
                }
            }
        });
        return results;
    }

    async function renderPwa() {
        dbg('renderPwa: start');
        const rows = [];
        const standalone = window.matchMedia('(display-mode: standalone)').matches;
        const iosStandalone = !!navigator.standalone;
        const promptStashed = !!window.deferredInstallPrompt;
        const isHttps = location.protocol === 'https:';
        const swSupported = 'serviceWorker' in navigator;
        dbg('  standalone:', standalone, '| iOS standalone:', iosStandalone);
        dbg('  install prompt stashed:', promptStashed);
        dbg('  HTTPS:', isHttps, '| SW supported:', swSupported);

        rows.push(kv('display-mode standalone', standalone));
        rows.push(kv('navigator.standalone',    iosStandalone));
        rows.push(kv('install prompt stashed',  promptStashed));
        rows.push(kv('HTTPS',                   isHttps));
        rows.push(kv('serviceWorker supported', swSupported));

        let swInfo = '(no service workers)';
        if (swSupported) {
            try {
                dbg('  fetching SW registrations...');
                const regs = await navigator.serviceWorker.getRegistrations();
                dbg('  found', regs.length, 'registration(s)');
                if (regs.length === 0) {
                    swInfo = '(none registered)';
                } else {
                    swInfo = regs.map((r, i) => {
                        const s = r.active     ? 'active'
                                : r.waiting    ? 'waiting'
                                : r.installing ? 'installing' : 'unknown';
                        const u = r.active?.scriptURL || r.waiting?.scriptURL || r.installing?.scriptURL || '';
                        dbg(`  sw[${i}]: state=${s} scope=${r.scope} script=${u}`);
                        return `  scope=${r.scope}\n  state=${s}\n  script=${u}`;
                    }).join('\n---\n');
                }
            } catch (e) {
                dbg('  SW error:', e.message);
                swInfo = 'error: ' + e.message;
            }
        }

        const manifestLink = document.querySelector('link[rel=manifest]');
        const manifestHref = manifestLink?.href || '(none)';
        let manifestStatus = '(not fetched)';
        try {
            dbg('  fetching manifest for status check...');
            const r = await fetch(manifestHref);
            manifestStatus = r.ok
                ? `ok (${r.status}), ${r.headers.get('content-type') || '?'}`
                : `HTTP ${r.status}`;
            dbg('  manifest status:', manifestStatus);
        } catch (e) {
            manifestStatus = 'fetch failed: ' + e.message;
            dbg('  manifest fetch failed:', e.message);
        }

        let cacheInfo = '(no caches)';
        if ('caches' in window) {
            try {
                const names = await caches.keys();
                cacheInfo = names.length ? names.join(', ') : '(empty)';
                dbg('  cache storage names:', cacheInfo);
            } catch (e) {
                cacheInfo = 'error: ' + e.message;
                dbg('  cache error:', e.message);
            }
        }

        dbg('renderPwa: done');

        panelBody.innerHTML = `
            <h4>PWA state</h4>
            ${rows.join('')}

            <h4>Service workers</h4>
            <pre>${escape(swInfo)}</pre>

            <h4>Manifest</h4>
            ${kv('href', manifestHref)}
            ${kv('status', manifestStatus)}

            <h4>Cache storage</h4>
            <pre>${escape(cacheInfo)}</pre>

            <h4>Install troubleshooting tips</h4>
            <pre>Chrome requires ALL of:
  - HTTPS (or localhost)
  - valid manifest with 192 & 512 icons
  - a registered service worker with a fetch handler
  - display: standalone or fullscreen
  - user has not dismissed install prompt recently

If "install prompt stashed" above is false, Chrome has not offered
this page. Check the Log tab for the beforeinstallprompt event.</pre>
        `;
    }

    // ---------- Icons tab: diagnose "installed but no icon" ----------
    async function renderIcons() {
        dbg('renderIcons: start');
        panelBody.innerHTML = '<h4>Icons diagnostic</h4><pre>Loading… (see Log tab for step-by-step trace)</pre>';

        const manifestLink = document.querySelector('link[rel=manifest]');
        const manifestHref = manifestLink?.href || '';
        dbg('manifest link element:', manifestLink ? 'found' : 'MISSING');
        dbg('manifest href:', manifestHref);

        const lines = [];
        lines.push('<h4>Manifest</h4>');
        lines.push(kv('link href', manifestHref || '(none)'));

        let manifest     = null;
        let manifestText = '';
        try {
            dbg('fetching manifest...');
            const t0 = performance.now();
            const r  = await fetch(manifestHref);
            manifestText = await r.text();
            const dt = (performance.now() - t0).toFixed(0);
            dbg(`manifest HTTP ${r.status} ${r.headers.get('content-type') || '?'} ${manifestText.length}B (${dt}ms)`);

            lines.push(kv('fetch status', `${r.status} ${r.ok ? 'OK' : 'FAIL'}`));
            lines.push(kv('content-type', r.headers.get('content-type') || '(none)'));
            lines.push(kv('size', manifestText.length + ' bytes'));
            try {
                manifest = JSON.parse(manifestText);
                dbg('manifest parsed OK, keys:', Object.keys(manifest).join(', '));
                lines.push(kv('parse', 'OK'));
                lines.push(kv('id field', manifest.id || '(not set)'));
                lines.push(kv('scope',    manifest.scope || '(not set)'));
                lines.push(kv('start_url', manifest.start_url || '(not set)'));
                lines.push(kv('display',  manifest.display  || '(not set)'));
            } catch (e) {
                dbg('manifest parse FAILED:', e.message);
                lines.push(kv('parse', 'FAILED: ' + e.message));
            }
        } catch (e) {
            dbg('manifest fetch FAILED:', e.message);
            lines.push(kv('fetch', 'FAILED: ' + e.message));
        }

        if (!manifest || !Array.isArray(manifest.icons)) {
            dbg('cannot continue — no manifest or icons array');
            panelBody.innerHTML = lines.join('') + '<pre>Cannot probe icons without a parsed manifest. Check Log tab.</pre>';
            return;
        }

        lines.push('<h4>Icons (' + manifest.icons.length + ' declared)</h4>');
        dbg('probing', manifest.icons.length, 'icons...');

        const manifestURL = new URL(manifestHref);
        for (const icon of manifest.icons) {
            const resolved = new URL(icon.src, manifestURL).href;
            const info     = await probeIcon(resolved, icon);
            lines.push(`
                <div style="border:1px solid #333;border-radius:4px;padding:6px;margin:4px 0">
                    ${kv('src',      icon.src)}
                    ${kv('resolves to', resolved)}
                    ${kv('declared', `${icon.sizes} ${icon.type} purpose=${icon.purpose||'any'}`)}
                    ${kv('HTTP',     info.status + ' ' + (info.ok ? 'OK' : 'FAIL'))}
                    ${kv('mime',     info.contentType)}
                    ${kv('bytes',    info.bytes)}
                    ${kv('real dim', info.realDim)}
                    ${kv('verdict',  '<span style="color:' + (info.verdict.ok ? '#8f8' : '#f88') + '">' + info.verdict.msg + '</span>')}
                </div>
            `);
        }
        dbg('renderIcons: done');

        lines.push(`<h4>Why "installed but no icon" happens</h4>
            <pre>Chrome/Android checks ALL of these before placing an icon:
1. At least one icon must be fetchable and parseable as an image.
2. Declared "sizes" must match the actual image dimensions.
3. The image must have purpose "any" (or "any maskable") for the
   launcher icon — purpose "maskable" alone does NOT qualify for
   the adaptive-icon slot on Android 8+.
4. content-type must be image/png (not text/html, image/jpeg in a
   .png filename, etc.).
5. Android launcher must accept home-screen shortcut requests.
   Xiaomi/MIUI, Huawei, Samsung launchers sometimes require a
   separate toggle in Settings → Home screen → "Add icons to
   home screen automatically".

If all icon verdicts above are OK, check launcher settings.
Also check the app drawer — some launchers install there only.</pre>
        `);

        panelBody.innerHTML = lines.join('');
    }

    async function probeIcon(url, declared) {
        dbg('probeIcon: start', url);
        const info = { status: '?', ok: false, contentType: '?', bytes: '?', realDim: '?', verdict: { ok: false, msg: '?' } };
        try {
            dbg('  fetch', url);
            const t0 = performance.now();
            const r  = await fetch(url);
            const dt = (performance.now() - t0).toFixed(0);
            info.status      = r.status;
            info.ok          = r.ok;
            info.contentType = r.headers.get('content-type') || '(none)';
            dbg(`  <- HTTP ${r.status} ${info.contentType} (${dt}ms)`);

            const buf = await r.arrayBuffer();
            info.bytes = buf.byteLength + ' B';
            dbg('  body:', info.bytes);

            // Sanity check: PNG magic bytes (89 50 4E 47)
            const view = new Uint8Array(buf.slice(0, 4));
            const magic = Array.from(view).map(b => b.toString(16).padStart(2, '0')).join(' ');
            const isPNG = view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4E && view[3] === 0x47;
            dbg('  magic bytes:', magic, isPNG ? '(PNG ✓)' : '(NOT PNG!)');

            // Load as Image to get real pixel dimensions
            const blob   = new Blob([buf], { type: info.contentType });
            const objURL = URL.createObjectURL(blob);
            try {
                dbg('  decoding image...');
                const dim = await new Promise((resolve, reject) => {
                    const img = new Image();
                    img.onload  = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
                    img.onerror = () => reject(new Error('image decode failed'));
                    img.src = objURL;
                });
                info.realDim = `${dim.w}×${dim.h}`;
                dbg('  decoded:', info.realDim);

                // Verdict
                const [dw, dh] = (declared.sizes || '0x0').toLowerCase().split('x').map(Number);
                const problems = [];
                if (!info.ok) problems.push('HTTP ' + info.status);
                if (!info.contentType.startsWith('image/')) problems.push('wrong mime: ' + info.contentType);
                if (!isPNG) problems.push('not a PNG (magic=' + magic + ')');
                if (dw !== dim.w || dh !== dim.h) problems.push(`size mismatch: declared ${declared.sizes}, real ${dim.w}x${dim.h}`);
                info.verdict = problems.length
                    ? { ok: false, msg: 'PROBLEM — ' + problems.join('; ') }
                    : { ok: true,  msg: 'OK' };
                dbg('  verdict:', info.verdict.msg);
            } finally {
                URL.revokeObjectURL(objURL);
            }
        } catch (e) {
            info.verdict = { ok: false, msg: 'PROBE FAILED: ' + e.message };
            dbg('  ERROR:', e.message);
        }
        return info;
    }

    function renderActions() {
        panelBody.innerHTML = `
            <h4>Quick actions</h4>
            <div id="dbg-actions">
                <button id="dbg-run-all" style="grid-column:1/-1;background:#2d5a3d;color:#fff;font-weight:600;padding:12px">▶ Run full diagnostic (writes to Log)</button>
                <button id="dbg-install">Trigger install</button>
                <button id="dbg-sw-unreg">Unregister SW</button>
                <button id="dbg-cache-clear">Clear caches</button>
                <button id="dbg-reload">Hard reload</button>
                <button id="dbg-clear-data" style="grid-column:1/-1;background:#633">Clear ALL emp_ data</button>
                <button id="dbg-export" style="grid-column:1/-1">Export profile data (JSON)</button>
            </div>
            <h4>Notes</h4>
            <pre>• "Run full diagnostic" runs every probe in sequence and writes
  every step to the Log tab. Takes ~5 seconds. Afterwards tap
  the Copy button in the panel header to capture everything.
• "Trigger install" only works if Chrome has already offered
  a prompt (see PWA tab).
• "Unregister SW" + "Clear caches" + hard reload = guaranteed
  fresh code on next load.
• "Clear ALL emp_ data" wipes your vocabulary — export first.</pre>
        `;

        panelBody.querySelector('#dbg-run-all').addEventListener('click', runFullDiagnostic);

        panelBody.querySelector('#dbg-install').addEventListener('click', async () => {
            dbg('install button clicked');
            if (!window.deferredInstallPrompt) {
                dbg('  no deferred prompt available');
                alert('No install prompt available. See PWA tab for why.');
                return;
            }
            dbg('  calling prompt()...');
            window.deferredInstallPrompt.prompt();
            const res = await window.deferredInstallPrompt.userChoice;
            dbg('  install result:', res.outcome);
            alert('Install result: ' + res.outcome);
        });

        panelBody.querySelector('#dbg-sw-unreg').addEventListener('click', async () => {
            dbg('unregister SW clicked');
            const regs = await navigator.serviceWorker.getRegistrations();
            for (const r of regs) {
                dbg('  unregistering', r.scope);
                await r.unregister();
            }
            alert(`Unregistered ${regs.length} service worker(s).`);
        });

        panelBody.querySelector('#dbg-cache-clear').addEventListener('click', async () => {
            dbg('clear caches clicked');
            const names = await caches.keys();
            for (const n of names) {
                dbg('  deleting cache:', n);
                await caches.delete(n);
            }
            alert(`Cleared ${names.length} cache(s).`);
        });

        panelBody.querySelector('#dbg-reload').addEventListener('click', () => {
            dbg('hard reload clicked');
            location.reload();
        });

        panelBody.querySelector('#dbg-clear-data').addEventListener('click', () => {
            if (!confirm('Wipe ALL emp_ localStorage keys? Export first if unsure.')) return;
            const toKill = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('emp_')) toKill.push(k);
            }
            toKill.forEach(k => localStorage.removeItem(k));
            dbg('wiped', toKill.length, 'emp_ keys');
            alert(`Removed ${toKill.length} keys.`);
        });

        panelBody.querySelector('#dbg-export').addEventListener('click', () => {
            const data = {};
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('emp_')) data[k] = localStorage.getItem(k);
            }
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `emp-debug-export-${Date.now()}.json`;
            a.click();
            dbg('exported', Object.keys(data).length, 'keys');
        });
    }

    // Runs every probe in sequence. Each step writes to the Log tab
    // so you get a complete trace without needing to tap through tabs.
    async function runFullDiagnostic() {
        dbg('======== FULL DIAGNOSTIC START ========');
        dbg('time:', new Date().toISOString());

        // 1. Environment
        dbg('---- [1/5] ENVIRONMENT ----');
        dbg('viewport:', innerWidth + 'x' + innerHeight, 'dpr=' + devicePixelRatio);
        dbg('screen:',   screen.width + 'x' + screen.height);
        dbg('orient:',   screen.orientation?.type || '?');

        // 2. Media queries
        dbg('---- [2/5] MEDIA QUERIES ----');
        ['(max-width:420px)','(max-width:480px)','(max-width:640px)','(max-width:768px)',
         '(min-width:769px)','(pointer:coarse)','(pointer:fine)','(hover:hover)','(hover:none)',
         '(display-mode:standalone)','(display-mode:browser)','(prefers-color-scheme:dark)'
        ].forEach(q => dbg(q, '→', matchMedia(q).matches ? 'MATCH' : 'no'));

        // 3. Layout
        dbg('---- [3/5] LAYOUT ----');
        const ids = ['mw-single-input','mw-add-single','mw-import-btn','mw-batch-enrich','mw-batch-paste',
                     'mw-dm-cards','mw-dm-list','mw-dm-quiz','mw-toggle-cn',
                     'mw-prev','mw-counter','mw-next','mw-autoplay','mw-shuffle'];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (!el) { dbg(id, ': MISSING'); return; }
            const r  = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            dbg(`${id}: L=${r.left.toFixed(1)} R=${r.right.toFixed(1)} W=${r.width.toFixed(1)} H=${r.height.toFixed(1)} pad=${cs.padding} mar=${cs.margin}`);
        });
        const spec = ids.map(id => ({ id, label: id }));
        const overlaps = findOverlaps(spec);
        if (overlaps.length === 0) {
            dbg('overlaps: none detected');
        } else {
            overlaps.forEach(o => dbg(`OVERLAP: ${o.a}.right=${o.aRight.toFixed(1)} > ${o.b}.left=${o.bLeft.toFixed(1)} (by ${(o.aRight-o.bLeft).toFixed(1)}px)`));
        }

        // 4. PWA state
        dbg('---- [4/5] PWA STATE ----');
        dbg('standalone:',             matchMedia('(display-mode:standalone)').matches);
        dbg('installPrompt stashed:',  !!window.deferredInstallPrompt);
        dbg('HTTPS:',                  location.protocol === 'https:');
        try {
            const regs = await navigator.serviceWorker.getRegistrations();
            dbg('SW registrations:', regs.length);
            regs.forEach((r,i) => dbg(`  sw[${i}]: scope=${r.scope} script=${r.active?.scriptURL || '(no active)'}`));
        } catch (e) { dbg('SW error:', e.message); }
        try {
            const names = await caches.keys();
            dbg('cache storage:', names.join(', ') || '(empty)');
        } catch (e) { dbg('cache error:', e.message); }

        // 5. Icons probe
        dbg('---- [5/5] MANIFEST + ICONS ----');
        const manifestLink = document.querySelector('link[rel=manifest]');
        const manifestHref = manifestLink?.href || '';
        dbg('manifest link:', manifestHref || 'MISSING');
        if (manifestHref) {
            try {
                const r   = await fetch(manifestHref);
                const txt = await r.text();
                dbg(`manifest: ${r.status} ${r.headers.get('content-type') || '?'} ${txt.length}B`);
                const mf = JSON.parse(txt);
                dbg('manifest id:',        mf.id        || '(none)');
                dbg('manifest scope:',     mf.scope);
                dbg('manifest start_url:', mf.start_url);
                dbg('manifest display:',   mf.display);
                dbg('manifest icons:',     (mf.icons || []).length);
                const manifestURL = new URL(manifestHref);
                for (const icon of (mf.icons || [])) {
                    const resolved = new URL(icon.src, manifestURL).href;
                    await probeIcon(resolved, icon);
                }
            } catch (e) { dbg('manifest probe error:', e.message); }
        }

        dbg('======== FULL DIAGNOSTIC END ========');
        dbg('Switch to Log tab, then tap Copy in the panel header.');
        alert('Diagnostic complete. Switch to Log tab to view the trace, then tap Copy in the panel header to capture it.');
    }

    function renderLogTab() {
        panelBody.innerHTML = `
            <h4>Console log (${logBuffer.length} entries, newest last)</h4>
            <div id="dbg-log-pane"></div>
        `;
        logPane = panelBody.querySelector('#dbg-log-pane');
        refreshLog();
    }

    function refreshLog() {
        if (!logPane) return;
        logPane.innerHTML = logBuffer.slice(-MAX_LOG).map(e => {
            const t = new Date(e.t).toLocaleTimeString();
            return `<div class="entry ${e.level}"><span class="ts">${t}</span>${escape(e.msg)}</div>`;
        }).join('');
        logPane.scrollTop = logPane.scrollHeight;
    }

    async function copyDump() {
        // Collect everything into a single string for pasting to Claude
        const lines = [];
        lines.push('=== EMP Debug Dump ===');
        lines.push('time: ' + new Date().toISOString());
        lines.push('url:  ' + location.href);
        lines.push('ua:   ' + navigator.userAgent);
        lines.push('viewport: ' + innerWidth + 'x' + innerHeight + ' dpr=' + devicePixelRatio);
        lines.push('');

        // Media queries
        lines.push('--- Media queries ---');
        ['(max-width:420px)','(max-width:480px)','(max-width:640px)','(max-width:768px)',
         '(min-width:769px)','(pointer:coarse)','(pointer:fine)','(display-mode:standalone)'
        ].forEach(q => lines.push(q + ': ' + (matchMedia(q).matches ? 'MATCH' : 'no')));
        lines.push('');

        // Geometry
        lines.push('--- Geometry ---');
        ['mw-single-input','mw-add-single','mw-import-btn','mw-batch-enrich','mw-batch-paste',
         'mw-dm-cards','mw-dm-list','mw-dm-quiz','mw-toggle-cn',
         'mw-prev','mw-counter','mw-next','mw-autoplay','mw-shuffle'
        ].forEach(id => {
            const el = document.getElementById(id);
            if (!el) { lines.push(id + ': MISSING'); return; }
            const r = el.getBoundingClientRect();
            lines.push(id + `: L=${r.left.toFixed(0)} R=${r.right.toFixed(0)} W=${r.width.toFixed(0)} H=${r.height.toFixed(0)}`);
        });
        lines.push('');

        // PWA
        lines.push('--- PWA ---');
        lines.push('standalone:     ' + matchMedia('(display-mode:standalone)').matches);
        lines.push('installPrompt:  ' + !!window.deferredInstallPrompt);
        try {
            const regs = await navigator.serviceWorker.getRegistrations();
            regs.forEach((r,i) => lines.push(`sw[${i}]: scope=${r.scope} state=${r.active?'active':'other'} script=${r.active?.scriptURL}`));
            if (regs.length === 0) lines.push('sw: none');
        } catch (e) { lines.push('sw: error ' + e.message); }
        try {
            const names = await caches.keys();
            lines.push('caches: ' + (names.join(', ') || '(none)'));
        } catch (e) { lines.push('caches: error ' + e.message); }
        lines.push('');

        // Manifest + icons
        lines.push('--- Manifest + icons ---');
        const manifestLink = document.querySelector('link[rel=manifest]');
        const manifestHref = manifestLink?.href || '(none)';
        lines.push('manifest: ' + manifestHref);
        try {
            const r = await fetch(manifestHref);
            lines.push(`manifest fetch: ${r.status} ${r.headers.get('content-type') || '?'}`);
            const txt = await r.text();
            const mf  = JSON.parse(txt);
            lines.push('id:        ' + (mf.id || '(none)'));
            lines.push('scope:     ' + (mf.scope || '(none)'));
            lines.push('start_url: ' + (mf.start_url || '(none)'));
            lines.push('display:   ' + (mf.display || '(none)'));
            const manifestURL = new URL(manifestHref);
            for (const icon of (mf.icons || [])) {
                const resolved = new URL(icon.src, manifestURL).href;
                const info = await probeIcon(resolved, icon);
                lines.push(`icon ${icon.src} → ${info.status} ${info.contentType} ${info.bytes} real=${info.realDim} verdict=${info.verdict.msg}`);
            }
        } catch (e) { lines.push('manifest probe error: ' + e.message); }
        lines.push('');

        // Recent log
        lines.push('--- Recent log (' + logBuffer.length + ') ---');
        logBuffer.slice(-50).forEach(e => lines.push(`[${e.level}] ${e.msg}`));

        const text = lines.join('\n');
        try {
            await navigator.clipboard.writeText(text);
            alert('Debug dump copied to clipboard (' + text.length + ' chars). Paste it to Claude.');
        } catch {
            // Fallback: show it in a prompt the user can copy from
            prompt('Copy this dump:', text.slice(0, 2000));
        }
    }

    // ---------- Init ----------
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', build);
    } else {
        build();
    }

    // Public handle so you can call from console
    window.Debug = {
        open:  () => setOpen(true),
        close: () => setOpen(false),
        dump:  copyDump,
        log:   logBuffer
    };
})();
