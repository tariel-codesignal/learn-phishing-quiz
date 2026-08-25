# Repository Guidelines

This repository contains a template for building embedded applications using
the Bespoke Simulation framework. For complete template documentation, see
[BESPOKE-TEMPLATE.md](./BESPOKE-TEMPLATE.md).

## Overview

This template provides:
- CodeSignal Design System integration
- Consistent layout components (header, sidebar, main content area)
- Help modal system
- Local development server with WebSocket support
- Standardized file structure and naming conventions

## Quick Start

1. **Customize the HTML template** (`client/index.html`):
   - Replace `<!-- APP_TITLE -->` with your page title
   - Replace `<!-- APP_NAME -->` with your app name
   - Add your main content at `<!-- APP_SPECIFIC_MAIN_CONTENT -->`
   - Add app-specific CSS links at `<!-- APP_SPECIFIC_CSS -->`
   - Add app-specific JavaScript at `<!-- APP_SPECIFIC_SCRIPTS -->`

2. **Create your application files**:
   - App-specific CSS (e.g., `my-app.css`)
   - App-specific JavaScript (e.g., `my-app.js`)
   - Help content (based on `help-content-template.html`)

3. **Start the development server**:
   ```bash
   npm start
   ```
   Server runs on `http://localhost:3000`

## Key Conventions

### File Naming

- CSS files: kebab-case (e.g., `my-app.css`)
- JavaScript files: kebab-case (e.g., `my-app.js`)
- Data files: kebab-case (e.g., `solution.json`)
- Image files: kebab-case (e.g., `overview.png`)

### Error Handling

- Wrap all async operations in try-catch blocks
- Provide meaningful error messages to users
- Log errors to console for debugging
- Implement retry logic for network operations
- Handle localStorage quota exceeded errors
- Validate data before saving operations

## Development Workflow

### Build and Test

```bash
# Start development server
npm start

# Development mode (Vite dev server + API server together)
npm run start:dev
```

### WebSocket Messaging

The server provides a `POST /message` endpoint for real-time messaging:

```bash
curl -X POST http://localhost:3000/message \
  -H "Content-Type: application/json" \
  -d '{"message": "Your message here"}'
```

This sends alerts to connected clients. Requires `ws` package:
```bash
npm install
```

### Quiz State for Evaluation

`GET /snapshot` returns the graded state of the quiz as JSON. Grading is done in
`server.js` against `is_phishing` in `client/scenarios.yaml`; the browser only
reports which choice the learner made, so the snapshot cannot be spoofed from
client state. The state is in-memory only - there is no report file on disk.

```bash
curl http://localhost:3000/snapshot
```

## Template Documentation

For detailed information about:
- Design System usage and components
- CSS implementation guidelines
- JavaScript API (HelpModal)
- Component reference and examples
- Customization options

See [BESPOKE-TEMPLATE.md](./BESPOKE-TEMPLATE.md).

## Project Structure

```
client/
  ├── index.html              # Main HTML template
  ├── app.js                  # Application logic
  ├── bespoke-template.css    # Template-specific styles
  ├── help-modal.js           # Help modal system
  ├── help-content-template.html  # Help content template
  └── design-system/          # CodeSignal Design System
      ├── colors/
      ├── spacing/
      ├── typography/
      └── components/
server.js                      # Development server
```

## Notes for AI Agents

When working on applications built with this template:

1. **Always reference BESPOKE-TEMPLATE.md** for template-specific
   implementation details
2. **Follow the conventions** listed above for file naming
3. **Use Design System components** directly - see BESPOKE-TEMPLATE.md for
   component classes and usage
4. **Maintain consistency** with the template's structure and patterns
5. **Keep guidelines up to date** by editing this AGENTS.md file as the codebase evolves