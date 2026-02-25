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
  },
  profileValidation: {
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

function isValidEmail(value = '') {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(trimmed)) {
    return false;
  }
  if (trimmed.includes('..')) {
    return false;
  }
  const [, domain = ''] = trimmed.split('@');
  if (domain.startsWith('.') || domain.endsWith('.')) {
    return false;
  }
  return true;
}

function validateProfileInput(name = '', email = '') {
  const nextErrors = { name: '', email: '' };
  if (!name.trim()) {
    nextErrors.name = 'Name is required.';
  }
  if (!email.trim()) {
    nextErrors.email = 'Email is required.';
  } else if (!isValidEmail(email)) {
    nextErrors.email = 'Use a valid email format, like name@gmail.com.';
  }
  return nextErrors;
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

function resetQuizWithScenarios(nextScenarios = [], options = {}) {
  const { skipWelcome = false } = options;
  state.scenarios = nextScenarios;
  state.answers = new Array(nextScenarios.length).fill(null);
  state.stage = skipWelcome ? 'question' : 'welcome';
  state.hasLoggedSummary = false;
  state.currentIndex = 0;
  state.lastAnswer = null;
  state.errorMessage = '';
  state.profileValidation = { name: '', email: '' };
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
      const hrefValue = href.trim();
      const safeHref = escapeAttribute(hrefValue);
      const safeLabel = escapeHTML(label.trim());
      return `<span class="gmail-link-wrap"><a href="${safeHref}" class="gmail-link" data-link-preview="${safeHref}">${safeLabel}</a></span>`;
    });
    return html.replace(/\n/g, '<br />');
  };
  return blocks.map(block => `<p>${transformInline(block)}</p>`).join('');
}

function formatSlackBody(text = '') {
  if (!text) {
    return '';
  }
  let html = escapeHTML(text);
  html = html.replace(/(^|\s)@([a-zA-Z0-9._-]+)/g, (_match, prefix, handle) => `${prefix}<span class="slack-mention">@${handle}</span>`);
  html = html.replace(/(https?:\/\/[^\s<]+)/g, url => {
    const safeHref = escapeAttribute(url);
    let hostname = 'link';
    try {
      hostname = new URL(url).hostname.replace(/^www\./i, '');
    } catch (_error) {
      hostname = 'link';
    }
    return `<a href="${safeHref}" class="slack-link" data-domain="${escapeAttribute(hostname)}">${escapeHTML(url)}</a>`;
  });
  return html.replace(/\n/g, '<br />');
}

function formatSmsBody(text = '') {
  if (!text) {
    return '';
  }
  let html = escapeHTML(text);
  html = html.replace(/(https?:\/\/[^\s<]+)/g, url => {
    const safeHref = escapeAttribute(url);
    return `<a href="${safeHref}" class="sms-link" data-link-preview="${safeHref}">${escapeHTML(url)}</a>`;
  });
  return html.replace(/\n/g, '<br />');
}

function getSmsMeta(scenario) {
  const sender = scenario.sender_name || 'Unknown number';
  const senderNumber = scenario.sender_number || '';
  const carrier = scenario.carrier || 'Text Message';
  return {
    sender,
    senderNumber,
    carrier
  };
}

function renderSlackAttachment(attachment = {}) {
  if (!attachment.title || !attachment.url) {
    return '';
  }
  const domain = attachment.domain || (() => {
    try {
      return new URL(attachment.url).hostname;
    } catch (_error) {
      return '';
    }
  })();
  return `
    <div class="slack-attachment">
      ${attachment.tag ? `<span class="slack-attachment-tag">${escapeHTML(attachment.tag)}</span>` : ''}
      <a href="${escapeAttribute(attachment.url)}" class="slack-attachment-title">${escapeHTML(attachment.title)}</a>
      ${attachment.description ? `<p>${escapeHTML(attachment.description)}</p>` : ''}
      ${domain ? `<span class="slack-attachment-domain">${escapeHTML(domain)}</span>` : ''}
    </div>
  `;
}

function renderSlackReactions(reactions = []) {
  if (!Array.isArray(reactions) || !reactions.length) {
    return '';
  }
  const items = reactions
    .map(reaction => `
      <button type="button" class="slack-reaction${reaction.selected ? ' selected' : ''}" aria-label="Reaction ${escapeHTML(reaction.emoji || '')}">
        <span>${escapeHTML(reaction.emoji || '')}</span>
        <span>${escapeHTML(String(reaction.count ?? 1))}</span>
      </button>
    `)
    .join('');
  return `<div class="slack-reactions">${items}</div>`;
}

