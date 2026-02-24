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

function personalizeScenario(value) {
  if (typeof value === 'string') {
    return personalizeText(value);
  }
  if (Array.isArray(value)) {
    return value.map(item => personalizeScenario(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, personalizeScenario(val)]));
  }
  return value;
}

function escapeAttribute(value = '') {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getAvatarColor(seed = '') {
  const palette = ['#1a73e8', '#e91e63', '#9c27b0', '#0097a7', '#388e3c', '#f57c00'];
  const normalized = seed || 'sender';
  const code = Array.from(normalized).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return palette[code % palette.length];
}

function formatEmailBody(text = '') {
  if (!text) {
    return '';
  }
  const blocks = text.split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
  const transformInline = block => {
    let html = escapeHTML(block);
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/_(.+?)_/g, '<em>$1</em>');
    html = html.replace(/\[(.+?)\]\((.+?)\)/g, (_match, label, href) => {
      const safeHref = escapeAttribute(href.trim());
      return `<a href="${safeHref}" class="gmail-link">${label}</a>`;
    });
    return html.replace(/\n/g, '<br />');
  };
  return blocks.map(block => `<p>${transformInline(block)}</p>`).join('');
}

function renderDocEmbed(docEmbed = {}) {
  if (!docEmbed.title || !docEmbed.url) {
    return '';
  }
  const type = (docEmbed.type || 'docs').toLowerCase();
  const iconLabel = type === 'sheets' ? 'Sheets' : 'Docs';
  const iconClass = type === 'sheets' ? 'sheets' : 'docs';
  const docTitle = escapeHTML(docEmbed.title);
  const docUrl = escapeAttribute(docEmbed.url);
  return `
    <div class="gmail-doc-card">
      <div class="gmail-doc-icon ${iconClass}" aria-hidden="true"></div>
      <div class="gmail-doc-copy">
        <div class="gmail-doc-title">${docTitle}</div>
        <a href="${docUrl}" class="gmail-doc-link">Open in ${iconLabel}</a>
      </div>
    </div>
  `;
}

const gmailToolbarIcons = [
  { type: 'back', label: 'Back to inbox' },
  { type: 'archive', label: 'Archive' },
  { type: 'delete', label: 'Delete' },
  { type: 'spam', label: 'Report spam' },
  { type: 'move', label: 'Move to' },
  { type: 'label', label: 'Labels' },
  { type: 'more', label: 'More options' }
];

