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

function corsHeaders(origin) {
    const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    return {
        'Access-Control-Allow-Origin'  : allow,
        'Access-Control-Allow-Methods' : 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers' : 'Content-Type, Authorization',
        'Access-Control-Expose-Headers': 'Content-Length',
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
    headers['Cache-Control'] = 'public, max-age=300';
    return new Response(upstream.body, { status: 200, headers });
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
    async fetch(request) {
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

        if (request.method === 'GET')  return handlePackRequest(request, origin);
        if (request.method === 'POST') return handleTtsRequest(request, origin);

        return new Response('Method not allowed', {
            status: 405, headers: corsHeaders(origin),
        });
    },
};
