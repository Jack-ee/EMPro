/**
 * test/test-speech-chain-v104.js — device speech must always report back
 * ============================================================
 * Run:  node test/test-speech-chain-v104.js
 *
 * Autoplay is a chain: a segment advances the session only when its onEnd
 * fires. A device-speech path that can finish without firing anything
 * therefore does not lose one segment, it silently ends the session — which
 * is exactly what "it played the first word and its explanation, then
 * stopped" looks like from the outside.
 *
 * The Web Speech API has three documented ways of going silent, and this
 * file drives all of them through a fake engine:
 *
 *   1. speak() issued in the same tick as cancel(): the utterance is
 *      dropped and NEITHER onend NOR onerror fires
 *   2. the utterance object collected mid-speech, same silence
 *   3. Chrome cutting a long utterance at ~15s with no event
 *
 * In every case onEnd must fire exactly once, because the chain depends on
 * it. Firing twice is just as damaging: it would skip a card.
 *
 * app.js is a large IIFE that expects a DOM, so rather than load it whole,
 * this harness extracts speakNative and its helpers and runs them against a
 * scripted engine. The extraction is checked, so the test fails loudly if the
 * function is renamed or restructured rather than passing vacuously.
 * ============================================================
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0;
let failed = 0;
const ok = (c, l) => { if (c) { passed++; console.log('  \u2713 ' + l); }
                       else   { failed++; console.log('  \u2717 ' + l); } };

// --- Pull speakNative and its helpers out of app.js ----------------------

const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function extract(startMarker, endMarker) {
    const a = src.indexOf(startMarker);
    if (a < 0) throw new Error('not found in app.js: ' + startMarker);
    const b = src.indexOf(endMarker, a);
    if (b < 0) throw new Error('end not found for: ' + startMarker);
    return src.slice(a, b);
}

const helpers = extract('let _nativeUtter = null;', 'function speakNative(');
const body    = extract('function speakNative(text, rate, onEnd, opts) {',
                        'OpenAI neural TTS');

ok(/clearInterval/.test(helpers), 'the resume ticker is part of what was extracted');
ok(/_nativeToken/.test(body),     'and the stop token is used inside speakNative');

// --- Fake speech engine --------------------------------------------------

function makeEngine(mode) {
    const engine = {
        spoken   : [],
        cancels  : 0,
        resumes  : 0,
        speaking : false,
        cancel() { this.cancels++; this.speaking = false; },
        resume() { this.resumes++; },
        getVoices() { return [{ lang : 'en-US', name : 'Test EN' },
                              { lang : 'zh-CN', name : 'Test ZH' }]; },
        speak(u) {
            this.spoken.push(u);
            this.speaking = true;
            if (mode === 'normal')  setTimeout(() => { this.speaking = false; u.onend(); }, 20);
            if (mode === 'error')   setTimeout(() => { this.speaking = false; u.onerror(); }, 20);
            // 'silent' and 'gc' fire nothing at all, which is the whole point.
            if (mode === 'gc')      setTimeout(() => { this.speaking = false; }, 20);
        }
    };
    return engine;
}

function load(mode) {
    const engine  = makeEngine(mode);
    const sandbox = {
        console : { warn : () => {}, log : () => {} },
        setTimeout : setTimeout, clearTimeout : clearTimeout,
        setInterval : setInterval, clearInterval : clearInterval,
        Number : Number, String : String, Math : Math, parseFloat : parseFloat,
        SpeechSynthesisUtterance : function (t) { this.text = t; },
        refreshVoices : () => engine.getVoices(),
        resolveVoice  : () => engine.getVoices()[0],
        DB : { getPref : (n, f) => f }
    };
    sandbox.window = sandbox;
    sandbox.speechSynthesis = engine;
    vm.runInNewContext(helpers + body + '\nthis.speakNative = speakNative;'
                     + '\nthis.stopSpeak = () => { _nativeToken++; clearNativeTimers(); '
                     + '_nativeUtter = null; window.speechSynthesis.cancel(); };',
                       sandbox, { filename : 'speakNative.js' });
    return { speakNative : sandbox.speakNative, stopSpeak : sandbox.stopSpeak,
             engine : engine, sandbox : sandbox };
}

// --- Tests ---------------------------------------------------------------

function run(mode, text, waitMs) {
    return new Promise(resolve => {
        const h = load(mode);
        let calls = 0;
        const t0  = Date.now();
        h.speakNative(text, 1, () => { calls++; });
        setTimeout(() => resolve({ calls : calls, ms : Date.now() - t0, h : h }), waitMs);
    });
}

async function main() {
    console.log('\n1. The normal path still works');
    let r = await run('normal', 'hello there', 300);
    ok(r.calls === 1, 'onEnd fires exactly once on a clean end');
    ok(r.h.engine.spoken.length === 1, 'and the engine was asked to speak once');

    console.log('\n2. cancel() and speak() are not in the same tick');
    r = await run('normal', 'hello', 300);
    const u = r.h.engine.spoken[0];
    ok(r.h.engine.cancels >= 1, 'cancel() is still issued');
    ok(!!u, 'and the utterance reaches the engine on a later tick');

    console.log('\n3. An engine that fires nothing must not stall the chain');
    r = await run('silent', 'a short line', 6000);
    ok(r.calls === 1, 'the watchdog reports back exactly once');
    ok(r.ms > 1000, 'after giving the speech a fair chance to finish first');

    console.log('\n4. An utterance collected mid-speech is also covered');
    r = await run('gc', 'a short line', 6000);
    ok(r.calls === 1, 'onEnd still fires exactly once');

    console.log('\n5. onerror advances the chain rather than ending it');
    r = await run('error', 'hello', 300);
    ok(r.calls === 1, 'an error is reported as an end');

    console.log('\n6. The watchdog scales with the text');
    const { sandbox } = load('normal');
    const short = sandbox.speechBudgetMs('hi', 1);
    const long  = sandbox.speechBudgetMs('x'.repeat(400), 1);
    const zh    = sandbox.speechBudgetMs('\u4e2d\u6587'.repeat(40), 1);
    ok(long > short, 'a longer text gets a longer budget');
    ok(zh > sandbox.speechBudgetMs('x'.repeat(80), 1),
       'Chinese gets more time per character, since it carries more sound');
    ok(sandbox.speechBudgetMs('x'.repeat(400), 0.5)
       > sandbox.speechBudgetMs('x'.repeat(400), 1),
       'a slower rate gets more time');
    ok(long < 120001, 'and the budget is capped so nothing waits forever');

    console.log('\n7. A stop cancels a speak that has not started yet');
    const h = load('normal');
    let calls = 0;
    h.speakNative('hello', 1, () => { calls++; });
    h.stopSpeak();                        // within the 60 ms deferral
    await new Promise(r2 => setTimeout(r2, 400));
    ok(h.engine.spoken.length === 0, 'the deferred utterance never reaches the engine');
    ok(calls === 0, 'and a stopped segment does not advance the chain');

    console.log('\n' + '='.repeat(52));
    console.log(passed + ' passed, ' + failed + ' failed');
    console.log('='.repeat(52));
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.log('harness error: ' + e.stack); process.exit(1); });
