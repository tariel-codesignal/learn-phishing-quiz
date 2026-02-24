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
  hasLoggedSummary: false,
  profile: {
    name: '',
    email: ''
  }
};

const selectors = {
  appRoot: () => document.getElementById('app-root'),
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

function getProfileValue(key, fallback) {
  const value = (state.profile[key] || '').trim();
  return value || fallback;
}

function personalizeText(text = '') {
  if (typeof text !== 'string') {
    return text;
  }
  const replacements = {
    name: getProfileValue('name', 'you'),
    email: getProfileValue('email', 'you@company.com')
  };
  return text
    .replace(/{{\s*name\s*}}/gi, replacements.name)
    .replace(/{{\s*email\s*}}/gi, replacements.email);
}

function personalizeScenario(scenario = {}) {
  const personalized = { ...scenario };
  Object.entries(personalized).forEach(([key, value]) => {
    if (typeof value === 'string') {
      personalized[key] = personalizeText(value);
    } else if (Array.isArray(value)) {
      personalized[key] = value.map(item => (typeof item === 'string' ? personalizeText(item) : item));
    }
  });
  return personalized;
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
  if (state.stage === 'welcome') {
    indicator.textContent = 'Briefing: enter your info to begin';
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
  const scenarioCount = state.scenarios.length || 0;
  const scenarioLabel = scenarioCount ? `${scenarioCount} quick scenarios` : 'a quick set of scenarios';
  const nameValue = escapeHTML(state.profile.name || '');
  const emailValue = escapeHTML(state.profile.email || '');
  return `
    <div class="app-card welcome-hero">
      <div class="welcome-copy">
        <h2 class="welcome-headline">Can you spot a phishing attack?</h2>
        <p class="welcome-subtext">Phishing is the #1 cause of data breaches. Test yourself in ${scenarioLabel}.</p>
      </div>
      <form id="quiz-intro-form" class="landing-form" novalidate>
        <input
          type="text"
          id="participant-name"
          name="participant-name"
          class="landing-input"
          placeholder="First name"
          aria-label="First name"
          value="${nameValue}"
        />
        <input
          type="text"
          id="participant-email"
          name="participant-email"
          class="landing-input"
          placeholder="Email"
          inputmode="email"
          aria-label="Email"
          value="${emailValue}"
        />
        <p class="landing-hint">We only use this to personalize each message.</p>
        <button class="button landing-cta" type="submit">Take the Quiz</button>
      </form>
    </div>
  `;
}

function renderScenarioCard(scenario) {
  const personalizedScenario = personalizeScenario(scenario);
  const { correct } = getScore();
  return `
    <div class="app-card">
      <div class="row-between">
        <div class="quiz-meta">
          <p class="body-small scenario-stage">${personalizedScenario.interface.toUpperCase()} SIMULATION</p>
          <h2>${escapeHTML(getScenarioTitle(personalizedScenario))}</h2>
          <p>Scenario ${state.currentIndex + 1} of ${state.scenarios.length}</p>
        </div>
        <span class="score-pill">Score: ${correct}/${state.scenarios.length}</span>
      </div>
      ${renderInterfaceShell(personalizedScenario)}
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
  const personalizedScenario = personalizeScenario(scenario);
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
      ${renderInterfaceShell(personalizedScenario)}
      <div>
        <h3>Red Flags</h3>
        ${renderRedFlags(personalizedScenario.red_flags)}
      </div>
      <div>
        <h3>Explanation</h3>
        <p>${escapeHTML(personalizedScenario.explanation || '')}</p>
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
      const personalized = personalizeScenario(scenario);
      const answer = state.answers[index];
      const isCorrect = Boolean(answer?.isCorrect);
      const statusClass = isCorrect ? 'correct' : 'incorrect';
      const label = isCorrect ? 'Correct' : 'Phishing cues missed';
      return `<li class="scenario-item completed ${statusClass}">
        <span>${index + 1}. ${escapeHTML(getScenarioTitle(personalized))}</span>
        <span class="status-pill">${label}</span>
      </li>`;
    })
    .join('');

  return `
    <div class="app-card summary-card">
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
  const recipientEmail = escapeHTML(getProfileValue('email', 'you@company.com'));
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
        <div class="email-recipient body-small">To: ${recipientEmail}</div>
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
  root.setAttribute('data-stage', state.stage);
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
  updateHeaderStatus();
  if (state.stage === 'summary') {
    logQuizResult();
  }
}

function attachEventHandlers() {
  const introForm = document.getElementById('quiz-intro-form');
  if (introForm) {
    introForm.addEventListener('submit', event => {
      event.preventDefault();
      const formData = new FormData(introForm);
      state.profile.name = (formData.get('participant-name') || '').toString().trim();
      state.profile.email = (formData.get('participant-email') || '').toString().trim();
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