function getToolbarIconSvg(type) {
  const svgAttrs = 'class="gmail-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"';
  switch (type) {
    case 'back':
      return `<svg ${svgAttrs}><polyline points="15 6 9 12 15 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></polyline></svg>`;
    case 'archive':
      return `<svg ${svgAttrs}><path d="M5 4h14l2 4H3l2-4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></path><rect x="4" y="8" width="16" height="11" rx="1" ry="1" fill="none" stroke="currentColor" stroke-width="1.6"></rect><line x1="9" y1="13" x2="15" y2="13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></line></svg>`;
    case 'delete':
      return `<svg ${svgAttrs}><rect x="7" y="8" width="10" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"></rect><line x1="5" y1="6" x2="19" y2="6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></line><line x1="10" y1="11" x2="10" y2="18" stroke="currentColor" stroke-width="1.6"></line><line x1="14" y1="11" x2="14" y2="18" stroke="currentColor" stroke-width="1.6"></line><line x1="9" y1="4" x2="15" y2="4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></line></svg>`;
    case 'spam':
      return `<svg ${svgAttrs}><polygon points="12 3 21 8 21 16 12 21 3 16 3 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></polygon><line x1="12" y1="9" x2="12" y2="14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></line><circle cx="12" cy="17" r="0.9" fill="currentColor"></circle></svg>`;
    case 'move':
      return `<svg ${svgAttrs}><path d="M4 7h6l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></path><polyline points="13 12 16 15 19 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></polyline></svg>`;
    case 'label':
      return `<svg ${svgAttrs}><path d="M4 7h10l6 5-6 5H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></path><circle cx="7" cy="12" r="1.4" fill="currentColor"></circle></svg>`;
    case 'more':
      return `<svg ${svgAttrs}><circle cx="12" cy="5" r="1.4" fill="currentColor"></circle><circle cx="12" cy="12" r="1.4" fill="currentColor"></circle><circle cx="12" cy="19" r="1.4" fill="currentColor"></circle></svg>`;
    case 'reply':
      return `<svg ${svgAttrs}><polyline points="13 7 8 12 13 17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></polyline><path d="M8 12h8a4 4 0 0 1 4 4v0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path></svg>`;
    case 'kebab':
      return `<svg ${svgAttrs}><circle cx="12" cy="6" r="1.2" fill="currentColor"></circle><circle cx="12" cy="12" r="1.2" fill="currentColor"></circle><circle cx="12" cy="18" r="1.2" fill="currentColor"></circle></svg>`;
    default:
      return '';
  }
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
  const recipientEmail = getProfileValue('email', 'you@company.com');
  const recipientLabel = recipientEmail === 'you@company.com' ? 'me' : recipientEmail;
  const avatarSeed = scenario.sender_name || scenario.sender_email || '?';
  const avatarInitial = avatarSeed.trim().charAt(0).toUpperCase() || '?';
  const avatarColor = getAvatarColor(avatarSeed);
  const detailRows = [
    {
      label: 'from',
      value: `${scenario.sender_name || 'Unknown sender'} <${scenario.sender_email || 'unknown@domain.com'}>`
    },
    { label: 'to', value: recipientEmail },
    { label: 'date', value: scenario.timestamp || '' }
  ];
  if (scenario.reply_to) {
    detailRows.push({ label: 'reply-to', value: scenario.reply_to });
  }
  if (scenario.mailed_by) {
    detailRows.push({ label: 'mailed-by', value: scenario.mailed_by });
  }
  if (scenario.signed_by) {
    detailRows.push({ label: 'signed-by', value: scenario.signed_by });
  }
  const detailMarkup = detailRows
    .map(row => `
      <div class="gmail-detail-row">
        <span class="gmail-detail-label">${escapeHTML(row.label)}</span>
        <span class="gmail-detail-value">${escapeHTML(row.value)}</span>
      </div>
    `)
    .join('');
  const bodyMarkup = formatEmailBody(scenario.body || '');
  const docEmbedMarkup = scenario.doc_embed ? renderDocEmbed(scenario.doc_embed) : '';
  const toolbarButtons = gmailToolbarIcons
    .map(icon => `<button type="button" class="gmail-toolbar-btn" title="${escapeHTML(icon.label)}">${getToolbarIconSvg(icon.type)}</button>`)
    .join('');
  return `
    <div class="scenario-view email-shell gmail-shell">
      <div class="gmail-toolbar" aria-hidden="true">
        ${toolbarButtons}
      </div>
      <div class="gmail-email">
        <div class="gmail-header">
          <h2 class="gmail-subject">${escapeHTML(scenario.subject || 'No subject')}</h2>
          <div class="gmail-sender-row">
            <div class="gmail-avatar" style="background:${avatarColor};">${escapeHTML(avatarInitial)}</div>
            <div class="gmail-sender-meta">
              <div class="gmail-sender-line">
                <strong>${escapeHTML(scenario.sender_name || 'Unknown sender')}</strong>
                <span class="gmail-sender-email">&lt;${escapeHTML(scenario.sender_email || 'unknown@domain.com')}&gt;</span>
                <span class="gmail-recipient">to ${escapeHTML(recipientLabel)}</span>
                ${scenario.preview_badge ? `<span class="gmail-badge">${escapeHTML(scenario.preview_badge)}</span>` : ''}
              </div>
              <div class="gmail-meta-row">
                <span class="gmail-timestamp">${escapeHTML(scenario.timestamp || '')}</span>
                <div class="gmail-meta-actions" aria-hidden="true">
                  <button type="button" class="gmail-icon-btn" title="Reply">${getToolbarIconSvg('reply')}</button>
                  <button type="button" class="gmail-icon-btn" title="More">${getToolbarIconSvg('kebab')}</button>
                </div>
              </div>
            </div>
          </div>
          <div class="gmail-header-details">
            <button type="button" class="email-details-toggle" aria-expanded="false">
              <span class="toggle-arrow">▾</span>
              <span class="toggle-text">Show details</span>
            </button>
            <div class="gmail-detail-grid">
              ${detailMarkup}
            </div>
          </div>
        </div>
        <div class="gmail-email-body js-email-body">
          ${bodyMarkup}
          ${docEmbedMarkup}
        </div>
        <div class="gmail-footer-actions" aria-hidden="true">
          <button type="button">Reply</button>
          <button type="button">Reply all</button>
          <button type="button">Forward</button>
        </div>
      </div>
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

  document.querySelectorAll('.js-email-body a').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
    });
  });

  document.querySelectorAll('.email-details-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const container = toggle.closest('.gmail-header-details');
      if (!container) {
        return;
      }
      const expanded = container.classList.toggle('expanded');
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      const text = toggle.querySelector('.toggle-text');
      if (text) {
        text.textContent = expanded ? 'Hide details' : 'Show details';
      }
    });
  });
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
