# Gemini Browser Use Extension

Local-first Chrome extension plus helper service for running Gemini-guided browser tasks on the current tab.

## What this includes

- A Chrome Extension (Manifest V3) with:
  - side panel prompt, run/stop controls, live log
  - background service worker that manages one active session
  - content script that summarizes the DOM and executes safe actions
- A local Node helper service with:
  - `POST /session/start`
  - `POST /session/:id/observe`
  - `POST /session/:id/action-result`
  - `POST /session/:id/stop`
  - `GET /session/:id/events` SSE stream

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
   - select `/Users/alonrk/Desktop/code/gemini-browser-use/extension`

4. Open a normal web page, pin the extension if helpful, open the side panel, enter a prompt, and run it.

## Notes

- V1 is limited to the active tab.
- Sensitive pages and fields are blocked.
- Action approval prompts are disabled; Gemini-selected actions run immediately.
- If `GEMINI_API_KEY` is not set, the helper falls back to a tiny keyword-based action matcher for prompts like `click Pricing` or `type "John" into Email`.
- The helper implements a browser-use style action loop locally; it does not embed the upstream `browser-use` package yet.

## Tests

```bash
npm test
```
