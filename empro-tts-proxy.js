/**
 * empro-tts-proxy - Cloudflare Worker
 * ============================================================
 * Purpose
 *   Two jobs, both solving the same browser limitation: cross-origin
 *   requests the EMPro PWA cannot make directly.
 *
 *   1. Neural TTS proxy (POST). OpenAI's API sends no CORS headers,
 *      so a browser page cannot call it. The Worker forwards the
 *      request and adds the missing CORS header.
 *
 *   2. Audio pack proxy (GET). The pronunciation pack is a GitHub
 *      Release asset. Release asset downloads 302-redirect to a CDN
 *      blob that sends no CORS header, so a browser fetch is blocked.
 *      The Worker fetches the asset server-side - where CORS does not
 *      apply - and relays it with the header added.
 *
 * Security
 *   This Worker holds NO secret. For TTS the browser sends its own
 *   OpenAI key and the Worker only forwards it. The pack route can
 *   only reach a fixed repository and a whitelisted set of asset
 *   names, so it cannot be used as an open proxy. Both routes are
 *   restricted by Origin.
 *
 * Deploy (paste this whole file into the Worker, then Deploy)
 *   Dashboard -> Workers & Pages -> your Worker -> Edit code ->
 *   replace everything with this file -> Deploy. The Worker URL is
 *   unchanged, so the EMPro "TTS proxy URL" setting still applies and
 *   the same URL also serves the audio pack.
 *
 * If the audio pack lives in a different repo, edit PACK_REPO below.
 *
 * Reading feeds (GET ?fetch= / ?media= / ?guardian=)
 *   The Daily Reading module pulls live feeds and Guardian articles,
 *   none of which are reachable from the app directly. ?fetch relays
 *   an RSS feed or article page from a whitelisted domain; ?media
 *   relays audio with Range passthrough so the player can seek;
 *   ?guardian calls the Guardian content API, attaching the
 *   GUARDIAN_API_KEY held in the Worker environment (Settings ->
 *   Variables and Secrets; the key never reaches the browser).
 *
 * Split packs
 *   The pack is published as several part assets plus a small manifest.
 *   PACK_ASSET_RE already covers the part names. What matters here is
 *   the cache policy: the manifest must be no-store, while a part
 *   requested with its ?v=<sha256> is immutable. See handlePackRequest.
 * ============================================================
 */

const OPENAI_TTS = 'https://api.openai.com/v1/audio/speech';

// Only these origins may use the proxy. Add a localhost line here
// if you test the EMPro app locally, e.g. 'http://localhost:8000'.
const ALLOWED_ORIGINS = [
    'https://jack-ee.github.io',
];

// Audio pack source. The pack route only ever fetches from this repo
// and release tag, and only asset names matching PACK_ASSET_RE.
const PACK_REPO     = 'Jack-ee/EMPro';
const PACK_TAG      = 'audio-pack';
const PACK_ASSET_RE = /^empro-audio-pack[A-Za-z0-9._-]*$/;

// Reading feeds: only hosts under these domains may be relayed
// (exact match or any subdomain). FEED covers RSS feeds and article
// pages; MEDIA additionally covers podcast enclosure hosts — NPR
// enclosures start on tracking redirectors (chrt.fm, podtrac), and
// the Worker follows redirects server-side, so only the first hop
// needs whitelisting. Add a domain before adding a source elsewhere.
const FEED_DOMAINS = [
    'voanews.com',
    'npr.org',
    'bbci.co.uk',
    'bbc.co.uk',
    'bbc.com',
];
const MEDIA_DOMAINS = [
    'voanews.com',
    'npr.org',
    'podtrac.com',
    'chrt.fm',
    'megaphone.fm',
    'byspotify.com',        // prfx.byspotify.com - first hop on NPR enclosures
    'simplecastaudio.com',  // npr.simplecastaudio.com - NPR's audio CDN
    'bbci.co.uk',
    'bbc.co.uk',
];
const GUARDIAN_API = 'https://content.guardianapis.com/';
const DRIVE_API    = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_ID_RE  = /^[A-Za-z0-9_-]{10,}$/;

function corsHeaders(origin) {
    const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    return {
        'Access-Control-Allow-Origin'  : allow,
        'Access-Control-Allow-Methods' : 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers' : 'Content-Type, Authorization',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
        'Access-Control-Max-Age'       : '86400',
        'Vary'                         : 'Origin',
    };
}

