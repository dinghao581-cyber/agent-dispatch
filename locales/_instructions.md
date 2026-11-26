# Translating agent-dispatch UI strings

You translate the UI strings of a Claude Code plugin ("agent-dispatch", a side panel that dispatches background coding agents). Your task names one target language and its locale code, written below as LANG and CODE.

Working directory: the root of the agent-dispatch repository.

Input: `locales/_source.json`: a JSON object whose KEYS are the English UI strings and whose VALUES are the Simplified Chinese versions (context only: translate from the English key, use the Chinese to understand the meaning).

Output: create ONE file, `locales/CODE.json`: a JSON object with exactly the same keys as `locales/_source.json` (copy every key unchanged, character for character) and, as each value, the LANG translation of that key. UTF-8. Do not create, edit or delete any other file. Do not run git.

Rules:
- Keep placeholders `{0}` `{1}` `{2}` exactly, each appearing the same number of times as in the key (you may reorder them for grammar).
- Keep leading/trailing spaces and separators like " · " as in the key; keep symbols (⚙ ‹ › ↻ ● ○ ✓ ⚠ ↗ ✅ ⓘ) unchanged.
- Do NOT translate: DeepSeek, Claude, Claude Code, Codex, OpenAI, ANTHROPIC_API_KEY, Git, NAS, PATH, UTC, sk-, worktree, tool names such as dispatch_create / dispatch_get / dispatch_list / dispatch_control, file paths, and anything that is a command or code.
- "Dispatcher" is the product name: translate it as a short natural word for "task dispatcher" in LANG, and use the same word everywhere.
- Short UI labels (buttons, tabs, column names) must stay short. Use the tone of a modern desktop app. "Key" means an API key.
- Write in the standard written form of LANG, in its usual script.

When the file is written, run `node scripts/i18n.mjs check`. It prints one line per locale file with problems. Look only at the line for `CODE.json`: if it reports missing keys, extra keys or placeholder mismatches, fix `locales/CODE.json` and run the check again until `CODE.json` is not listed. Ignore lines about other files (other agents are writing them at the same time).

Done = `locales/CODE.json` exists, is valid JSON, and the check does not list it. Your final answer: one line saying how many strings you translated.
