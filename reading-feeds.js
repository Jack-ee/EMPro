// ============================================================
// reading-feeds.js — Daily Reading (on-demand feed reader)
// ============================================================
// Live article sources for the Reader tab. The list of articles is
// fetched fresh each time (a few KB); nothing is stored until the
// user taps an article, at which point its text — and audio, when the
// feed provides an MP3 — is downloaded once into IndexedDB and stays
// available offline. Download-on-demand, by design.
//
// Sources (editable in the panel, one per line, "Name | target"):
//   Guardian : target is  guardian:<extra query params>, e.g.
//              guardian:section=world  or  guardian:q=climate change
//              (needs GUARDIAN_API_KEY set on the Cloudflare Worker)
//   RSS      : target is a feed URL on a Worker-whitelisted host
//              (VOA main site or learningenglish.voanews.com)
//
// Everything goes through the same Cloudflare Worker as neural TTS
// and the audio pack ('tts_proxy_url' preference): ?guardian= for the
// Guardian API (key stays in the Worker), ?fetch= for RSS feeds and
// article pages, ?media= for MP3 audio with Range passthrough.
//
// Storage: its own IndexedDB database EMP_READING_DB — never the
// tts-pack or app databases — with one 'articles' store. A soft cap
// (READING_CACHE_MB, default 200) evicts least-recently-opened
// articles after each save.
// ============================================================