// --- Audio pack route (GET) ---------------------------------------
// Relays a whitelisted GitHub Release asset with CORS headers added.
async function handlePackRequest(request, origin) {
    const asset = new URL(request.url).searchParams.get('asset') || '';
    if (!PACK_ASSET_RE.test(asset)) {
        return new Response('Unknown or disallowed asset name', {
            status: 400, headers: corsHeaders(origin),
        });
    }

    const ghUrl = 'https://github.com/' + PACK_REPO +
                  '/releases/download/' + PACK_TAG + '/' + asset;

    let upstream;
    try {
        // A server-side fetch follows the 302 to the CDN with no CORS
        // restriction, so the bytes come back cleanly.
        upstream = await fetch(ghUrl, { redirect: 'follow' });
    } catch (e) {
        return new Response('Pack fetch failed: ' + e, {
            status: 502, headers: corsHeaders(origin),
        });
    }

    if (!upstream.ok) {
        return new Response('Pack not found (HTTP ' + upstream.status +
            '). Has the Build audio pack workflow run yet?', {
            status: upstream.status, headers: corsHeaders(origin),
        });
    }

    // Relay the body (streamed) with CORS headers. Content-Length is
    // passed through and exposed so the page can show download progress.
    const headers = corsHeaders(origin);
    const ct = upstream.headers.get('Content-Type');
    const cl = upstream.headers.get('Content-Length');
    if (ct) headers['Content-Type']   = ct;
    if (cl) headers['Content-Length'] = cl;

    // Caching, by asset kind:
    //
    //   manifest (.json)  no-store. The manifest is how the app decides
    //     whether anything changed, so serving a cached copy makes it decide
    //     "up to date" when it is not. That failure is silent and lasts until
    //     the next build, which is the worst shape a bug can have here.
    //
    //   part (?v=<sha>)   cache hard. The URL carries the part's own sha256,
    //     so an address maps to exactly one set of bytes forever. A changed
    //     part arrives under a new address and can never be served stale.
    //
    //   anything else     short, conservative window.
    const url = new URL(request.url);
    if (/\.json$/i.test(asset)) {
        headers['Cache-Control'] = 'no-store';
    } else if (url.searchParams.get('v')) {
        headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    } else {
        headers['Cache-Control'] = 'public, max-age=300';
    }
    return new Response(upstream.body, { status: 200, headers });
}

// --- Reading feed routes (GET) ------------------------------------
// ?fetch=<url>    relay an RSS feed or article page (whitelisted hosts)
// ?media=<url>    relay audio with Range passthrough for seeking
// ?guardian=<pq>  call the Guardian content API with the env-held key

function hostAllowed(url, domains) {
    try {
        const h = new URL(url).hostname;
        return domains.some(d => h === d || h.endsWith('.' + d));
    } catch { return false; }
}

async function handleFeedRequest(request, origin) {
    const target = new URL(request.url).searchParams.get('fetch') || '';
    if (!hostAllowed(target, FEED_DOMAINS)) {
        return new Response('Host not allowed for ?fetch', {
            status: 400, headers: corsHeaders(origin),
        });
    }
    let upstream;
    try {
        upstream = await fetch(target, { redirect: 'follow' });
    } catch (e) {
        return new Response('Feed fetch failed: ' + e, {
            status: 502, headers: corsHeaders(origin),
        });
    }
    const headers = corsHeaders(origin);
    const ct = upstream.headers.get('Content-Type');
    if (ct) headers['Content-Type'] = ct;
    // Lists must be fresh; article pages change too. Never cache.
    headers['Cache-Control'] = 'no-store';
    return new Response(upstream.body, { status: upstream.status, headers });
}

async function handleMediaRequest(request, origin) {
    const target = new URL(request.url).searchParams.get('media') || '';
    if (!hostAllowed(target, MEDIA_DOMAINS)) {
        return new Response('Host not allowed for ?media', {
            status: 400, headers: corsHeaders(origin),
        });
    }
    // Headers instance rather than a plain object: the dashboard
    // editor's type checker rejects dynamically-built object literals
    // as HeadersInit, and an error there greys out the Deploy button.
    const fwd   = new Headers();
    const range = request.headers.get('Range');
    if (range) fwd.set('Range', range);
    // Redirects are followed by hand: podcast tracking chains
    // (byspotify -> podtrac -> simplecast) often send RELATIVE or
    // scheme-less Location headers, which the Workers runtime's
    // redirect:'follow' refuses with "Incomplete URL". new URL(loc,
    // current) resolves every form correctly.
    let upstream;
    try {
        let current = target;
        for (let hop = 0; hop < 6; hop++) {
            upstream = await fetch(current,
                                   { redirect: 'manual', headers: fwd });
            const loc = upstream.headers.get('Location');
            if (upstream.status < 300 || upstream.status >= 400 || !loc) break;
            current = new URL(loc, current).toString();
        }
    } catch (e) {
        return new Response('Media fetch failed: ' + e, {
            status: 502, headers: corsHeaders(origin),
        });
    }
    const headers = corsHeaders(origin);
    for (const h of ['Content-Type', 'Content-Length',
                     'Content-Range', 'Accept-Ranges']) {
        const v = upstream.headers.get(h);
        if (v) headers[h] = v;
    }
    // Published clips never change; a day of edge/browser cache saves
    // repeat downloads without staleness risk.
    headers['Cache-Control'] = 'public, max-age=86400';
    return new Response(upstream.body, { status: upstream.status, headers });
}

