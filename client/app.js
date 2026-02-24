// app.js
import Modal from './design-system/components/modal/modal.js';

let websocket = null;
let helpModal = null;

const state = {
  scenarios: [],
  answers: [],
  currentIndex: 0,
  stage: 'loading',
  lastAnswer: null,
  errorMessage: '',
  hasLoggedSummary: false
};

const selectors = {
  appRoot: () => document.getElementById('app-root'),
  scenarioList: () => document.getElementById('scenario-list'),
  progressCount: () => document.getElementById('progress-count'),
  headerIndicator: () => document.getElementById('theme-indicator')
};

function escapeHTML(text = '') {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMultiline(text = '') {
  return escapeHTML(text).replace(/\n/g, '<br />');
}

async function loadScenarios() {
  try {
    const response = await fetch('./scenarios.yaml');
    if (!response.ok) {
      throw new Error(`Failed to load scenarios: ${response.status}`);
    }
    const yamlText = await response.text();
    const yamlLib = window.jsyaml;
    if (!yamlLib || typeof yamlLib.load !== 'function') {
      throw new Error('js-yaml library is not available.');
    }
    const parsed = yamlLib.load(yamlText);
    if (!Array.isArray(parsed)) {
      throw new Error('Scenario file must contain a list.');
    }
    state.scenarios = parsed;
    state.answers = new Array(parsed.length).fill(null);
    state.stage = 'welcome';
    state.hasLoggedSummary = false;
    state.currentIndex = 0;
    state.lastAnswer = null;
    state.errorMessage = '';
  } catch (error) {
    console.error('Unable to load scenarios:', error);
    state.stage = 'error';
    state.errorMessage = error.message || 'Unknown error loading scenarios.';
  }
}

function updateHeaderStatus() {
  const indicator = selectors.headerIndicator();
  if (!indicator) return;
  if (!state.scenarios.length) {
    indicator.textContent = 'Loading scenarios...';
    return;
  }
  if (state.stage === 'summary') {
    indicator.textContent = 'Training complete';
    return;
  }
  const currentNumber = Math.min(state.currentIndex + 1, state.scenarios.length);
  indicator.textContent = `Scenario ${currentNumber} of ${state.scenarios.length}`;
}

function getScenarioTitle(scenario) {
  if (scenario.interface === 'email') {
    return scenario.subject || `Email from ${scenario.sender_name || 'Unknown'}`;
  }
  if (scenario.interface === 'sms') {
    return `${scenario.sender_name || 'Unknown number'} text`;
  }
  if (scenario.interface === 'slack') {
    return scenario.channel || `Slack from ${scenario.sender_name || 'Teammate'}`;
  }
  return 'Scenario';
}

function updateSidebarProgress() {
  const list = selectors.scenarioList();
  const progressCount = selectors.progressCount();
  if (progressCount) {
    const answered = state.answers.filter(Boolean).length;
    progressCount.textContent = `${answered} / ${state.scenarios.length || 0}`;
  }
  if (!list) return;

  if (!state.scenarios.length) {
    list.innerHTML = '<li class="scenario-item">Loading...</li>';
    return;
  }

  const items = state.scenarios
    .map((scenario, index) => {
      const answer = state.answers[index];
      let statusLabel = 'Pending';
      let extraClass = '';
      if (answer) {
        statusLabel = answer.isCorrect ? 'Correct' : 'Review';
        extraClass = `completed ${answer.isCorrect ? 'correct' : 'incorrect'}`;
      } else if (index === state.currentIndex && (state.stage === 'question' || state.stage === 'result')) {
        statusLabel = 'In progress';
        extraClass = 'active';
      }
      return `<li class="scenario-item ${extraClass}">
        <span>${index + 1}. ${escapeHTML(getScenarioTitle(scenario))}</span>
        <span class="status-pill">${statusLabel}</span>
      </li>`;
    })
    .join('');

  list.innerHTML = items;
}

function renderLoadingCard() {
  return `
    <div class="app-card">
      <h2>Loading training scenarios...</h2>
      <p>Please wait while we load the phishing challenges.</p>
    </div>
  `;
}

function renderErrorCard(message) {
  return `
    <div class="app-card">
      <h2>Unable to load scenarios</h2>
      <p>${escapeHTML(message)}</p>
      <div class="app-actions">
        <button class="button button-primary" id="retry-loading">Retry</button>
      </div>
    </div>
  `;
}

function renderWelcomeCard() {
  return `
    <div class="app-card welcome-hero">
      <h2>Welcome to Can You Spot the Phish?</h2>
      <p>This simulator drops you into realistic inbox, SMS, and Slack views. For each message decide whether it is phishing or legitimate, then review the red flags that reveal the truth.</p>
      <ul>
        <li>6 scenarios | 2 per channel</li>
        <li>Serious tone, realistic stakes</li>
        <li>Instant coaching after every decision</li>
      </ul>
      <div class="app-actions">
        <button class="button button-primary" id="start-training">Begin Training</button>
      </div>
    </div>
  `;
}

function renderScenarioCard(scenario) {
  const { correct } = getScore();
  return `
    <div class="app-card">
      <div class="row-between">
        <div>
          <p class="body-small">${scenario.interface.toUpperCase()} | Scenario ${state.currentIndex + 1} of ${state.scenarios.length}</p>
          <h2>${escapeHTML(getScenarioTitle(scenario))}</h2>
        </div>
        <span class="score-pill">Score: ${correct}/${state.scenarios.length}</span>
      </div>
      ${renderInterfaceShell(scenario)}
      <p>Is this message a phishing attempt or a legitimate communication?</p>
      <div class="app-actions">
        <button class="button button-danger" id="btn-phishing">Phishing</button>
        <button class="button button-primary" id="btn-legit">Legit</button>
      </div>
    </div>
  `;
}

function renderResultCard(scenario) {
  const { lastAnswer } = state;
  if (!lastAnswer) {
    return '';
  }
  const correctLabel = scenario.is_phishing ? 'Phishing' : 'Legit';
  const userLabel = lastAnswer.userAnswer === 'phishing' ? 'Phishing' : 'Legit';
  const heading = lastAnswer.isCorrect ? 'Correct - great catch!' : 'Not quite.';
  const description = lastAnswer.isCorrect
    ? 'You spotted the right cues.'
    : 'Review the red flags so you can spot them next time.';
  const isLastScenario = state.currentIndex === state.scenarios.length - 1;

  return `
    <div class="app-card">
      <div class="result-callout">
        <h2>${heading}</h2>
        <p>${description}</p>
        <p><strong>Your answer:</strong> ${userLabel} | <strong>Correct answer:</strong> ${correctLabel}</p>
      </div>
      ${renderInterfaceShell(scenario)}
      <div>
        <h3>Red Flags</h3>
        ${renderRedFlags(scenario.red_flags)}
      </div>
      <div>
        <h3>Explanation</h3>
        <p>${escapeHTML(scenario.explanation || '')}</p>
      </div>
      <div class="app-actions">
        <button class="button button-secondary" id="review-again">Review Scenario Again</button>
        <button class="button button-primary" id="next-scenario">${isLastScenario ? 'View Final Score' : 'Next Scenario'}</button>
      </div>
    </div>
  `;
}

function renderSummaryCard() {
  const { correct, total } = getScore();
  const incorrect = total - correct;
  const percentage = total ? Math.round((correct / total) * 100) : 0;
  const resultsList = state.scenarios
    .map((scenario, index) => {
      const answer = state.answers[index];
      const isCorrect = Boolean(answer?.isCorrect);
      const statusClass = isCorrect ? 'correct' : 'incorrect';
      const label = isCorrect ? 'Correct' : 'Phishing cues missed';
      return `<li class="scenario-item completed ${statusClass}">
        <span>${index + 1}. ${escapeHTML(getScenarioTitle(scenario))}</span>
        <span class="status-pill">${label}</span>
      </li>`;
    })
    .join('');

  return `
    <div class="app-card">
      <h2>Training complete</h2>
      <p>You correctly identified <strong>${correct}</strong> out of <strong>${total}</strong> scenarios (${percentage}%).</p>
      <p>Incorrect: ${incorrect}</p>
      <h3>Scenario Breakdown</h3>
      <ul class="scenario-list">
        ${resultsList}
      </ul>
      <div class="app-actions">
        <button class="button button-primary" id="restart-training">Restart Training</button>
      </div>
    </div>
  `;
}

function renderRedFlags(redFlags = []) {
  if (!redFlags.length) {
    return '<p>No red flags recorded.</p>';
  }
  const items = redFlags.map(flag => `<li>${escapeHTML(flag)}</li>`).join('');
  return `<ul class="red-flags-list">${items}</ul>`;
}

function renderInterfaceShell(scenario) {
  switch (scenario.interface) {
    case 'email':
      return renderEmailShell(scenario);
    case 'sms':
      return renderSmsShell(scenario);
    case 'slack':
      return renderSlackShell(scenario);
    default:
      return '<div class="scenario-view"><p>Unsupported interface.</p></div>';
  }
}

function renderEmailShell(scenario) {
  return `
    <div class="scenario-view email-shell">
      <div class="email-toolbar">
        <span class="preview-badge">${escapeHTML(scenario.preview_badge || 'Inbox')}</span>
        <strong>${escapeHTML(scenario.subject || 'No subject')}</strong>
        <div class="spacer"></div>
        <span class="body-small">${escapeHTML(scenario.timestamp || '')}</span>
      </div>
      <div class="email-header">
        <div class="row-between">
          <div>
            <strong>${escapeHTML(scenario.sender_name || 'Unknown sender')}</strong>
            <div class="body-small">${escapeHTML(scenario.sender_email || '')}</div>
          </div>
          ${scenario.preview_badge ? `<span class="preview-badge">${escapeHTML(scenario.preview_badge)}</span>` : ''}
        </div>
      </div>
      <div class="email-body">${formatMultiline(scenario.body || '')}</div>
    </div>
  `;
}

function renderSmsShell(scenario) {
  return `
    <div class="scenario-view sms-shell">
      <div class="sms-header">
        <h3>${escapeHTML(scenario.sender_name || 'Unknown number')}</h3>
        <p class="body-small">${escapeHTML(scenario.timestamp || '')}</p>
      </div>
      <div class="sms-bubble sender">${formatMultiline(scenario.body || '')}</div>
    </div>
  `;
}

function renderSlackShell(scenario) {
  const initials = (scenario.avatar_initials || (scenario.sender_name || '?').substring(0, 2)).toUpperCase();
  return `
    <div class="scenario-view slack-shell">
      <div class="slack-topbar">
        <span class="slack-channel">${escapeHTML(scenario.channel || 'Direct message')}</span>
      </div>
      <div class="slack-message">
        <div class="slack-avatar">${escapeHTML(initials)}</div>
        <div class="slack-body">
          <div class="row-between" style="color:#f4f4f7;">
            <strong>${escapeHTML(scenario.sender_name || 'Teammate')}</strong>
            <span class="body-small">${escapeHTML(scenario.timestamp || '')}</span>
          </div>
          <div class="body-small" style="color:#cfd2ff;">@${escapeHTML(scenario.sender_handle || 'user')}</div>
          <p>${formatMultiline(scenario.body || '')}</p>
        </div>
      </div>
    </div>
  `;
}

function renderApp() {
  const root = selectors.appRoot();
  if (!root) {
    return;
  }
  let markup = '';
  switch (state.stage) {
    case 'loading':
      markup = renderLoadingCard();
      break;
    case 'error':
      markup = renderErrorCard(state.errorMessage || 'Unknown error');
      break;
    case 'welcome':
      markup = renderWelcomeCard();
      break;
    case 'question':
      markup = renderScenarioCard(state.scenarios[state.currentIndex]);
      break;
    case 'result':
      markup = renderResultCard(state.scenarios[state.currentIndex]);
      break;
    case 'summary':
      markup = renderSummaryCard();
      break;
    default:
      markup = renderLoadingCard();
  }
  root.innerHTML = markup;
  attachEventHandlers();
  updateSidebarProgress();
  updateHeaderStatus();
  if (state.stage === 'summary') {
    logQuizResult();
  }
}

function attachEventHandlers() {
  const startBtn = document.getElementById('start-training');
  if (startBtn) {
    startBtn.addEventListener('click', () => {
      state.stage = 'question';
      state.currentIndex = 0;
      renderApp();
    });
  }

  const retryBtn = document.getElementById('retry-loading');
  if (retryBtn) {
    retryBtn.addEventListener('click', async () => {
      state.stage = 'loading';
      renderApp();
      await loadScenarios();
      renderApp();
    });
  }

  const phishingBtn = document.getElementById('btn-phishing');
  const legitBtn = document.getElementById('btn-legit');
  if (phishingBtn) {
    phishingBtn.addEventListener('click', () => handleAnswer('phishing'));
  }
  if (legitBtn) {
    legitBtn.addEventListener('click', () => handleAnswer('legit'));
  }

  const reviewBtn = document.getElementById('review-again');
  if (reviewBtn) {
    reviewBtn.addEventListener('click', () => {
      state.stage = 'question';
      state.lastAnswer = null;
      renderApp();
    });
  }

  const nextBtn = document.getElementById('next-scenario');
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      if (state.currentIndex < state.scenarios.length - 1) {
        state.currentIndex += 1;
        state.stage = 'question';
      } else {
        state.stage = 'summary';
      }
      state.lastAnswer = null;
      renderApp();
    });
  }

  const restartBtn = document.getElementById('restart-training');
  if (restartBtn) {
    restartBtn.addEventListener('click', async () => {
      state.stage = 'loading';
      renderApp();
      await loadScenarios();
      renderApp();
    });
  }
}

