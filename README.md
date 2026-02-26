# CodeSignal Phishing Quiz (Bespoke Simulation)

This project delivers the CodeSignal phishing-awareness quiz on top of the Bespoke Simulation template. Learners review six realistic scenarios (email, Slack, and SMS) and label each one as **Phishing** or **Legit** while the UI mirrors familiar tools like Gmail, Slack, and iMessage. The repository keeps the template conventions but layers on the quiz logic, markdown formatting, and summary review enhancements described below.

## Highlights

- **Scenario-driven content** – All copy, attachments, and metadata come from `client/scenarios.yaml`. Tokens such as `{{name}}` and `{{email}}` are personalized with the values provided on the landing form.
- **Rotating landing hero** – On every load the welcome headline/subheadline pair is picked from five threat-focused options. The form defaults to `learner` / `learner@codesignal.com` so players can start instantly.
- **Interface accuracy** – Dedicated renderers emulate Gmail (headers, doc embeds, link preview strip), Slack (workspace chrome, badges, reactions), and SMS (iMessage frame).
- **Safe inline markdown** – Email and Slack bodies run through a lightweight parser that supports `[links](url)`, `**bold**`, and `_italic_`. Links keep their true `href`, receive the `sim-link` class, and register `event.preventDefault()` so navigation never leaves the sim.
- **Robust answer controls** – Phishing/Legit buttons use `type="button"` plus `data-answer-choice` attributes to ensure they remain clickable regardless of form context.

## Getting Started

```bash
npm install        # install dependencies (includes Vite)
npm start          # serve the production build with the Node server
# or
npm run dev        # start Vite dev server + API proxy for iterative work
```

- The server listens on `http://localhost:3000` by default. `npm start` sets `IS_PRODUCTION=true`, forcing the server to serve from `dist/`.
- During development, run `npm run dev` (Vite) in one terminal and `node server.js` (without `IS_PRODUCTION`) in another if you need the custom API endpoints.

## Scenario Authoring

Add or edit cases in `client/scenarios.yaml`:

- `interface`: `email`, `slack`, or `sms` controls which renderer runs.
- Interface-specific fields include Gmail metadata (`sender_name`, `mailed_by`, doc embeds), Slack workspace data (`channel`, `attachments`, `reactions`), and SMS metadata (`sender_number`, `thread_timestamp`).
- Use markdown inside `body` for links/bold/italic. Example: `[Security Center](https://corp-auth.com)`.
- Personalization tokens (`{{name}}`, `{{email}}`) are replaced after profile validation; blanks fall back to `you` / `you@company.com` to keep sentences natural.
- `red_flags` and `explanation` power the post-answer insights and summary panel.

After editing the YAML, restart the dev server or reload the page; the `/api/scenarios` endpoint streams the file directly from disk in both dev and production modes.

## Landing Experience & Personalization

- `state.profile` defaults to `learner` / `learner@codesignal.com`, so the “Take the Quiz” CTA works instantly.
- Validation enforces non-empty name/email plus a basic email regex; inline errors render directly under each field.
- Helper copy under the form reads “Used to personalize your scenarios.”
- Clicking the header title resets the experience to the welcome card and clears any answers.

## Formatting & Link Handling

- Inline markdown parser order: links → bold → italics. Links are temporarily replaced with placeholders to prevent nested replacements, then restored with sanitized `href` attributes and the `sim-link` class.
- All anchors register a click handler that calls `event.preventDefault()` so the quiz never attempts to navigate away. Gmail-style hover/focus previews still show the true URL in the footer strip.
- SMS bodies remain escaped/plain-text but preserve line breaks.
- Slack attachments and Gmail doc embeds also use `sim-link` and inherit the same safe-link behavior.

## Server & APIs

`server.js` handles:
- Static asset serving (from `dist/` when `IS_PRODUCTION=true`).
- `GET /api/scenarios` – streams `client/scenarios.yaml`.
- `POST /api/quiz-report` – accepts the structured quiz summary; results are written to `ai-checker-report.json` for the AI validator.
- `POST /message` – broadcasts JSON `{ "message": "..." }` payloads over WebSocket; install `ws` if you need live alerts.
- WebSocket `/ws` endpoint for alerts displayed via `alert()` on the client.

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