function renderSlackThreadFooter(scenario) {
  if (!scenario.thread_replies) {
    return '';
  }
  const repliesText = `${scenario.thread_replies} repl${scenario.thread_replies === 1 ? 'y' : 'ies'}`;
  const lastReply = scenario.thread_last_reply ? `Last reply ${escapeHTML(scenario.thread_last_reply)}` : '';
  return `
    <div class="slack-thread-row">
      <span class="slack-thread-link">${escapeHTML(repliesText)}</span>
      ${lastReply ? `<span class="slack-thread-meta">${lastReply}</span>` : ''}
    </div>
  `;
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
        <a href="${docUrl}" class="gmail-doc-link" data-link-preview="${docUrl}">Open in ${iconLabel}</a>
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
    case 'star':
      return `<svg ${svgAttrs}><polygon points="12 3.8 14.8 9.3 20.8 10.2 16.4 14.4 17.4 20.2 12 17.4 6.6 20.2 7.6 14.4 3.2 10.2 9.2 9.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></polygon></svg>`;
    case 'print':
      return `<svg ${svgAttrs}><rect x="7" y="4.5" width="10" height="4" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"></rect><rect x="6" y="14" width="12" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"></rect><rect x="4" y="9" width="16" height="6" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"></rect></svg>`;
    case 'open':
      return `<svg ${svgAttrs}><path d="M14 5h5v5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path><path d="M10 14 19 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path><rect x="5" y="9" width="10" height="10" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.6"></rect></svg>`;
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
    resetQuizWithScenarios(parsed);
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

function getScenarioPromptCopy(scenario) {
  switch (scenario.interface) {
    case 'email':
      if (scenario.subject) {
        return `Inbox alert: ${scenario.subject}`;
      }
      return `You got a new email from ${scenario.sender_name || scenario.sender_email || 'a contact'}`;
    case 'sms':
      return `New text from ${scenario.sender_name || 'an unknown number'}`;
    case 'slack':
      if (scenario.channel) {
        return `You were pinged in ${scenario.channel}`;
      }
      return `New Slack message from ${scenario.sender_name || 'a teammate'}`;
    default:
      return 'Incoming message';
  }
}

function summarizeExplanation(text = '') {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }
  const sentenceMatch = trimmed.match(/[^.!?]+[.!?]/);
  if (sentenceMatch) {
    return sentenceMatch[0].trim();
  }
  return trimmed;
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
  const nameError = state.profileValidation.name || '';
  const emailError = state.profileValidation.email || '';
  const nameInputClass = `landing-input${nameError ? ' invalid' : ''}`;
  const emailInputClass = `landing-input${emailError ? ' invalid' : ''}`;
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
          class="${nameInputClass}"
          placeholder="First name (e.g., Alex)"
          aria-label="First name"
          autocomplete="given-name"
          value="${nameValue}"
          required
          aria-invalid="${nameError ? 'true' : 'false'}"
        />
        ${nameError ? `<p class="landing-error" role="alert">${escapeHTML(nameError)}</p>` : ''}
        <input
          type="email"
          id="participant-email"
          name="participant-email"
          class="${emailInputClass}"
          placeholder="Email (e.g., alex@example.com)"
          inputmode="email"
          aria-label="Email"
          autocomplete="email"
          value="${emailValue}"
          required
          aria-invalid="${emailError ? 'true' : 'false'}"
        />
        ${emailError ? `<p class="landing-error" role="alert">${escapeHTML(emailError)}</p>` : ''}
        <p class="landing-hint">Please enter your name and a valid email address to personalize the training scenarios.</p>
        <button class="button landing-cta" type="submit">Take the Quiz</button>
      </form>
    </div>
  `;
}

function renderProgressRail() {
  const dots = state.scenarios
    .map((_scenario, index) => {
      const isCurrent = index === state.currentIndex && (state.stage === 'question' || state.stage === 'result');
      const answer = state.answers[index];
      const classes = ['progress-dot'];
      let status = 'upcoming';
      if (answer?.isCorrect === true) {
        status = 'correct';
      } else if (answer?.isCorrect === false) {
        status = 'incorrect';
      } else if (index < state.currentIndex) {
        status = 'visited';
      }
      if (isCurrent) {
        if (status === 'correct') {
          status = 'current-correct';
        } else if (status === 'incorrect') {
          status = 'current-incorrect';
        } else {
          status = 'current';
        }
      }
      classes.push(`status-${status}`);
      return `<span class="${classes.join(' ')}" aria-hidden="true"></span>`;
    })
    .join('');
  return `
    <div class="scenario-progress-rail" aria-label="Scenario progress">
      ${dots}
    </div>
  `;
}

function renderScenarioCard(scenario) {
  const personalizedScenario = personalizeScenario(scenario);
  const promptCopy = escapeHTML(getScenarioPromptCopy(personalizedScenario));
  return `
    <div class="app-card scenario-card">
      ${renderProgressRail()}
      <p class="scenario-prompt">${promptCopy}</p>
      <div class="scenario-action-bar app-actions">
        <button class="button button-danger" id="btn-phishing">Phishing</button>
        <button class="button button-primary" id="btn-legit">Legit</button>
      </div>
      ${renderInterfaceShell(personalizedScenario)}
    </div>
  `;
}

function renderResultCard(scenario) {
  const { lastAnswer } = state;
  if (!lastAnswer) {
    return '';
  }
  const personalizedScenario = personalizeScenario(scenario);
  const heading = lastAnswer.isCorrect ? 'Correct!' : 'Not quite.';
  const isLastScenario = state.currentIndex === state.scenarios.length - 1;
  const signals = Array.isArray(personalizedScenario.red_flags) ? personalizedScenario.red_flags : [];
  const keySignals = signals
    .map(flag => flag.trim())
    .filter(Boolean)
    .slice(0, 2);
  const signalsSummary = keySignals.length
    ? keySignals.join(' • ')
    : scenario.is_phishing
      ? 'No obvious phishing cues listed.'
      : 'No red flags noted in this scenario.';
  const explanationSummary = summarizeExplanation(personalizedScenario.explanation || '');
  const insightHeading = scenario.is_phishing ? "Why it's phishing" : "Why it's safe";

  return `
    <div class="app-card scenario-card result-card">
      ${renderProgressRail()}
      <div class="result-callout" data-state="${lastAnswer.isCorrect ? 'correct' : 'incorrect'}">
        <h2>${heading}</h2>
      </div>
      <div class="result-insight">
        <p class="insight-heading">${escapeHTML(insightHeading)}</p>
        <p class="insight-signals">${escapeHTML(signalsSummary)}</p>
        ${explanationSummary ? `<p class="insight-note">${escapeHTML(explanationSummary)}</p>` : ''}
      </div>
      <div class="scenario-action-bar app-actions result-actions">
        <button class="button button-secondary" id="review-again">Review Scenario</button>
        <button class="button button-primary" id="next-scenario">${isLastScenario ? 'View Final Score' : 'Next Scenario'}</button>
      </div>
      ${renderInterfaceShell(personalizedScenario)}
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
  const recipientLabel = 'me';
  const avatarSeed = scenario.sender_name || scenario.sender_email || '?';
  const avatarInitial = avatarSeed.trim().charAt(0).toUpperCase() || '?';
  const avatarColor = getAvatarColor(avatarSeed);
  const senderEmailDisplay = scenario.sender_email || 'unknown@domain.com';
  const detailRows = [
    {
      label: 'from',
      value: `${scenario.sender_name || 'Unknown sender'} <${scenario.sender_email || 'unknown@domain.com'}>`
    },
    { label: 'to', value: recipientEmail },
    { label: 'date', value: scenario.timestamp || '' },
    { label: 'subject', value: scenario.subject || 'No subject' }
  ];
  if (scenario.reply_to && scenario.reply_to !== scenario.sender_email) {
    detailRows.push({ label: 'reply-to', value: scenario.reply_to });
  }
  if (scenario.mailed_by) {
    detailRows.push({ label: 'mailed-by', value: scenario.mailed_by });
  }
  if (scenario.signed_by) {
    detailRows.push({ label: 'signed-by', value: scenario.signed_by });
  }
  if (scenario.mailing_list) {
    detailRows.push({ label: 'mailing list', value: scenario.mailing_list });
  }
  detailRows.push({ label: 'security', value: scenario.security || 'Standard encryption (TLS)' });
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
  const detailsId = `gmail-details-${escapeAttribute(scenario.id || 'email')}`;
  return `
    <div class="scenario-view email-shell gmail-shell">
      <div class="gmail-toolbar" aria-hidden="true">
        ${toolbarButtons}
      </div>
      <div class="gmail-email">
        <div class="gmail-header">
          <div class="gmail-subject-row">
            <h2 class="gmail-subject">${escapeHTML(scenario.subject || 'No subject')}</h2>
            <div class="gmail-subject-actions" aria-hidden="true">
              <button type="button" class="gmail-icon-btn" title="Star">${getToolbarIconSvg('star')}</button>
              <button type="button" class="gmail-icon-btn" title="Print">${getToolbarIconSvg('print')}</button>
              <button type="button" class="gmail-icon-btn" title="Open in new window">${getToolbarIconSvg('open')}</button>
            </div>
          </div>
          <div class="gmail-sender-row">
            <div class="gmail-sender-left">
              <div class="gmail-avatar" style="background:${avatarColor};">${escapeHTML(avatarInitial)}</div>
              <div class="gmail-sender-meta">
                <div class="gmail-sender-line">
                  <strong>${escapeHTML(scenario.sender_name || 'Unknown sender')}</strong>
                  <span class="gmail-sender-email">&lt;${escapeHTML(senderEmailDisplay)}&gt;</span>
                </div>
                <div class="gmail-recipient-line">
                  <button type="button" class="gmail-recipient-toggle email-details-toggle" title="Show details" aria-expanded="false" data-details-id="${detailsId}">
                    to ${recipientLabel} <span class="toggle-arrow">▾</span>
                  </button>
                </div>
              </div>
            </div>
            <div class="gmail-sender-right">
              <span class="gmail-timestamp">${escapeHTML(scenario.timestamp || '')}</span>
              <div class="gmail-meta-actions" aria-hidden="true">
                <button type="button" class="gmail-icon-btn" title="Reply">${getToolbarIconSvg('reply')}</button>
                <button type="button" class="gmail-icon-btn" title="More">${getToolbarIconSvg('kebab')}</button>
              </div>
            </div>
          </div>
          <div id="${detailsId}" class="gmail-header-details">
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
        <div class="gmail-link-preview" aria-live="polite"></div>
      </div>
    </div>
  `;
}