function handleAnswer(choice) {
  try {
    const scenario = state.scenarios[state.currentIndex];
    const correctAnswer = scenario.is_phishing ? 'phishing' : 'legit';
    const isCorrect = choice === correctAnswer;
    state.answers[state.currentIndex] = {
      id: scenario.id,
      userAnswer: choice,
      isCorrect,
      correctAnswer
    };
    state.lastAnswer = { userAnswer: choice, isCorrect };
    state.stage = 'result';
    renderApp();
  } catch (error) {
    console.error('Error handling answer:', error);
  }
}

function getScore() {
  const total = state.scenarios.length;
  const answeredEntries = state.answers.filter(Boolean);
  const correct = answeredEntries.filter(entry => entry.isCorrect).length;
  return {
    total,
    correct
  };
}

function logQuizResult() {
  if (state.hasLoggedSummary) {
    return;
  }
  const { total, correct } = getScore();
  const payload = {
    total,
    correct,
    incorrect: total - correct,
    scenarios: state.scenarios.map((scenario, index) => {
      const answer = state.answers[index];
      return {
        id: scenario.id,
        user_answer: answer ? answer.userAnswer : null,
        correct: answer ? answer.isCorrect : false
      };
    }),
    verdict: `User completed the phishing quiz with ${correct}/${total} correct answers.`
  };
  console.log('QUIZ_RESULT: ' + JSON.stringify(payload, null, 2));
  state.hasLoggedSummary = true;
}

