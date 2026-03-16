# Gemini Computer Use Chrome Extension

Local-first Chrome extension plus helper service for running Gemini Computer Use on the real current tab.

## What this includes

- A Chrome Extension (Manifest V3) with:
  - side panel prompt, run/stop controls, live log
  - background service worker that manages one active session on the current tab
  - content script that executes visible actions and summarizes the page
- A local Node helper service with:
  - `POST /session/start`
  - `POST /session/:id/observe`
  - `POST /session/:id/action-result`
  - `POST /session/:id/stop`
  - `GET /session/:id/events` SSE stream
  - JSONL session logs in [server/logs](/Users/alonrk/Desktop/code/gemini-computer-use/server/logs)

## Run locally

1. Export a Gemini API key:

```bash
export GEMINI_API_KEY=your_key_here
```

2. Start the local helper:

```bash
npm start
```

3. Load the extension in Chrome:
   - open `chrome://extensions`
   - enable Developer mode
   - choose Load unpacked
   - select [extension](/Users/alonrk/Desktop/code/gemini-computer-use/extension)

4. Open a normal web page, open the extension side panel, enter a prompt, and click `Run`.

## Runtime behavior

- Gemini Computer Use receives the current tab screenshot, URL, page summary, and recent action history.
- The extension executes Gemini's actions directly on the current tab.
- The agent is generic: it attempts prompts across docs, forms, dashboards, search pages, and e-commerce flows.
- Same-site navigation is allowed, but cross-site navigation is blocked.
- Loop guards stop repeated action/page oscillation and force strategy changes before failing.
- Unsafe actions are blocked (downloads, password/credit-card fields, irreversible payment confirmation).
- Runs write debug logs to [server/logs](/Users/alonrk/Desktop/code/gemini-computer-use/server/logs).

## Notes

- If `GEMINI_API_KEY` is not set, runs fail fast with a clear helper error.
- Gemini Computer Use is still preview tooling, so some model function names or safety behavior may need tuning against live API responses.

## Tests

```bash
npm test
```