async function handleGuardianRequest(request, origin, env) {
    const key = (env && env.GUARDIAN_API_KEY) || '';
    if (!key) {
        return new Response('GUARDIAN_API_KEY is not set on the Worker. ' +
            'Add it under Settings -> Variables and Secrets, then redeploy.', {
            status: 500, headers: corsHeaders(origin),
        });
    }
    // pq is a path plus query, e.g. "search?section=world&page-size=20"
    // or an article id like "world/2026/aug/20/some-slug?show-fields=bodyText".
    const pq = new URL(request.url).searchParams.get('guardian') || '';
    if (!pq || pq.includes('..') || pq.startsWith('/') || pq.includes('api-key')) {
        return new Response('Bad ?guardian request', {
            status: 400, headers: corsHeaders(origin),
        });
    }
    const target = GUARDIAN_API + pq + (pq.includes('?') ? '&' : '?') +
                   'api-key=' + encodeURIComponent(key);
    if (!target.startsWith(GUARDIAN_API)) {
        return new Response('Bad ?guardian request', {
            status: 400, headers: corsHeaders(origin),
        });
    }
    let upstream;
    try {
        upstream = await fetch(target, { redirect: 'follow' });
    } catch (e) {
        return new Response('Guardian fetch failed: ' + e, {
            status: 502, headers: corsHeaders(origin),
        });
    }
    const headers = corsHeaders(origin);
    headers['Content-Type']  = 'application/json; charset=utf-8';
    headers['Cache-Control'] = 'no-store';
    return new Response(upstream.body, { status: upstream.status, headers });
}

// --- Google Drive route (GET ?drive=) -----------------------------
// Lists and serves audio files from a PUBLIC Drive folder ("anyone
// with the link - viewer"), for NotebookLM-generated podcasts and the
// like. The GOOGLE_API_KEY lives in the Worker environment and never
// reaches the browser; folder and file ids are strictly validated, so
// only the fixed Drive API base can be reached.
//   ?drive=list&folder=<folderId>   -> file listing JSON
//   ?drive=file&id=<fileId>         -> file bytes, Range passthrough

