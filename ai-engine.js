// ============================================================
// ai-engine.js — Multi-Provider AI Engine
// Supports: Claude, OpenAI, DeepSeek, Gemini
// ============================================================

window.AIEngine = (function() {

    // ─── Provider Definitions ────────────────────────────────
    const PROVIDERS = {
        claude: {
            label    : 'Claude (Anthropic)',
            apiUrl   : 'https://api.anthropic.com/v1/messages',
            models   : ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001'],
            default  : 'claude-sonnet-4-20250514',
            keyHint  : 'sk-ant-api03-...',
            format   : 'claude'
        },
        openai: {
            label    : 'OpenAI',
            apiUrl   : 'https://api.openai.com/v1/chat/completions',
            models   : ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1-nano'],
            default  : 'gpt-4o-mini',
            keyHint  : 'sk-...',
            format   : 'openai'
        },
        deepseek: {
            label    : 'DeepSeek',
            apiUrl   : 'https://api.deepseek.com/v1/chat/completions',
            models   : ['deepseek-chat', 'deepseek-reasoner'],
            default  : 'deepseek-chat',
            keyHint  : 'sk-...',
            format   : 'openai'
        },
        gemini: {
            label    : 'Google Gemini',
            apiUrl   : 'https://generativelanguage.googleapis.com/v1beta/models',
            models   : ['gemini-2.0-flash', 'gemini-2.5-flash-preview-04-17'],
            default  : 'gemini-2.0-flash',
            keyHint  : 'AIza...',
            format   : 'gemini'
        },
        doubao: {
            label    : 'Doubao (豆包)',
            apiUrl   : 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
            models   : ['doubao-1.5-pro-32k', 'doubao-1.5-lite-32k', 'doubao-pro-256k'],
            default  : 'doubao-1.5-pro-32k',
            keyHint  : 'ark-api key...',
            format   : 'openai'
        }
    };

    // ─── Settings helpers ────────────────────────────────────
    function getProvider() {
        return window.DB?.getPref?.('ai_provider', 'claude') || 'claude';
    }
    function getProviderDef() {
        return PROVIDERS[getProvider()] || PROVIDERS.claude;
    }
    function getModel() {
        const saved = window.DB?.getPref?.('ai_model', '');
        const prov  = getProviderDef();
        return saved && prov.models.includes(saved) ? saved : prov.default;
    }

    // ─── Core call: dispatches to the right format ───────────
    async function callClaude(systemPrompt, userMessage, options) {
        const apiKey = window.DB.getAPIKey();
        if (!apiKey) throw new Error('API_KEY_MISSING');

        const prov   = getProviderDef();
        const model  = (options && options.model) || getModel();
        const maxTok = (options && options.maxTokens) || 2048;

        switch (prov.format) {
            case 'claude':  return await callClaude_impl(prov, apiKey, model, maxTok, systemPrompt, userMessage);
            case 'openai':  return await callOpenAI_impl(prov, apiKey, model, maxTok, systemPrompt, userMessage);
            case 'gemini':  return await callGemini_impl(prov, apiKey, model, maxTok, systemPrompt, userMessage);
            default:        throw new Error('UNKNOWN_PROVIDER');
        }
    }

    // ─── Claude format ───────────────────────────────────────
    async function callClaude_impl(prov, apiKey, model, maxTok, system, user) {
        const resp = await fetch(prov.apiUrl, {
            method  : 'POST',
            headers : {
                'Content-Type'                              : 'application/json',
                'x-api-key'                                 : apiKey,
                'anthropic-version'                         : '2023-06-01',
                'anthropic-dangerous-direct-browser-access'  : 'true'
            },
            body: JSON.stringify({ model, max_tokens: maxTok, system, messages: [{ role: 'user', content: user }] })
        });
        if (!resp.ok) throw await buildError(resp);
        const data    = await resp.json();
        const textBlk = (data.content || []).find(c => c.type === 'text');
        if (!textBlk?.text) throw new Error('EMPTY_RESPONSE');
        return textBlk.text;
    }

    // ─── OpenAI-compatible format (OpenAI, DeepSeek) ─────────
    async function callOpenAI_impl(prov, apiKey, model, maxTok, system, user) {
        const messages = [];
        if (system) messages.push({ role: 'system', content: system });
        messages.push({ role: 'user', content: user });

        const resp = await fetch(prov.apiUrl, {
            method  : 'POST',
            headers : {
                'Content-Type'  : 'application/json',
                'Authorization' : `Bearer ${apiKey}`
            },
            body: JSON.stringify({ model, max_tokens: maxTok, messages })
        });
        if (!resp.ok) throw await buildError(resp);
        const data = await resp.json();
        const text = data.choices?.[0]?.message?.content;
        if (!text) throw new Error('EMPTY_RESPONSE');
        return text;
    }

    // ─── Gemini format ───────────────────────────────────────
    async function callGemini_impl(prov, apiKey, model, maxTok, system, user) {
        const url = `${prov.apiUrl}/${model}:generateContent?key=${apiKey}`;
        const body = {
            contents          : [{ parts: [{ text: user }] }],
            generationConfig  : { maxOutputTokens: maxTok }
        };
        if (system) {
            body.systemInstruction = { parts: [{ text: system }] };
        }

        const resp = await fetch(url, {
            method  : 'POST',
            headers : { 'Content-Type': 'application/json' },
            body    : JSON.stringify(body)
        });
        if (!resp.ok) throw await buildError(resp);
        const data = await resp.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error('EMPTY_RESPONSE');
        return text;
    }

    // ─── Error builder ───────────────────────────────────────
    async function buildError(resp) {
        const errText = await resp.text().catch(() => '');
        if (resp.status === 401 || resp.status === 403) return new Error('API_KEY_INVALID');
        if (resp.status === 429)                         return new Error('RATE_LIMITED');
        if (resp.status === 529)                         return new Error('API_OVERLOADED');
        return new Error(`API_ERROR_${resp.status}: ${errText.slice(0, 200)}`);
    }

    // ─── JSON wrapper ────────────────────────────────────────
    async function callClaudeJSON(systemPrompt, userMessage, options) {
        const raw = await callClaude(systemPrompt, userMessage, options);
        let cleaned = raw.trim();
        if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
        }
        try {
            return JSON.parse(cleaned);
        } catch (e) {
            console.warn('[AI Engine] JSON parse failed, raw:', raw.slice(0, 300));
            throw new Error('JSON_PARSE_FAILED');
        }
    }

    // ─── Friendly error messages ─────────────────────────────
    function friendlyError(err) {
        const msg = (err && err.message) || String(err);
        const provLabel = getProviderDef().label;
        const map = {
            'API_KEY_MISSING'   : `Please set your ${provLabel} API key in Settings first.`,
            'API_KEY_INVALID'   : `API key is invalid. Please check your ${provLabel} key in Settings.`,
            'RATE_LIMITED'      : 'Too many requests. Please wait a moment and try again.',
            'API_OVERLOADED'    : `${provLabel} is temporarily overloaded. Please try again shortly.`,
            'EMPTY_RESPONSE'    : 'Received an empty response. Please try again.',
            'JSON_PARSE_FAILED' : 'Could not parse the AI response. Please try again.',
            'UNKNOWN_PROVIDER'  : 'Unknown AI provider. Please check Settings.'
        };
        for (const [key, friendly] of Object.entries(map)) {
            if (msg.includes(key)) return friendly;
        }
        return `An error occurred: ${msg.slice(0, 120)}`;
    }

    function hasAPIKey() {
        return Boolean(window.DB.getAPIKey());
    }

    // Public API
    return {
        callClaude,
        callClaudeJSON,
        friendlyError,
        hasAPIKey,
        PROVIDERS,
        getProvider,
        getProviderDef,
        getModel
    };
})();
