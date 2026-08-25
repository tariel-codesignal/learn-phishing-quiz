# CodeSignal Phishing Quiz (Bespoke Simulation)

This project delivers the CodeSignal phishing-awareness quiz on top of the Bespoke Simulation template. Learners review seven realistic scenarios (email, Slack, and SMS) and label each one as **Phishing** or **Legit** while the UI mirrors familiar tools like Gmail, Slack, and iMessage. The repository keeps the template conventions but layers on the quiz logic, markdown formatting, and summary review enhancements described below.

## Highlights

- **Scenario-driven content** – All copy, attachments, and metadata come from `client/scenarios.yaml`. The YAML is parsed with `js-yaml`, which Vite bundles into the app, so the sim has no CDN dependency and works offline. Tokens such as `{{name}}` and `{{email}}` are personalized with the values provided on the landing form.
- **Rotating landing hero** – On every load the welcome headline/subheadline pair is picked from five threat-focused options. The form defaults to `learner` / `learner@codesignal.com` so players can start instantly.
- **Interface accuracy** – Dedicated renderers emulate Gmail (app bar, label chips, expandable headers, doc embeds, link preview strip), Slack (workspace sidebar with channels/DMs, emoji shortcodes, hover actions, WYSIWYG composer), and iMessage (status bar with Dynamic Island, bottom-pinned thread, bubble tail, home indicator). Each shell uses its platform's font stack with offline-safe fallbacks.
- **Safe inline markdown** – Email and Slack bodies run through a lightweight parser that supports `[links](url)`, `**bold**`, and `_italic_`. Links keep their true `href`, receive the `sim-link` class, and register `event.preventDefault()` so navigation never leaves the sim.
- **Robust answer controls** – Phishing/Legit buttons use `type="button"` plus `data-answer-choice` attributes to ensure they remain clickable regardless of form context.
- **Server-side grading** – The quiz state is exposed on a single `GET /snapshot` endpoint, graded server-side from `client/scenarios.yaml`. See [Quiz State API](#quiz-state-api-evaluation).

## Getting Started

```bash
npm install        # install dependencies (includes Vite)
npm start          # serve the production build with the Node server
# or
npm run start:dev  # start Vite dev server + API proxy for iterative work
```

- The server listens on `http://localhost:3000` by default. `npm start` sets `IS_PRODUCTION=true`, forcing the server to serve from `dist/`.
- `npm run start:dev` runs both halves at once. To drive them separately, run `npm run dev:vite` (Vite on port 3000) in one terminal and `npm run dev:api` (the API server on port 3001) in another; Vite proxies `/api`, `/message`, and `/ws` through to it.

## Scenario Authoring

Add or edit cases in `client/scenarios.yaml`:

- `interface`: `email`, `slack`, or `sms` controls which renderer runs.
- Slack `channel` values starting with `#` must be quoted (`channel: "#finance-alerts"`) — unquoted `#` starts a YAML comment and the field silently parses as empty. A channel of `Direct message` (or omitting `channel`) renders the DM layout, labeled with the sender's name.
- Slack bodies support emoji shortcodes (`:warning:`, `:white_check_mark:`, `:eyes:`, …) which render as real emoji like Slack does.
- Interface-specific fields include Gmail metadata (`sender_name`, `mailed_by`, doc embeds), Slack workspace data (`channel`, `attachment`, `reactions`), and SMS metadata (`sender_number`, `thread_timestamp`).
- Use markdown inside `body` for links/bold/italic. Example: `[Security Center](https://corp-auth.com)`.
- Personalization tokens (`{{name}}`, `{{email}}`) resolve to the fixed persona (`signalite` / `signalite@codesignal.com`).
- `intro`: one or two neutral sentences that set the scene, shown above the message before the learner answers. Falls back to generic per-interface copy when omitted. Keep it spoiler-free.
- `red_flags` and `explanation` power the post-answer insights and summary panel.

After editing the YAML, restart the dev server or reload the page; the `/api/scenarios` endpoint streams the file directly from disk in both dev and production modes.

## Quiz Bar & Scenario Intro

A slim sticky bar keeps the "Question X of Y" progress and the Phishing/Legit (or Review/Next) buttons visible while scrolling tall messages, and collapses gracefully at narrow embed widths (~60% panels). Each scenario opens with an intro block ("New email · You handle vendor payments…") sourced from the scenario's `intro:` field in `client/scenarios.yaml`; after answering, the verdict and explanation swap into that same block, so nothing pops in above the message.

## Landing Experience & Personalization

- There is no sign-in form: every learner plays as the fixed persona `signalite` / `signalite@codesignal.com`, which fills all `{{name}}`/`{{email}}` tokens. The landing card is just the rotating headline plus the "Take the Quiz" CTA.
- Progress is saved to `localStorage`, so a reload resumes the quiz where the learner left off instead of starting over. Editing `client/scenarios.yaml` invalidates saved progress, and grades are always recomputed from the YAML rather than trusted from storage.

## Formatting & Link Handling

- Inline markdown parser order: links → bold → italics. Links are temporarily replaced with placeholders to prevent nested replacements, then restored with sanitized `href` attributes and the `sim-link` class.
- All anchors register a click handler that calls `event.preventDefault()` so the quiz never attempts to navigate away. Gmail-style hover/focus previews still show the true URL in the footer strip.
- SMS bodies remain escaped/plain-text but preserve line breaks.
- Slack attachments and Gmail doc embeds also use `sim-link` and inherit the same safe-link behavior.

## Server & APIs

`server.js` handles:
- Static asset serving (from `dist/` when `IS_PRODUCTION=true`).
- `GET /api/scenarios` – streams `client/scenarios.yaml`.
- `GET /snapshot` – the graded state of the quiz, for evaluation. See below.
- `POST /snapshot` – the browser pushes the learner's raw answers here as they play.
- `POST /message` – broadcasts JSON `{ "message": "..." }` payloads over WebSocket; install `ws` if you need live alerts.
- WebSocket `/ws` endpoint for alerts displayed via `alert()` on the client.

## Quiz State API (evaluation)

There is one endpoint to read for grading:

```bash
curl http://localhost:3000/snapshot
```

```json
{
  "version": 1,
  "source": "client",
  "status": "completed",
  "passed": true,
  "verdict": "All answers are correct. Solution is passing.",
  "total": 7,
  "answered": 7,
  "remaining": 0,
  "correct": 7,
  "incorrect": 0,
  "score": 1,
  "profile": { "name": "learner", "email": "learner@codesignal.com" },
  "scenarios": [
    {
      "id": "vendor-invoice-payment-change-request",
      "interface": "email",
      "expected_answer": "phishing",
      "user_answer": "phishing",
      "correct": true
    }
  ],
  "updated_at": "2026-08-25T12:00:00.000Z"
}
```

- `status` is `not_started`, `in_progress`, or `completed`; `passed` is true only when every scenario is answered correctly.
- `source` is `server` when no browser has reported yet (the endpoint still answers, derived from `scenarios.yaml`) and `client` once the learner has played.
- **Grading happens on the server.** The browser posts only which choice the learner made for each scenario id; `server.js` grades those against `is_phishing` in `client/scenarios.yaml`. A client that claims `passed: true` is ignored, and unknown scenario ids or answers other than `phishing`/`legit` are discarded.
- State is held **in memory only** – there is no report file on disk. Restarting the server resets it to `not_started`, and so does the learner using "Restart training".
- Because the answer key is read per request, editing `client/scenarios.yaml` immediately re-grades answers the learner has already given.

## Building & Releasing

```bash
npm run build        # produces optimized assets in dist/
npm ci --production  # (in CI) install only prod deps for packaging
```

The GitHub Actions workflow `.github/workflows/build-release.yml` executes on every push to `main`:

1. Install dependencies and run `npm run build`.
2. Re-install production-only dependencies (`npm ci --production`).
3. Create `release.tar.gz` containing:
   - `dist/`
   - `package.json`
   - `server.js`
   - `node_modules/` (prod deps)
   - `client/scenarios.yaml`
4. Upload the tarball as a GitHub Release asset tagged `v${{github.run_number}}`.

To deploy a release artifact manually:

```bash
wget <release-url>/release.tar.gz
mkdir app && tar -xzf release.tar.gz -C app
cd app && npm run start:prod
```

## Testing & Manual Verification

- **Landing flow** – reload a few times to confirm the headline/subheadline randomization and default form values.
- **Markdown rendering** – use the first email and Slack scenarios to verify `[link]`, `**bold**`, and `_italic_` segments render correctly and do not navigate when clicked.
- **Button reliability** – rapidly click Phishing/Legit to ensure the data attributes fire and the result screen appears without any form-submission side effects.

For deeper template conventions or styling guidance, see `BESPOKE-TEMPLATE.md` and `AGENTS.md`.