async function handleDriveRequest(request, origin, env) {
    const key = (env && env.GOOGLE_API_KEY) || '';
    if (!key) {
        return new Response('GOOGLE_API_KEY is not set on the Worker. ' +
            'Add it under Settings -> Variables and Secrets, then redeploy.', {
            status: 500, headers: corsHeaders(origin),
        });
    }
    const q    = new URL(request.url).searchParams;
    const mode = q.get('drive');

    if (mode === 'list') {
        const folder = q.get('folder') || '';
        if (!DRIVE_ID_RE.test(folder)) {
            return new Response('Bad folder id', {
                status: 400, headers: corsHeaders(origin),
            });
        }
        // One level of recursion: people file each document's audio in
        // its own subfolder, so the top listing is folders. Children of
        // up to 25 subfolders are fetched in ONE extra query (parents
        // OR-ed together) and merged, each file annotated with its
        // subfolder's name so the app can show which document it
        // belongs to. Deeper nesting is not descended into.
        const listQuery = (qExpr) => DRIVE_API +
            '?q=' + encodeURIComponent(qExpr + ' and trashed=false') +
            '&fields=' + encodeURIComponent(
                'files(id,name,mimeType,size,modifiedTime,parents)') +
            '&orderBy=' + encodeURIComponent('modifiedTime desc') +
            '&pageSize=200&key=' + encodeURIComponent(key);
        try {
            const topResp = await fetch(listQuery("'" + folder + "' in parents"));
            if (!topResp.ok) {
                const headers = corsHeaders(origin);
                headers['Content-Type']  = 'application/json; charset=utf-8';
                headers['Cache-Control'] = 'no-store';
                return new Response(topResp.body,
                                    { status: topResp.status, headers });
            }
            const top     = await topResp.json();
            const entries = top.files || [];
            const FOLDER  = 'application/vnd.google-apps.folder';
            const files   = entries.filter(f => f.mimeType !== FOLDER);
            const subs    = entries.filter(f => f.mimeType === FOLDER)
                                   .slice(0, 25);
            if (subs.length) {
                const nameOf = {};
                subs.forEach(s => { nameOf[s.id] = s.name; });
                const orExpr = '(' + subs.map(s =>
                    "'" + s.id + "' in parents").join(' or ') + ')';
                const subResp = await fetch(listQuery(orExpr));
                if (subResp.ok) {
                    const sub = await subResp.json();
                    (sub.files || []).forEach(f => {
                        if (f.mimeType === FOLDER) return;
                        const parent = (f.parents || [])[0];
                        f.folder = nameOf[parent] || '';
                        files.push(f);
                    });
                }
            }
            files.sort((a, b) =>
                (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
            const headers = corsHeaders(origin);
            headers['Content-Type']  = 'application/json; charset=utf-8';
            headers['Cache-Control'] = 'no-store';
            return new Response(JSON.stringify({ files }),
                                { status: 200, headers });
        } catch (e) {
            return new Response('Drive list failed: ' + e, {
                status: 502, headers: corsHeaders(origin),
            });
        }
    }

    if (mode === 'file') {
        const id = q.get('id') || '';
        if (!DRIVE_ID_RE.test(id)) {
            return new Response('Bad file id', {
                status: 400, headers: corsHeaders(origin),
            });
        }
        const fwd   = new Headers();
        const range = request.headers.get('Range');
        if (range) fwd.set('Range', range);
        let upstream;
        try {
            let current = DRIVE_API + '/' + id + '?alt=media&key=' +
                          encodeURIComponent(key);
            for (let hop = 0; hop < 6; hop++) {
                upstream = await fetch(current,
                                       { redirect: 'manual', headers: fwd });
                const loc = upstream.headers.get('Location');
                if (upstream.status < 300 || upstream.status >= 400 || !loc) break;
                current = new URL(loc, current).toString();
            }
        } catch (e) {
            return new Response('Drive file failed: ' + e, {
                status: 502, headers: corsHeaders(origin),
            });
        }
        const headers = corsHeaders(origin);
        for (const h of ['Content-Type', 'Content-Length',
                         'Content-Range', 'Accept-Ranges']) {
            const v = upstream.headers.get(h);
            if (v) headers[h] = v;
        }
        headers['Cache-Control'] = 'public, max-age=86400';
        return new Response(upstream.body, { status: upstream.status, headers });
    }

    return new Response('Bad ?drive request', {
        status: 400, headers: corsHeaders(origin),
    });
}

// --- Neural TTS route (POST) --------------------------------------
async function handleTtsRequest(request, origin) {
    let upstream;
    try {
        upstream = await fetch(OPENAI_TTS, {
            method : 'POST',
            headers: {
                'Content-Type' : 'application/json',
                'Authorization': request.headers.get('Authorization') || '',
            },
            body: await request.text(),
        });
    } catch (e) {
        return new Response('Upstream fetch failed: ' + e, {
            status: 502, headers: corsHeaders(origin),
        });
    }

    const headers = corsHeaders(origin);
    const ct = upstream.headers.get('Content-Type');
    if (ct) headers['Content-Type'] = ct;
    return new Response(upstream.body, { status: upstream.status, headers });
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '';

        // CORS preflight - sent before a POST because it carries an
        // Authorization header. A simple GET is not preflighted.
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders(origin) });
        }

        // Restrict to the EMPro site. An empty Origin (some same-origin
        // or non-browser cases) is allowed through.
        if (origin && !ALLOWED_ORIGINS.includes(origin)) {
            return new Response('Origin not allowed', {
                status: 403, headers: corsHeaders(origin),
            });
        }

        if (request.method === 'GET') {
            const q = new URL(request.url).searchParams;
            if (q.has('fetch'))    return handleFeedRequest(request, origin);
            if (q.has('media'))    return handleMediaRequest(request, origin);
            if (q.has('guardian')) return handleGuardianRequest(request, origin, env);
            if (q.has('drive'))    return handleDriveRequest(request, origin, env);
            return handlePackRequest(request, origin);
        }
        if (request.method === 'POST') return handleTtsRequest(request, origin);

        return new Response('Method not allowed', {
            status: 405, headers: corsHeaders(origin),
        });
    },
};
