# Gemini Computer Use (Playwright Runtime)

Local-first Gemini Computer Use runner with:
- a local web app for prompt + start URL input
- a headed Playwright browser so actions are visible
- a Node helper loop that sends observations to Gemini and executes returned actions

## Runtime

- Start UI: `GET /`
- Start run: `POST /runs/start` with `{ prompt, startUrl }`
- Stop run: `POST /runs/:id/stop`
- Event stream: `GET /runs/:id/events` (SSE)

SSE event types:
- `status`
- `thought`
- `action`
- `action_result`
- `done`
- `error`

## Run locally

1. Install dependencies:

```bash
npm install
```

2. Set Gemini API key:

```bash
export GEMINI_API_KEY=your_key_here
```

You can also paste the key directly into the web app "Gemini API Key" field for a specific run.

3. Start server:

```bash
npm start
```

4. Open:

```text
http://127.0.0.1:3210
```

Then enter `startUrl` + `prompt` and click `Run`.

## Behavior

- Browser is always visible (`headless: false`).
- Scope is start-domain only: cross-domain navigation is blocked.
- Allowed action execution: `click_at`, `type_text_at`, `scroll_document`, `wait_5_seconds`, `go_back`, `navigate`.
- Loop guards stop repeated no-progress behavior.
- JSONL logs are written to `server/logs/`.

## Notes

- The old extension code is kept in the repo but is no longer used by the active runtime path.
- Gemini Computer Use is preview tooling; function availability and safety responses may vary.

## Tests

```bash
npm test
```