function renderSmsShell(scenario) {
  const smsMeta = getSmsMeta(scenario);
  const messageTime = scenario.timestamp || '';
  const threadTimestamp = scenario.thread_timestamp || 'Today';
  const senderLabel = smsMeta.senderNumber
    ? `${smsMeta.sender} (${smsMeta.senderNumber})`
    : smsMeta.sender;
  return `
    <div class="scenario-view sms-shell">
      <div class="sms-phone-frame">
        <div class="sms-topbar" aria-hidden="true">
          <span class="sms-top-action">Messages</span>
          <div class="sms-contact-meta">
            <strong>${escapeHTML(senderLabel)}</strong>
            <span>${escapeHTML(smsMeta.carrier)}</span>
          </div>
          <span class="sms-top-action">Details</span>
        </div>
        <div class="sms-thread">
          <div class="sms-thread-timestamp">${escapeHTML(threadTimestamp)}</div>
          <div class="sms-message-row incoming">
            <div class="sms-bubble sender js-sms-body">${formatSmsBody(scenario.body || '')}</div>
          </div>
          ${messageTime ? `<div class="sms-delivery-time">${escapeHTML(messageTime)}</div>` : ''}
        </div>
        <div class="sms-composer" aria-hidden="true">
          <span class="sms-compose-placeholder">iMessage</span>
          <button type="button" class="sms-send-button">↑</button>
        </div>
      </div>
    </div>
  `;
}

