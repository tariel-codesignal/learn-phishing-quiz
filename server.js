const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const yaml = require('js-yaml');

// Try to load WebSocket module, fallback if not available
let WebSocket = null;
let isWebSocketAvailable = false;
try {
  WebSocket = require('ws');
  isWebSocketAvailable = true;
  console.log('WebSocket support enabled');
} catch (error) {
  console.log('WebSocket support disabled (ws package not installed)');
  console.log('Install with: npm install ws');
}

const DIST_DIR = path.join(__dirname, 'dist');
const SCENARIOS_PATH = path.join(__dirname, 'client', 'scenarios.yaml');
// Check if IS_PRODUCTION is set to true
const isProduction = process.env.IS_PRODUCTION === 'true';
// In production mode, dist directory must exist
if (isProduction && !fs.existsSync(DIST_DIR)) {
  throw new Error(`Production mode enabled but dist directory does not exist: ${DIST_DIR}`);
}
// Force port 3000 in production, otherwise use PORT environment variable or default to 3000
const PORT = isProduction ? 3000 : (process.env.PORT || 3000);

// Track connected WebSocket clients
const wsClients = new Set();

// Latest raw submission pushed by the browser. Held in memory only - quiz state is live
// session data, so there is no report file on disk to go stale or get committed by accident.
let latestSubmission = null;

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload, null, 2));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function loadScenarioDefinitions() {
  const parsed = yaml.load(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error('scenarios.yaml must contain a list');
  }
  return parsed;
}

// Grading happens here, against scenarios.yaml, rather than being taken from the browser.
// The client only ever reports which choice the learner made, so the snapshot an evaluator
// reads cannot be spoofed by editing client state. Re-derived per request, so editing
// scenarios.yaml immediately re-grades whatever the learner has already answered.
function buildSnapshot() {
  const scenarios = loadScenarioDefinitions();

  const submitted = new Map();
  if (latestSubmission) {
    latestSubmission.answers.forEach(entry => {
      if (entry && typeof entry.id === 'string') {
        submitted.set(entry.id, entry.answer);
      }
    });
  }

  const results = scenarios.map(scenario => {
    const expected = scenario.is_phishing ? 'phishing' : 'legit';
    const answer = submitted.get(scenario.id);
    const answered = answer === 'phishing' || answer === 'legit';
    return {
      id: scenario.id,
      interface: scenario.interface || null,
      expected_answer: expected,
      user_answer: answered ? answer : null,
      correct: answered ? answer === expected : null
    };
  });

  const total = results.length;
  const answered = results.filter(result => result.user_answer !== null).length;
  const correct = results.filter(result => result.correct === true).length;
  const incorrect = results.filter(result => result.correct === false).length;
  const completed = total > 0 && answered === total;
  const passed = completed && incorrect === 0;

  let status = 'not_started';
  if (completed) {
    status = 'completed';
  } else if (answered > 0) {
    status = 'in_progress';
  }

  let verdict = 'Learner has not started the quiz.';
  if (passed) {
    verdict = 'All answers are correct. Solution is passing.';
  } else if (completed) {
    verdict = `${incorrect} of ${total} answers are incorrect. Solution is not passing.`;
  } else if (answered > 0) {
    verdict = `Quiz in progress: ${answered} of ${total} answered.`;
  }

  return {
    version: 1,
    source: latestSubmission ? 'client' : 'server',
    status,
    passed,
    verdict,
    total,
    answered,
    remaining: total - answered,
    correct,
    incorrect,
    score: total ? Number((correct / total).toFixed(4)) : 0,
    profile: latestSubmission ? latestSubmission.profile : null,
    scenarios: results,
    updated_at: latestSubmission ? latestSubmission.updatedAt : null
  };
}

async function handleSnapshotPost(req, res) {
  try {
    const data = await readJsonBody(req);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      sendJson(res, 400, { error: 'A snapshot object is required' });
      return;
    }
    latestSubmission = {
      answers: Array.isArray(data.answers) ? data.answers : [],
      profile: data.profile && typeof data.profile === 'object' ? data.profile : null,
      stage: typeof data.stage === 'string' ? data.stage : null,
      updatedAt: new Date().toISOString()
    };
    sendJson(res, 200, { ok: true, snapshot: buildSnapshot() });
  } catch (error) {
    console.error('Failed to accept snapshot:', error);
    sendJson(res, 400, { error: 'Invalid JSON payload for snapshot' });
  }
}

