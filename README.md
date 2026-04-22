# English Master Pro

A personal English-learning workbench built for advanced Chinese speakers — researchers, graduate students, and professionals who already know English well but want to sound genuinely native in academic papers, emails, presentations, and everyday conversation.

This is not a gamified vocabulary app. It's a disciplined tool built around how real learning works: steady exposure to high-quality vocabulary, deliberate practice of native phrasings, honest feedback on your writing, and the ability to study anywhere without a complicated setup.


<!-- TODO: replace with your own screenshot -->
![EM Pro screenshot](./docs/screenshot.png)

## Project status

This is an active personal project. Only the **My Words** (vocabulary) module has been tested end-to-end and can be considered stable. The other modules — Expressions, Drill, Writing Lab, Reader — are still under construction and may not work fully. Expect bugs, missing states, and incomplete features outside the vocabulary workflow.

## Five study modules

### My Words — vocabulary workbench (stable)

A vocabulary notebook with three views (cards, list, quiz) and a hands-free auto-play mode. Each word can be enriched — in bulk, via a clipboard workflow with Claude or another AI — into a rich entry with:

- IPA phonetic transcription
- Chinese meaning and English definition
- 3–4 collocations with translations
- An authentic example sentence with Chinese translation
- Usage notes tailored to Chinese-speaker pitfalls

Mark words as Core, Pronunciation, or Spelling focus to revisit them. Words you miss in quizzes are tagged as Weak automatically. Auto-play speaks the word, definition, each collocation, and the example sentence in sequence — hands-free study while commuting.

### Expressions — native phrasing drills (under construction)

Teaches native phrasing patterns that distinguish near-native speakers: hedging, soft disagreement, formal transitions, conversational warmth. Three drill modes reinforce the same expressions from different angles — fill-in-the-blank, scenario pick, and AI-evaluated rephrasing.

### Writing Lab — AI-powered text transformations (under construction)

Runs your text through six AI-powered transformations: polish, academic rewrite, conversational rewrite, paraphrase-three-ways, Chinglish detection, and professional-email drafting. Each returns structured feedback, not just a rewrite.

### Reader — vocabulary extraction (under construction)

Paste any article and extract advanced vocabulary filtered by level (intermediate, advanced, academic) and focus (idioms, technical, general).

### Speaking Coach — scenario practice (under construction)

Scenario-based speaking practice and a native-phrasing quick reference.

## Privacy and data ownership

All learning data lives in your browser's local storage. Nothing is collected, tracked, or sent to any server owned by the author of this tool. Optional features have clearly scoped third-party dependencies:

- **Cloud sync** uses a GitHub personal access token with `gist` scope only. Your data syncs to a private gist under your own GitHub account. The token cannot access your repos, code, or account settings — it can only touch your gists. Revoke anytime at https://github.com/settings/tokens.
- **AI features** use your own API key from the provider of your choice — Claude, OpenAI, DeepSeek, Gemini, or Doubao. Usage is billed to your account, not ours.

The GitHub token is stored only on your device. Your AI API key is backed up to your private sync gist as part of cross-device sync, which means it shares the security of your GitHub account — a breach there would expose it.

## Getting started

1. Open https://jack-ee.github.io/EMPro/ in any modern browser.
2. To try AI-powered word enrichment, open Settings (gear icon) and paste an API key for your chosen provider. Without a key, you can still import and browse words manually.
3. To sync data across devices, create a GitHub personal access token with the `gist` scope only at https://github.com/settings/tokens, then paste it into Settings → Cloud Sync.
4. On supported mobile devices, you can install the app to your home screen via Settings → Install on this device, or via Chrome's menu → "Install app".

## Device compatibility

The app is currently tested only on the **Xiaomi 17 Pro Max**. It's a standard progressive web app built with vanilla HTML/CSS/JS and should work on modern Android phones, iOS devices (Safari 16.4+), and any current desktop browser. Other devices haven't been verified, so your experience may vary.

If you try it on another device and hit a problem, please open an issue with your device model, browser, and a description of what went wrong.

## Technical notes

Built as a vanilla HTML/CSS/JavaScript PWA — no framework dependencies. Runs entirely in the browser with a service worker for offline support. Uses:

- localStorage for persistence (profile-scoped)
- GitHub Gist API for optional cross-device sync
- Web Speech API (with Google TTS fallback on Android) for pronunciation
- Screen Wake Lock API to keep the screen on during auto-play sessions
- Standard `fetch` for AI API calls (Claude, OpenAI, DeepSeek, Gemini, Doubao)

No backend, no telemetry, no accounts.

## License

Personal project. See LICENSE for details.