function renderSlackShell(scenario) {
  const initials = (scenario.avatar_initials || (scenario.sender_name || '?').substring(0, 2)).toUpperCase();
  const avatarColor = scenario.avatar_color || getAvatarColor(scenario.sender_name || scenario.sender_handle || 'slack');
  const memberCount = scenario.channel_members ? `${scenario.channel_members} members` : '';
  const senderBadge = scenario.is_bot ? '<span class="slack-sender-badge">APP</span>' : '';
  const verificationBadge = scenario.verified_app ? '<span class="slack-verified-badge">Verified</span>' : '';
  const externalBadge = scenario.external_org ? `<span class="slack-external-badge">${escapeHTML(scenario.external_org)}</span>` : '';
  const editedLabel = scenario.edited ? '<span class="slack-edited">(edited)</span>' : '';
  const attachmentMarkup = renderSlackAttachment(scenario.attachment || {});
  const reactionsMarkup = renderSlackReactions(scenario.reactions || []);
  const threadFooterMarkup = renderSlackThreadFooter(scenario);
  return `
    <div class="scenario-view slack-shell">
      <div class="slack-frame">
        <aside class="slack-sidebar" aria-hidden="true">
          <div class="slack-workspace">${escapeHTML(scenario.workspace || 'Company Workspace')}</div>
          <div class="slack-sidebar-group">
            <span class="slack-sidebar-title">Channels</span>
            <div class="slack-sidebar-item"># announcements</div>
            <div class="slack-sidebar-item active">${escapeHTML(scenario.channel || '#general')}</div>
            <div class="slack-sidebar-item"># help-it</div>
          </div>
          <div class="slack-sidebar-group">
            <span class="slack-sidebar-title">Direct messages</span>
            <div class="slack-sidebar-item">@${escapeHTML(scenario.sender_handle || 'user')}</div>
          </div>
        </aside>
        <div class="slack-main">
          <div class="slack-topbar">
            <div class="slack-channel-wrap">
              <span class="slack-channel">${escapeHTML(scenario.channel || 'Direct message')}</span>
              ${memberCount ? `<span class="slack-channel-meta">${escapeHTML(memberCount)}</span>` : ''}
            </div>
            <div class="slack-top-actions" aria-hidden="true">⌕ ⓘ</div>
          </div>
          <div class="slack-message">
            <div class="slack-avatar" style="background:${escapeAttribute(avatarColor)};">${escapeHTML(initials)}</div>
            <div class="slack-body">
              <div class="slack-sender-row">
                <strong>${escapeHTML(scenario.sender_name || 'Teammate')}</strong>
                ${senderBadge}
                ${verificationBadge}
                ${externalBadge}
                <span class="body-small slack-timestamp">${escapeHTML(scenario.timestamp || '')}</span>
              </div>
              <div class="body-small slack-handle">@${escapeHTML(scenario.sender_handle || 'user')}</div>
              <p class="js-slack-body">${formatSlackBody(scenario.body || '')} ${editedLabel}</p>
              ${attachmentMarkup}
              ${reactionsMarkup}
              ${threadFooterMarkup}
            </div>
          </div>
          <div class="slack-composer" aria-hidden="true">
            <span>Message ${escapeHTML(scenario.channel || '#channel')}</span>
          </div>
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
      const nextName = (formData.get('participant-name') || '').toString().trim();
      const nextEmail = (formData.get('participant-email') || '').toString().trim();
      const nextValidation = validateProfileInput(nextName, nextEmail);
      state.profileValidation = nextValidation;
      state.profile.name = nextName;
      state.profile.email = nextEmail;
      if (nextValidation.name || nextValidation.email) {
        renderApp();
        return;
      }
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
    restartBtn.addEventListener('click', () => {
      resetQuizWithScenarios([...state.scenarios], { skipWelcome: true });
      renderApp();
    });
  }

  document.querySelectorAll('.js-email-body a').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
    });
  });

  const gmailLinkPreview = document.querySelector('.gmail-link-preview');
  if (gmailLinkPreview) {
    const showPreview = href => {
      if (!href) {
        return;
      }
      gmailLinkPreview.textContent = href;
      gmailLinkPreview.classList.add('visible');
    };
    const hidePreview = () => {
      gmailLinkPreview.textContent = '';
      gmailLinkPreview.classList.remove('visible');
    };
    document.querySelectorAll('.js-email-body a[data-link-preview]').forEach(link => {
      const href = link.getAttribute('data-link-preview') || '';
      link.addEventListener('mouseenter', () => showPreview(href));
      link.addEventListener('focus', () => showPreview(href));
      link.addEventListener('mouseleave', hidePreview);
      link.addEventListener('blur', hidePreview);
    });
  }

  document.querySelectorAll('.js-slack-body a, .slack-attachment a').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
    });
  });

  document.querySelectorAll('.js-sms-body a').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
    });
  });

  document.querySelectorAll('.email-details-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const detailsId = toggle.getAttribute('data-details-id');
      const container = detailsId ? document.getElementById(detailsId) : toggle.closest('.gmail-header-details');
      if (!container) {
        return;
      }
      const expanded = !container.classList.contains('expanded');
      container.classList.toggle('expanded', expanded);
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      toggle.setAttribute('title', expanded ? 'Hide details' : 'Show details');
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