// MIME types for different file extensions
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject'
};

// Get MIME type based on file extension
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return mimeTypes[ext] || 'text/plain';
}

// Serve static files
function serveFile(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
      return;
    }

    const mimeType = getMimeType(filePath);
    res.writeHead(200, { 'Content-Type': mimeType });
    res.end(data);
  });
}

// Handle POST requests
function handlePostRequest(req, res, parsedUrl) {
  if (parsedUrl.pathname === '/message') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const message = data.message;

        if (!message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Message is required' }));
          return;
        }

        // Check if WebSocket is available
        if (!isWebSocketAvailable) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'WebSocket functionality not available',
            details: 'Install the ws package with: npm install ws'
          }));
          return;
        }

        // Broadcast message to all connected WebSocket clients
        wsClients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'message', message: message }));
          }
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, clientCount: wsClients.size }));

      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  } else if (parsedUrl.pathname === '/snapshot') {
    handleSnapshotPost(req, res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

// Create HTTP server
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  let pathName = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;

  // Handle POST requests
  if (req.method === 'POST') {
    handlePostRequest(req, res, parsedUrl);
    return;
  }

  // The single endpoint an evaluator reads to get the graded state of the quiz.
  if (req.method === 'GET' && parsedUrl.pathname === '/snapshot') {
    try {
      sendJson(res, 200, buildSnapshot());
    } catch (error) {
      console.error('Failed to build snapshot:', error);
      sendJson(res, 500, { error: 'Failed to build snapshot' });
    }
    return;
  }

  // Serve scenario data for both dev and prod
  if (req.method === 'GET' && parsedUrl.pathname === '/api/scenarios') {
    try {
      const yamlData = fs.readFileSync(SCENARIOS_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/yaml' });
      res.end(yamlData);
    } catch (error) {
      console.error('Failed to read scenarios.yaml:', error);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Failed to load scenarios');
    }
    return;
  }

  // In production mode, serve static files from dist directory
  if (isProduction) {
    // Strip leading slashes so path.join/resolve can't ignore DIST_DIR
    let filePath = path.join(DIST_DIR, pathName.replace(/^\/+/, ''));

    // Security check - prevent directory traversal
    const resolvedDistDir = path.resolve(DIST_DIR);
    const resolvedFilePath = path.resolve(filePath);
    const relativePath = path.relative(resolvedDistDir, resolvedFilePath);

    // Reject if path tries to traverse outside the base directory
    if (relativePath.startsWith('..')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    serveFile(filePath, res);
  } else {
    // Development mode - static files are served by Vite
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found (development mode - use Vite dev server `npm run start:dev`)');
  }
});

// Create WebSocket server only if WebSocket is available
// Note: WebSocket upgrade handling is performed automatically by the ws library
// when attached to the HTTP server. The HTTP request handler should NOT send
// a response for upgrade requests - the ws library handles the upgrade internally.
if (isWebSocketAvailable) {
  const wss = new WebSocket.Server({
    server,
    path: '/ws'
  });

  wss.on('connection', (ws, req) => {
    console.log('New WebSocket client connected');
    wsClients.add(ws);

    ws.on('close', () => {
      console.log('WebSocket client disconnected');
      wsClients.delete(ws);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      wsClients.delete(ws);
    });
  });
}

// Start server
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Quiz state for evaluation: GET http://localhost:${PORT}/snapshot`);
  if (isProduction) {
    console.log(`Serving static files from: ${DIST_DIR}`);
  } else {
    console.log(`Development mode - static files served by Vite`);
  }
  if (isWebSocketAvailable) {
    console.log(`WebSocket server running on /ws`);
  } else {
    console.log(`WebSocket functionality disabled - install 'ws' package to enable`);
  }
  console.log('Press Ctrl+C to stop the server');
});

// Handle server errors
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Please try a different port.`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