window.ReadingFeeds = (function() {
    'use strict';

    const DB_NAME          = 'emp-reading';
    const DB_VERSION       = 1;
    const STORE            = 'articles';
    const SOURCES_PREF     = 'reading_sources';
    const AUDIO_ONLY_PREF  = 'reading_audio_only';
    const CACHE_MB_PREF    = 'reading_cache_mb';
    const DEFAULT_CACHE_MB = 200;

    // Default sources, all native speed. NPR and BBC podcasts update
    // daily/hourly and carry a per-episode MP3 enclosure, so the audio
    // badge shows right in the list. VOA has been frozen since
    // 2025-03-15 (the USAGM shutdown) and is kept as a public-domain
    // archive; its pages may embed audio the RSS never lists, which
    // the downloader hunts for on tap. Guardian is text-only.
    const DEFAULT_SOURCES =
        'NPR \u00b7 News Now (5 min, hourly) | https://feeds.npr.org/500005/podcast.xml\n' +
        'NPR \u00b7 Up First | https://feeds.npr.org/510318/podcast.xml\n' +
        'BBC \u00b7 Global News Podcast | https://podcasts.files.bbci.co.uk/p02nq0gn.rss\n' +
        'Guardian \u00b7 World | guardian:section=world\n' +
        'Guardian \u00b7 Science | guardian:section=science\n' +
        'VOA Archive \u00b7 Worldwide in Five | https://www.voanews.com/api/zvgbqvl-vomx-tpeumoov\n' +
        'VOA Archive \u00b7 Science & Health | https://www.voanews.com/api/ztbopl-vomx-tpekvmm';

    let currentList    = [];      // items of the currently shown source
    let openArticleId  = null;    // guarded from eviction while open
    let audioUrl       = null;    // object URL of the open article's audio

    // --- Small helpers ----------------------------------------------

    function base() {
        const url = (window.DB?.getPref?.('tts_proxy_url', '') || '').trim();
        return url ? url.replace(/\/+$/, '') : '';
    }

    function esc(s) {
        const d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    function stripTags(html) {
        const d = document.createElement('div');
        d.innerHTML = html || '';
        return (d.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function fmtDate(iso) {
        const d = new Date(iso);
        return isNaN(d) ? '' : d.toISOString().slice(0, 10);
    }

    function fmtSize(bytes) {
        if (!bytes) return '0 KB';
        return bytes < 1048576
            ? Math.round(bytes / 1024) + ' KB'
            : (bytes / 1048576).toFixed(1) + ' MB';
    }

    function toast(msg) { window.App?.showToast?.(msg); }

    // --- Sources (pure parsing, exposed for tests) -------------------

    // "Name | guardian:section=world" -> {id,name,type:'guardian',params}
    // "Name | https://host/feed"      -> {id,name,type:'rss',url}
    function parseSources(text) {
        const out = [];
        (text || '').split('\n').forEach(line => {
            line = line.trim();
            if (!line || line.startsWith('#')) return;
            const bar = line.indexOf('|');
            if (bar < 1) return;
            const name   = line.slice(0, bar).trim();
            const target = line.slice(bar + 1).trim();
            if (!name || !target) return;
            const id = 'src-' + out.length + '-' +
                       name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            if (/^guardian:/i.test(target)) {
                out.push({ id, name, type: 'guardian',
                           params: target.replace(/^guardian:/i, '').trim() });
            } else if (/^https:\/\//i.test(target)) {
                out.push({ id, name, type: 'rss', url: target });
            }
        });
        return out;
    }

    function guardianListQuery(params) {
        const fixed = 'order-by=newest&page-size=20' +
                      '&show-fields=trailText,wordcount';
        return 'search?' + fixed + (params ? '&' + params : '');
    }

    // Given [{id,size,lastOpenedAt}] and a byte cap, return the ids to
    // evict (least recently opened first) so the rest fits the cap.
    function pickEvictions(rows, capBytes, protectedId) {
        const sorted = rows.slice().sort(
            (a, b) => (a.lastOpenedAt || 0) - (b.lastOpenedAt || 0));
        let total = rows.reduce((s, r) => s + (r.size || 0), 0);
        const out = [];
        for (const r of sorted) {
            if (total <= capBytes) break;
            if (r.id === protectedId) continue;
            out.push(r.id);
            total -= (r.size || 0);
        }
        return out;
    }

    function loadSources() {
        return parseSources(
            window.DB?.getPref?.(SOURCES_PREF, DEFAULT_SOURCES) || DEFAULT_SOURCES);
    }

    // --- IndexedDB ---------------------------------------------------

    let dbPromise = null;
    function idb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(STORE)) {
                    req.result.createObjectStore(STORE, { keyPath: 'id' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror   = () => reject(req.error);
        });
        return dbPromise;
    }

    async function idbGet(id) {
        const db = await idb();
        return new Promise((resolve, reject) => {
            const rq = db.transaction(STORE).objectStore(STORE).get(id);
            rq.onsuccess = () => resolve(rq.result || null);
            rq.onerror   = () => reject(rq.error);
        });
    }

    async function idbPut(rec) {
        const db = await idb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(rec);
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
        });
    }

    async function idbDelete(id) {
        const db = await idb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror    = () => reject(tx.error);
        });
    }

    // All records without their blobs/text — cheap listing for the
    // Downloaded view and for eviction decisions.
    async function idbListMeta() {
        const db = await idb();
        return new Promise((resolve, reject) => {
            const out = [];
            const cur = db.transaction(STORE).objectStore(STORE).openCursor();
            cur.onsuccess = () => {
                const c = cur.result;
                if (!c) return resolve(out);
                const r = c.value;
                out.push({
                    id: r.id, title: r.title, date: r.date,
                    sourceName: r.sourceName, size: r.size || 0,
                    hasAudio: !!r.audioBlob, savedAt: r.savedAt,
                    lastOpenedAt: r.lastOpenedAt || 0,
                });
                c.continue();
            };
            cur.onerror = () => reject(cur.error);
        });
    }

    async function enforceCacheCap() {
        const capMb = parseInt(
            window.DB?.getPref?.(CACHE_MB_PREF, DEFAULT_CACHE_MB), 10)
            || DEFAULT_CACHE_MB;
        const rows    = await idbListMeta();
        const evictIds = pickEvictions(rows, capMb * 1048576, openArticleId);
        for (const id of evictIds) await idbDelete(id);
        if (evictIds.length) {
            console.log('[feeds] cache cap: evicted', evictIds.length, 'article(s)');
        }
    }

    // --- Fetching lists ----------------------------------------------

    async function fetchList(source) {
        const b = base();
        if (!b) throw new Error('Set the TTS proxy URL in Settings \u2192 Voice first.');
        if (source.type === 'guardian') {
            const q    = guardianListQuery(source.params);
            const resp = await fetch(b + '?guardian=' + encodeURIComponent(q),
                                     { cache: 'no-store' });
            if (!resp.ok) throw new Error(await workerError(resp));
            const data    = await resp.json();
            const results = data?.response?.results || [];
            return results.map(r => ({
                id        : 'gd:' + r.id,
                guardianId: r.id,
                title     : r.webTitle,
                date      : r.webPublicationDate,
                summary   : stripTags(r.fields?.trailText || ''),
                words     : parseInt(r.fields?.wordcount, 10) || 0,
                link      : r.webUrl,
                audio     : null,
            }));
        }
        // RSS
        const resp = await fetch(b + '?fetch=' + encodeURIComponent(source.url),
                                 { cache: 'no-store' });
        if (!resp.ok) throw new Error(await workerError(resp));
        return parseRssItems(await resp.text());
    }

    async function workerError(resp) {
        let body = '';
        try { body = (await resp.text()).slice(0, 160); } catch {}
        return 'HTTP ' + resp.status + (body ? ' \u2014 ' + body : '');
    }

    // Best audio URL declared inside one <item>: scans every element
    // regardless of namespace, so plain <enclosure> and Media-RSS
    // <media:content> (possibly nested in <media:group>) both work —
    // VOA's CMS uses the latter. Audio-typed entries win; the first
    // .mp3 URL is the fallback.
    function pickItemAudio(it) {
        let firstMp3 = null;
        const nodes  = it.getElementsByTagName('*');
        for (const elm of nodes) {
            const ln = elm.localName;
            if (ln !== 'enclosure' && ln !== 'content') continue;
            const url = elm.getAttribute('url') || '';
            if (!/^https:\/\//i.test(url)) continue;
            const type   = (elm.getAttribute('type')   || '').toLowerCase();
            const medium = (elm.getAttribute('medium') || '').toLowerCase();
            if (type.indexOf('audio') !== -1 || medium === 'audio') return url;
            if (!firstMp3 && /\.mp3(\?|$)/i.test(url)) firstMp3 = url;
        }
        return firstMp3;
    }

    function parseRssItems(xmlText) {
        const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
        if (doc.querySelector('parsererror')) {
            throw new Error('Feed did not parse as RSS \u2014 check the source URL.');
        }
        const items = [];
        doc.querySelectorAll('item').forEach(it => {
            const pick = tag => it.querySelector(tag)?.textContent?.trim() || '';
            const link = pick('link');
            if (!link) return;
            // <content:encoded> holds the full HTML body on VOA feeds.
            let content = '';
            for (const el of it.children) {
                if (el.localName === 'encoded') { content = el.textContent || ''; break; }
            }
            items.push({
                id     : 'rss:' + link,
                title  : pick('title'),
                date   : pick('pubDate'),
                summary: stripTags(pick('description')).slice(0, 220),
                words  : content ? stripTags(content).split(/\s+/).length : 0,
                link   : link,
                content: content,
                audio  : pickItemAudio(it),
            });
        });
        return items;
    }

    // --- Downloading one article -------------------------------------

    async function downloadArticle(item, say) {
        const b = base();
        let text = '';

        if (item.guardianId) {
            say('Fetching article\u2026');
            const pq   = item.guardianId + '?show-fields=bodyText,headline';
            const resp = await fetch(b + '?guardian=' + encodeURIComponent(pq),
                                     { cache: 'no-store' });
            if (!resp.ok) throw new Error(await workerError(resp));
            const data = await resp.json();
            text = data?.response?.content?.fields?.bodyText || '';
        } else {
            // RSS: prefer the feed's own full body; fall back to
            // extracting the article page (VOA CMS wraps body in .wsw).
            // The page is also fetched when the feed listed no audio,
            // because VOA news articles often embed a native-speed
            // audio report that the RSS never mentions.
            text = stripArticleHtml(item.content || '');
            const thinText  = text.split(/\s+/).length < 40;
            const huntAudio = !item.audio && /voanews\.com/.test(item.link || '');
            if (thinText || huntAudio) {
                say('Fetching article page\u2026');
                try {
                    const resp = await fetch(
                        b + '?fetch=' + encodeURIComponent(item.link),
                        { cache: 'no-store' });
                    if (!resp.ok && thinText) {
                        throw new Error(await workerError(resp));
                    }
                    if (resp.ok) {
                        const page = await resp.text();
                        if (thinText) text = extractVoaBody(page) || text;
                        if (huntAudio) item.audio = findPageAudio(page);
                    }
                } catch (err) {
                    if (thinText) throw err;   // audio hunt is best-effort
                }
            }
        }
        if (!text || text.split(/\s+/).length < 20) {
            if (item.audio) {
                // A podcast episode: the description is all the text
                // there is, and the audio is the point.
                text = text || item.summary || item.title || '';
            } else {
                throw new Error('Could not extract the article text.');
            }
        }

        let audioBlob = null;
        if (item.audio) {
            say('Downloading audio\u2026');
            const resp = await fetch(b + '?media=' + encodeURIComponent(item.audio));
            if (resp.ok) {
                audioBlob = await resp.blob();
            } else {
                // Surface the reason - a silent fall-back to text-only
                // hides whitelist gaps (a 400 here once meant the Worker
                // did not know NPR's prfx.byspotify.com redirect host).
                let hint = '';
                try { hint = (await resp.text()).slice(0, 120); } catch {}
                console.warn('[feeds] audio download failed:', resp.status, hint);
                toast('Audio failed (HTTP ' + resp.status +
                      (hint ? ' \u2014 ' + hint : '') + '); saving text only.');
            }
        }

        const rec = {
            id          : item.id,
            sourceName  : item.sourceName || '',
            title       : item.title,
            date        : item.date,
            text        : text,
            audioBlob   : audioBlob,
            link        : item.link || '',
            size        : text.length + (audioBlob ? audioBlob.size : 0),
            savedAt     : Date.now(),
            lastOpenedAt: Date.now(),
        };
        await idbPut(rec);
        await enforceCacheCap();
        window.DB?.bumpSession?.('reading');
        return rec;
    }

    // Reduce article HTML to clean paragraph text ("\n\n"-separated).
    function stripArticleHtml(html) {
        const d = document.createElement('div');
        d.innerHTML = html || '';
        d.querySelectorAll('script,style,iframe,figure,img,svg,form')
         .forEach(el => el.remove());
        const paras = [];
        const nodes = d.querySelectorAll('p');
        if (nodes.length) {
            nodes.forEach(p => {
                const t = (p.textContent || '').replace(/\s+/g, ' ').trim();
                if (t) paras.push(t);
            });
            return paras.join('\n\n');
        }
        return (d.textContent || '').replace(/[ \t]+/g, ' ').trim();
    }

    // First audio file on any VOA host referenced anywhere in a page —
    // the native-speed report embedded in most VOA news articles.
    // Pages often carry media URLs inside JSON blobs with escaped
    // slashes (https:\/\/av.voanews.com\/...), so those are unescaped
    // before matching.
    function findPageAudio(pageHtml) {
        const s = (pageHtml || '').replace(/\\\//g, '/');
        const m = /https:\/\/[a-z0-9.-]+\.voanews\.com\/[^"'\s<>\\]+?\.(?:mp3|m4a|aac)[^"'\s<>\\]*/i
                  .exec(s);
        return m ? m[0].replace(/&amp;/g, '&') : null;
    }

    // VOA article pages wrap the story body in <div class="wsw">.
    function extractVoaBody(pageHtml) {
        const doc  = new DOMParser().parseFromString(pageHtml, 'text/html');
        const body = doc.querySelector('.wsw');
        return body ? stripArticleHtml(body.innerHTML) : '';
    }

    // --- UI: panel ----------------------------------------------------

    function el(id) { return document.getElementById(id); }

    function init() {
        bindSubTabs();
        el('rf-refresh')?.addEventListener('click', () => refreshList());
        el('rf-source')?.addEventListener('change', () => refreshList());
        el('rf-downloaded')?.addEventListener('click', showDownloaded);
        el('rf-sources-edit')?.addEventListener('click', toggleSourcesEditor);
        el('rf-sources-save')?.addEventListener('click', saveSourcesEditor);
        const ao = el('rf-audio-only');
        if (ao) {
            ao.checked = window.DB?.getPref?.(AUDIO_ONLY_PREF, '0') === '1';
            ao.addEventListener('change', () => {
                window.DB?.setPref?.(AUDIO_ONLY_PREF, ao.checked ? '1' : '0');
                rerenderCurrent();
            });
        }
        el('rf-list')?.addEventListener('click', handleListClick);
        el('rf-article-close')?.addEventListener('click', closeArticle);
        el('rf-article-extract')?.addEventListener('click', sendToExtractor);
        el('rf-article-body')?.addEventListener('click', handleWordTap);
        populateSourceSelect();
    }

    // Sub-tabs inside the Reader view: Extract (paste) | Daily Reading
    function bindSubTabs() {
        document.querySelectorAll('.rd-subtab[data-rdsub]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.rd-subtab').forEach(b =>
                    b.classList.toggle('active', b === btn));
                const feeds = btn.dataset.rdsub === 'feeds';
                el('rd-panel-paste').style.display = feeds ? 'none' : '';
                el('rd-panel-feeds').style.display = feeds ? '' : 'none';
                if (feeds && !currentList.length) refreshList();
            });
        });
    }

    function populateSourceSelect() {
        const sel = el('rf-source');
        if (!sel) return;
        sel.innerHTML = '';
        loadSources().forEach(s => {
            const o = document.createElement('option');
            o.value = s.id; o.textContent = s.name;
            sel.appendChild(o);
        });
    }

    function status(msg) { const s = el('rf-status'); if (s) s.textContent = msg || ''; }

    async function refreshList() {
        const sel    = el('rf-source');
        const source = loadSources().find(s => s.id === sel?.value)
                       || loadSources()[0];
        if (!source) { status('No sources configured.'); return; }
        status('Loading list\u2026');
        el('rf-list').innerHTML = '';
        try {
            const items = await fetchList(source);
            items.forEach(i => { i.sourceName = source.name; });
            currentList = items;
            const shown = await rerenderCurrent();
            status(shown + ' article(s) \u2014 tap one to download and read.');
        } catch (e) {
            status('');
            el('rf-list').innerHTML =
                '<div class="rf-error">' + esc(e.message || e) + '</div>';
        }
    }

    // A VOA item without declared audio still very often has the
    // native-speed report embedded on its page, which the downloader
    // hunts for on tap — so the filter keeps such items, badged
    // "likely" rather than hiding them.
    function likelyAudio(i) {
        return !i.audio && /voanews\.com/.test(i.link || '');
    }

    // Re-render the current list applying the audio-only filter.
    async function rerenderCurrent() {
        const audioOnly = window.DB?.getPref?.(AUDIO_ONLY_PREF, '0') === '1';
        const items     = audioOnly
            ? currentList.filter(i => i.audio || likelyAudio(i))
            : currentList;
        const saved = new Set((await idbListMeta()).map(r => r.id));
        renderList(items, saved);
        if (audioOnly && !items.length && currentList.length) {
            el('rf-list').innerHTML = '<div class="rf-error">' +
                'No audio in this feed \u2014 untick the filter to ' +
                'browse its text articles.</div>';
        }
        return items.length;
    }

    function renderList(items, savedIds) {
        const list = el('rf-list');
        list.innerHTML = items.map(i => {
            const mins  = i.words ? Math.max(1, Math.round(i.words / 180)) : 0;
            const badges =
                (i.audio ? '<span class="rf-badge">\u{1F3A7} audio</span>'
                 : likelyAudio(i)
                     ? '<span class="rf-badge">\u{1F3A7} likely</span>' : '') +
                (mins    ? '<span class="rf-badge">~' + mins + ' min</span>' : '') +
                (savedIds.has(i.id)
                    ? '<span class="rf-badge rf-badge-saved">\u2713 downloaded</span>'
                    : '');
            return '<div class="rf-item" data-id="' + esc(i.id) + '">' +
                   '<div class="rf-item-title">' + esc(i.title) + '</div>' +
                   '<div class="rf-item-meta">' + esc(fmtDate(i.date)) +
                   badges + '</div>' +
                   (i.summary
                       ? '<div class="rf-item-summary">' + esc(i.summary) + '</div>'
                       : '') +
                   '</div>';
        }).join('');
    }

    async function showDownloaded() {
        status('');
        const rows = (await idbListMeta())
            .sort((a, b) => b.savedAt - a.savedAt);
        const total = rows.reduce((s, r) => s + r.size, 0);
        el('rf-list').innerHTML =
            '<div class="rf-cache-line">Downloaded: ' + rows.length +
            ' article(s), ' + fmtSize(total) + '</div>' +
            rows.map(r =>
                '<div class="rf-item" data-id="' + esc(r.id) + '">' +
                '<div class="rf-item-title">' + esc(r.title) + '</div>' +
                '<div class="rf-item-meta">' + esc(fmtDate(r.date)) +
                '<span class="rf-badge">' + esc(r.sourceName) + '</span>' +
                (r.hasAudio ? '<span class="rf-badge">\u{1F3A7}</span>' : '') +
                '<span class="rf-badge">' + fmtSize(r.size) + '</span>' +
                '<button class="rf-del" data-del="' + esc(r.id) +
                '">Delete</button></div></div>'
            ).join('');
        if (!rows.length) {
            el('rf-list').innerHTML =
                '<div class="rf-error">Nothing downloaded yet.</div>';
        }
    }

    async function handleListClick(e) {
        const del = e.target.closest('[data-del]');
        if (del) {
            await idbDelete(del.dataset.del);
            showDownloaded();
            return;
        }
        const row = e.target.closest('.rf-item[data-id]');
        if (!row) return;
        const id = row.dataset.id;

        let rec = await idbGet(id);
        if (!rec) {
            const item = currentList.find(i => i.id === id);
            if (!item) return;
            row.classList.add('rf-item-busy');
            try {
                rec = await downloadArticle(item, m => status(m));
                status('');
                row.classList.remove('rf-item-busy');
                row.querySelector('.rf-item-meta').insertAdjacentHTML('beforeend',
                    '<span class="rf-badge rf-badge-saved">\u2713 downloaded</span>');
            } catch (err) {
                row.classList.remove('rf-item-busy');
                status('');
                toast('Download failed: ' + (err.message || err));
                return;
            }
        }
        openArticle(rec);
    }

    // --- UI: article overlay -----------------------------------------

    async function openArticle(rec) {
        openArticleId = rec.id;
        rec.lastOpenedAt = Date.now();
        idbPut(rec).catch(() => {});

        el('rf-article-title').textContent = rec.title;
        el('rf-article-meta').textContent  =
            (rec.sourceName ? rec.sourceName + ' \u00b7 ' : '') + fmtDate(rec.date);

        const player = el('rf-article-audio');
        if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
        if (rec.audioBlob) {
            audioUrl   = URL.createObjectURL(rec.audioBlob);
            player.src = audioUrl;
            player.style.display = '';
        } else {
            player.removeAttribute('src');
            player.style.display = 'none';
        }
        const na = el('rf-article-noaudio');
        if (na) na.hidden = !!rec.audioBlob;

        // Render paragraphs with every word wrapped for tap-to-save.
        el('rf-article-body').innerHTML = rec.text.split(/\n\n+/).map(p =>
            '<p>' + esc(p).replace(/[A-Za-z][A-Za-z\u2019'-]*/g,
                m => '<span class="rf-w">' + m + '</span>') + '</p>'
        ).join('');

        el('rf-article').classList.add('open');
    }

    function closeArticle() {
        el('rf-article').classList.remove('open');
        const player = el('rf-article-audio');
        try { player.pause(); } catch {}
        if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
        openArticleId = null;
    }

    // Tap a word: save it straight to the notebook with its sentence
    // as context. Long words only — taps on "the" are almost always
    // accidental.
    function handleWordTap(e) {
        const w = e.target.closest('.rf-w');
        if (!w) return;
        const word = w.textContent.trim();
        if (word.length < 3) return;
        const sentence = (w.closest('p')?.textContent || '')
            .split(/(?<=[.!?])\s+/)
            .find(s => s.includes(word)) || '';
        window.DB?.upsertNotebookWord?.({
            word   : word.toLowerCase(),
            meaning: '',
            context: sentence.trim().slice(0, 300),
            source : 'Daily Reading',
            tags   : ['reading'],
        });
        w.classList.add('rf-w-saved');
        toast('"' + word + '" saved to notebook.');
        window.App?.updateNotebookBadge?.();
    }

    // Hand the article text to the existing AI extractor (paste panel).
    function sendToExtractor() {
        const body = el('rf-article-body')?.textContent || '';
        if (!body) return;
        const input = el('rd-input');
        if (input) {
            input.value = body;
            input.dispatchEvent(new Event('input'));
        }
        closeArticle();
        document.querySelector('.rd-subtab[data-rdsub="paste"]')?.click();
        toast('Article loaded \u2014 press Extract to mine vocabulary.');
    }

    // --- UI: sources editor ------------------------------------------

    function toggleSourcesEditor() {
        const box = el('rf-sources-editor');
        const ta  = el('rf-sources-text');
        if (box.hidden) {
            ta.value = window.DB?.getPref?.(SOURCES_PREF, DEFAULT_SOURCES)
                       || DEFAULT_SOURCES;
        }
        box.hidden = !box.hidden;
    }

    function saveSourcesEditor() {
        const text   = el('rf-sources-text').value;
        const parsed = parseSources(text);
        if (!parsed.length) {
            toast('No valid sources \u2014 use "Name | url" or "Name | guardian:\u2026" per line.');
            return;
        }
        window.DB?.setPref?.(SOURCES_PREF, text);
        el('rf-sources-editor').hidden = true;
        populateSourceSelect();
        refreshList();
        toast(parsed.length + ' source(s) saved.');
    }

    // Exposed for the Node test suite; not used by the app itself.
    const _internals = { parseSources, guardianListQuery, pickEvictions,
                         findPageAudio, pickItemAudio, likelyAudio };

    return { init, _internals };

})();
