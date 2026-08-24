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
    // badge shows right in the list. Guardian is text-only. VOA was
    // dropped in v113: frozen since the 2025-03-15 USAGM shutdown, its
    // newscast pages carry neither text nor working audio (the Worker
    // still whitelists voanews.com should a source ever be re-added).
    const DEFAULT_SOURCES =
        'NPR \u00b7 News Now (5 min, hourly) | https://feeds.npr.org/500005/podcast.xml\n' +
        'NPR \u00b7 Up First | https://feeds.npr.org/510318/podcast.xml\n' +
        'BBC \u00b7 Global News Podcast | https://podcasts.files.bbci.co.uk/p02nq0gn.rss\n' +
        'Guardian \u00b7 World | guardian:section=world\n' +
        'Guardian \u00b7 Science | guardian:section=science';

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
        if (isNaN(d)) return '';
        const day   = d.toISOString().slice(0, 10);
        const now   = new Date();
        const today = now.toISOString().slice(0, 10);
        now.setDate(now.getDate() - 1);
        const yday  = now.toISOString().slice(0, 10);
        if (day === today) return 'Today';
        if (day === yday)  return 'Yesterday';
        return day;
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
            } else if (/^drive:/i.test(target)) {
                const folder = target.replace(/^drive:/i, '').trim();
                if (/^[A-Za-z0-9_-]{10,}$/.test(folder)) {
                    out.push({ id, name, type: 'drive', folder });
                }
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

    // Brand chip for a source: known brands get their colours; anything
    // else gets initials on a colour derived from the name, so
    // user-added sources look intentional too.
    function brandFor(name) {
        const n = (name || '').toLowerCase();
        if (n.includes('npr'))      return { mono: 'NPR', bg: '#d62021' };
        if (n.includes('bbc'))      return { mono: 'BBC', bg: '#111111' };
        if (n.includes('guardian')) return { mono: 'G',   bg: '#052962' };
        if (n.includes('voa'))      return { mono: 'VOA', bg: '#1660a7' };
        if (n.includes('notebook') || n.includes('nlm') || n.includes('drive')) {
            return { mono: 'NLM', bg: '#4285f4' };
        }
        const words = (name || '?').split(/[^A-Za-z0-9]+/).filter(Boolean);
        const mono  = words.slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
        let hash = 0;
        for (const ch of n) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
        return { mono, bg: 'hsl(' + (hash % 360) + ',45%,38%)' };
    }

    // "HH:MM:SS" | "MM:SS" | plain seconds -> seconds (0 if unknown)
    function parseDuration(s) {
        s = (s || '').trim();
        if (!s) return 0;
        if (/^\d+$/.test(s)) return parseInt(s, 10);
        const parts = s.split(':').map(x => parseInt(x, 10));
        if (parts.some(isNaN)) return 0;
        return parts.reduce((acc, p) => acc * 60 + p, 0);
    }

    function fmtDur(sec) {
        if (!sec) return '';
        if (sec < 90) return sec + ' s';
        return Math.round(sec / 60) + ' min';
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
        if (source.type === 'drive') {
            const resp = await fetch(
                b + '?drive=list&folder=' + encodeURIComponent(source.folder),
                { cache: 'no-store' });
            if (!resp.ok) throw new Error(await workerError(resp));
            const data  = await resp.json();
            const files = (data.files || []).filter(x =>
                /^audio\//.test(x.mimeType || '') ||
                /\.(mp3|m4a|wav|aac|ogg)$/i.test(x.name || ''));
            return files.map(x => ({
                id      : 'drive:' + x.id,
                driveId : x.id,
                title   : (x.name || '').replace(/\.[a-z0-9]+$/i, ''),
                date    : x.modifiedTime,
                summary : (x.size ? fmtSize(parseInt(x.size, 10)) + ' \u00b7 ' : '')
                          + (x.mimeType || ''),
                words   : 0,
                link    : '',
                audio   : 'drive',        // truthy: badge + filter
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
            // http:// is accepted too - BBC's open.live.bbc.co.uk
            // enclosure redirector still uses it, and the Worker
            // relays server-side where mixed content does not apply.
            if (!/^https?:\/\//i.test(url)) continue;
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
            const pick  = tag => it.querySelector(tag)?.textContent?.trim() || '';
            const link  = pick('link');
            const audio = pickItemAudio(it);
            // Pure newscast feeds (NPR News Now) have no <link> at all;
            // fall back to <guid>, then to the audio URL, as the item key.
            const key   = link || pick('guid') || audio;
            if (!key) return;
            // Namespaced children: <content:encoded> holds the full HTML
            // body; <itunes:duration> the episode length.
            let content  = '';
            let duration = 0;
            for (const el of it.children) {
                if (el.localName === 'encoded'  && !content) content = el.textContent || '';
                if (el.localName === 'duration' && !duration) {
                    duration = parseDuration(el.textContent);
                }
            }
            items.push({
                id     : 'rss:' + key,
                title  : pick('title'),
                date   : pick('pubDate'),
                summary: stripTags(pick('description')).slice(0, 220),
                words  : content ? stripTags(content).split(/\s+/).length : 0,
                link   : link,
                content: content,
                audio  : audio,
                durationSec: duration,
            });
        });
        return items;
    }

    // Weak-signal-resilient audio download. Fetches in 3 MB Range
    // chunks so a dropped connection loses one chunk, not the file;
    // each chunk retries up to 3 times with backoff. Servers that
    // ignore Range (respond 200) fall back to one streamed request.
    // The Worker's ?media and ?drive=file routes pass Range through.
    const CHUNK_BYTES = 3 * 1048576;

    async function fetchAudioResilient(url, onStatus, label) {
        const say = (m) => onStatus && onStatus(m);
        const pct = (got, total) => total
            ? Math.floor(got / total * 100) + '% \u00b7 '
              + (got / 1048576).toFixed(1) + '/'
              + (total / 1048576).toFixed(1) + ' MB'
            : (got / 1048576).toFixed(1) + ' MB';

        async function chunkReq(from, to, attempt) {
            const resp = await fetch(url, {
                headers: { Range: 'bytes=' + from + '-' + to },
            });
            if (resp.status === 206 || resp.status === 200) return resp;
            throw new Error('HTTP ' + resp.status);
        }

        // First chunk decides the mode.
        let first;
        try {
            first = await chunkReq(0, CHUNK_BYTES - 1);
        } catch (e) {
            throw new Error(label + ' failed to start: ' + (e.message || e));
        }

        if (first.status === 200) {
            // Range ignored: stream the whole body with progress.
            const total = parseInt(first.headers.get('Content-Length'), 10) || 0;
            if (!first.body || !first.body.getReader) {
                return new Blob([await first.arrayBuffer()]);
            }
            const reader = first.body.getReader();
            const parts  = [];
            let   got    = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                parts.push(value);
                got += value.length;
                say(label + ' \u2014 ' + pct(got, total));
            }
            return new Blob(parts);
        }

        // 206: chunked mode. Total size from Content-Range "bytes a-b/total".
        const cr    = first.headers.get('Content-Range') || '';
        const total = parseInt(cr.split('/')[1], 10) || 0;
        if (!total) throw new Error(label + ': server sent no total size.');
        const parts = [new Uint8Array(await first.arrayBuffer())];
        let   got   = parts[0].length;
        say(label + ' \u2014 ' + pct(got, total));

        while (got < total) {
            const to = Math.min(got + CHUNK_BYTES, total) - 1;
            let   chunk = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const resp = await chunkReq(got, to, attempt);
                    chunk = new Uint8Array(await resp.arrayBuffer());
                    break;
                } catch (e) {
                    if (attempt === 3) {
                        throw new Error(label + ' lost the connection at '
                            + pct(got, total) + ' \u2014 tap again to retry.');
                    }
                    say(label + ' \u2014 retrying (' + attempt + '/3)\u2026');
                    await new Promise(r => setTimeout(r, attempt * 1500));
                }
            }
            parts.push(chunk);
            got += chunk.length;
            if (chunk.length === 0) throw new Error(label + ': empty chunk.');
            say(label + ' \u2014 ' + pct(got, total));
        }
        return new Blob(parts);
    }

    // --- Downloading one article -------------------------------------

    async function downloadArticle(item, say) {
        const b = base();
        let text = '';

        if (item.driveId) {
            const blob = await fetchAudioResilient(
                b + '?drive=file&id=' + encodeURIComponent(item.driveId),
                say, 'Audio');
            const rec  = {
                id          : item.id,
                sourceName  : item.sourceName || '',
                title       : item.title,
                date        : item.date,
                text        : item.title + '\n\n' + (item.summary || ''),
                audioBlob   : blob,
                link        : '',
                size        : blob.size,
                savedAt     : Date.now(),
                lastOpenedAt: Date.now(),
            };
            await idbPut(rec);
            await enforceCacheCap();
            window.DB?.bumpSession?.('reading');
            return rec;
        }

        if (item.guardianId) {
            say('Fetching article\u2026');
            const pq   = item.guardianId + '?show-fields=bodyText,headline';
            const resp = await fetch(b + '?guardian=' + encodeURIComponent(pq),
                                     { cache: 'no-store' });
            if (!resp.ok) throw new Error(await workerError(resp));
            const data = await resp.json();
            text = data?.response?.content?.fields?.bodyText || '';
        } else {
            // RSS: the feed's own body (content:encoded). Podcast
            // episodes usually have only a description, which suffices
            // when there is audio to play.
            text = stripArticleHtml(item.content || '');
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
            try {
                audioBlob = await fetchAudioResilient(
                    b + '?media=' + encodeURIComponent(item.audio),
                    say, 'Audio');
            } catch (e) {
                // Surface the reason - a silent fall-back to text-only
                // once hid a whitelist gap for days.
                console.warn('[feeds] audio download failed:', e.message || e);
                toast((e.message || 'Audio download failed')
                      + ' \u2014 saving text only.');
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

    // --- UI: panel ----------------------------------------------------

    function el(id) { return document.getElementById(id); }

    function init() {
        el('rf-refresh')?.addEventListener('click', () => refreshList());
        el('rf-source-bar')?.addEventListener('click', (e) => {
            const chip = e.target.closest('.rf-chip');
            if (!chip) return;
            currentSourceId = chip.dataset.src;
            renderSourceBar();
            refreshList();
        });
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
        el('rf-extract-open')?.addEventListener('click', () =>
            el('rd-extract-modal')?.classList.add('open'));
        el('rd-extract-close')?.addEventListener('click', () =>
            el('rd-extract-modal')?.classList.remove('open'));
        el('rf-article-extract')?.addEventListener('click', sendToExtractor);
        el('rf-article-body')?.addEventListener('click', handleWordTap);
        renderSourceBar();

        // Feeds ARE the News tab now: load the
        // list the first time the tab is shown (or immediately when it
        // is the active tab at boot, e.g. first in the tab order).
        const lazyLoad = () => { if (!currentList.length) refreshList(); };
        document.querySelector('.nav-tab[data-nav="reader"]')
            ?.addEventListener('click', lazyLoad);
        if (document.querySelector('.nav-tab[data-nav="reader"].active')) {
            lazyLoad();
        }
    }

    let currentSourceId = null;

    function renderSourceBar() {
        const bar = el('rf-source-bar');
        if (!bar) return;
        const sources = loadSources();
        if (!sources.some(s => s.id === currentSourceId)) {
            currentSourceId = sources[0]?.id || null;
        }
        bar.innerHTML = sources.map(s => {
            const b = brandFor(s.name);
            const short = s.name.replace(/^[^\u00b7|]*\u00b7\s*/, '');
            return '<button class="rf-chip' +
                   (s.id === currentSourceId ? ' rf-chip-active' : '') +
                   '" data-src="' + esc(s.id) + '" title="' + esc(s.name) + '">' +
                   '<span class="rf-mono" style="background:' + b.bg + '">' +
                   esc(b.mono) + '</span>' +
                   '<span class="rf-chip-name">' + esc(short) + '</span>' +
                   '</button>';
        }).join('');
    }

    function status(msg) { const s = el('rf-status'); if (s) s.textContent = msg || ''; }

    async function refreshList() {
        const source = loadSources().find(s => s.id === currentSourceId)
                       || loadSources()[0];
        if (!source) { status('No sources configured.'); return; }
        status('Loading list\u2026');
        el('rf-list').innerHTML = '';
        try {
            const items = await fetchList(source);
            items.forEach(i => { i.sourceName = source.name; });
            currentList = items.slice(0, 100);
            const shown = await rerenderCurrent();
            if (!el('rf-status')?.textContent) {
                status(shown + ' article(s) \u2014 tap one to download and read.');
            }
        } catch (e) {
            status('');
            el('rf-list').innerHTML =
                '<div class="rf-error">' + esc(e.message || e) + '</div>';
        }
    }

    // Re-render the current list applying the audio-only filter.
    async function rerenderCurrent() {
        status('');
        const audioOnly = window.DB?.getPref?.(AUDIO_ONLY_PREF, '0') === '1';
        const items     = audioOnly
            ? currentList.filter(i => i.audio)
            : currentList;
        // A source with no audio at all (Guardian) is a text source;
        // blanking it under the audio filter only ever confused. Show
        // its articles and say why the filter does not apply.
        if (audioOnly && !items.length && currentList.length) {
            const saved = new Set((await idbListMeta()).map(r => r.id));
            renderList(currentList, saved);
            status('Text-only source \u2014 audio filter not applied.');
            return currentList.length;
        }
        const saved = new Set((await idbListMeta()).map(r => r.id));
        renderList(items, saved);
        return items.length;
    }

    function renderList(items, savedIds) {
        const list = el('rf-list');
        list.innerHTML = items.map(i => {
            const mins  = i.words ? Math.max(1, Math.round(i.words / 180)) : 0;
            const badges =
                (i.audio
                    ? '<span class="rf-badge">\u{1F3A7} ' +
                      (fmtDur(i.durationSec) || 'audio') + '</span>'
                    : (mins ? '<span class="rf-badge">~' + mins
                              + ' min read</span>' : '')) +
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
                '<div class="rf-item-meta">' +
                '<span class="rf-mono rf-mono-sm" style="background:' +
                brandFor(r.sourceName).bg + '">' +
                esc(brandFor(r.sourceName).mono) + '</span>' +
                esc(fmtDate(r.date)) +
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
        const item = currentList.find(i => i.id === id);
        if (rec && !rec.audioBlob && item && item.audio) {
            // Saved before its audio could be fetched (e.g. behind an
            // old whitelist); the feed says audio exists - fetch again.
            rec = null;
        }
        if (!rec) {
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
                status('Download failed: ' + (err.message || err));
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

        // Lock-screen card for podcast playback: title + play/pause and
        // 15-second seek on the system media controls. The <audio>
        // element itself keeps sounding with the screen off; this makes
        // it controllable from there.
        if ('mediaSession' in navigator && rec.audioBlob) {
            try {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title : rec.title,
                    artist: rec.sourceName || 'Daily Reading',
                    album : 'EMPro',
                });
                navigator.mediaSession.setActionHandler('play',
                    () => player.play());
                navigator.mediaSession.setActionHandler('pause',
                    () => player.pause());
                navigator.mediaSession.setActionHandler('seekbackward',
                    () => { player.currentTime = Math.max(0, player.currentTime - 15); });
                navigator.mediaSession.setActionHandler('seekforward',
                    () => { player.currentTime = Math.min(player.duration || 0,
                                                          player.currentTime + 15); });
            } catch (e) { /* older browsers */ }
        }
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
        el('rd-extract-modal')?.classList.add('open');
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
        renderSourceBar();
        refreshList();
        toast(parsed.length + ' source(s) saved.');
    }

    // Exposed for the Node test suite; not used by the app itself.
    const _internals = { parseSources, guardianListQuery, pickEvictions,
                         pickItemAudio, brandFor, parseDuration,
                         fetchAudioResilient };

    return { init, _internals };

})();
