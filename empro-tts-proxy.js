/**
 * empro-tts-proxy — Cloudflare Worker
 * ============================================================
 * Purpose
 *   OpenAI's API does not send CORS headers, so a browser page
 *   (the EMPro PWA on GitHub Pages) cannot call it directly.
 *   This Worker sits in between: the browser calls the Worker,
 *   the Worker calls OpenAI and adds the missing CORS header.
 *
 * Security
 *   This Worker holds NO secret. The browser sends its own
 *   OpenAI key in the Authorization header and the Worker only
 *   forwards it. Requests are also restricted by Origin, so a
 *   random web page cannot use the proxy.
 *
 * Deploy (one time, ~10 minutes, free)
 *   1. Sign in at https://dash.cloudflare.com  (create a free
 *      account if needed).
 *   2. Left sidebar: "Workers & Pages" → "Create" → "Create Worker".
 *   3. Give it a name, e.g.  empro-tts  → "Deploy".
 *   4. Click "Edit code", delete the sample, paste THIS file,
 *      then "Deploy".
 *   5. Copy the Worker URL shown — it looks like
 *      https://empro-tts.<your-subdomain>.workers.dev
 *   6. In EMPro: Settings → Voice → paste that URL into the
 *      "TTS proxy URL" field. Tap "Test neural voice".
 *
 * If the EMPro site is ever served from another origin, add it
 * to ALLOWED_ORIGINS below and re-deploy.
 * ============================================================
 */

const OPENAI_TTS = 'https://api.openai.com/v1/audio/speech';

// Only these origins may use the proxy. Add a localhost line here
// if you test the EMPro app locally, e.g. 'http://localhost:8000'.
const ALLOWED_ORIGINS = [
    'https://jack-ee.github.io',
];

function corsHeaders(origin) {
    const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    return {
        'Access-Control-Allow-Origin' : allow,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age'      : '86400',
        'Vary'                        : 'Origin',
    };
}

export default {
    async fetch(request) {
        const origin = request.headers.get('Origin') || '';

        // CORS preflight — the browser sends this before the real POST
        // because the request carries an Authorization header.
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders(origin) });
        }

        if (request.method !== 'POST') {
            return new Response('Method not allowed', {
                status: 405, headers: corsHeaders(origin),
            });
        }

        // Restrict to the EMPro site. The Origin header is set by the
        // browser and cannot be forged by a normal web page.
        if (origin && !ALLOWED_ORIGINS.includes(origin)) {
            return new Response('Origin not allowed', {
                status: 403, headers: corsHeaders(origin),
            });
        }

        // Forward the request to OpenAI, passing through the caller's
        // own Authorization header (their API key — never stored here).
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

        // Relay OpenAI's response (audio on success, JSON error
        // otherwise) with CORS headers added so the browser accepts it.
        const headers = corsHeaders(origin);
        const ct = upstream.headers.get('Content-Type');
        if (ct) headers['Content-Type'] = ct;
        return new Response(upstream.body, { status: upstream.status, headers });
    },
};