// Initialize WebSocket connection
function initializeWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const wsUrl = `${protocol}//${host}/ws`;

  try {
    websocket = new WebSocket(wsUrl);

    websocket.onopen = function() {
      console.log('WebSocket connected');
    };

    websocket.onmessage = function(event) {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'message' && data.message) {
          alert(data.message);
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    };

    websocket.onclose = function() {
      console.log('WebSocket disconnected');
      setTimeout(() => {
        console.log('Attempting to reconnect WebSocket...');
        initializeWebSocket();
      }, 3000);
    };

    websocket.onerror = function(error) {
      console.error('WebSocket error:', error);
    };
  } catch (error) {
    console.error('Failed to create WebSocket connection:', error);
  }
}

async function initializeHelpModal() {
  try {
    const response = await fetch('./help-content.html');
    const helpContent = await response.text();

    helpModal = Modal.createHelpModal({
      title: 'Help / User Guide',
      content: helpContent
    });

    const helpButton = document.getElementById('btn-help');
    if (helpButton) {
      helpButton.addEventListener('click', () => {
        helpModal.open();
      });
    }
  } catch (error) {
    console.error('Failed to load help content:', error);
    helpModal = Modal.createHelpModal({
      title: 'Help / User Guide',
      content: '<p>Help content could not be loaded. Please check that help-content.html exists.</p>'
    });
    const helpButton = document.getElementById('btn-help');
    if (helpButton) {
      helpButton.addEventListener('click', () => helpModal.open());
    }
  }
}

async function initialize() {
  const root = selectors.appRoot();
  if (root) {
    root.innerHTML = renderLoadingCard();
  }
  await initializeHelpModal();
  await loadScenarios();
  renderApp();
  initializeWebSocket();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
