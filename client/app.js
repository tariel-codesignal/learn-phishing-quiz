// app.js

// Bundled by Vite so the sim never depends on a CDN reaching the learner's browser.
import { load as loadYamlDocument } from 'js-yaml';

let websocket = null;

// Fixed persona for every learner - no form, no PII collection.
const DEFAULT_PROFILE = {
  name: 'Signalite',
  email: 'signalite@codesignal.com'
};

const SNAPSHOT_DEBOUNCE_MS = 250;
let snapshotTimer = null;

const PROGRESS_STORAGE_KEY = 'codesignal-phishing-quiz-progress';
const PROGRESS_STORAGE_VERSION = 1;
const PERSISTED_STAGES = ['welcome', 'question', 'result', 'summary'];

const state = {
  scenarios: [],
  answers: [],
  currentIndex: 0,
  stage: 'loading',
  lastAnswer: null,
  errorMessage: '',
  hasLoggedSummary: false,
  profile: { ...DEFAULT_PROFILE },
  reviewingFromSummary: false
};

// Answers live in memory, so without this a reload would lose the learner's progress
// and republish a "not started" snapshot over a finished one.
function getScenarioSignature(scenarios = []) {
  return scenarios.map(scenario => scenario.id).join('|');
}

function saveProgress() {
  try {
    window.localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify({
      version: PROGRESS_STORAGE_VERSION,
      signature: getScenarioSignature(state.scenarios),
      stage: state.stage,
      currentIndex: state.currentIndex,
      answers: state.answers.map(answer => (answer ? { userAnswer: answer.userAnswer } : null))
    }));
  } catch (error) {
    // Disabled storage, private browsing, or quota exceeded: progress simply won't survive a reload.
    console.warn('Unable to save quiz progress:', error);
  }
}

function readSavedProgress(scenarios = []) {
  try {
    const raw = window.localStorage.getItem(PROGRESS_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const snapshot = JSON.parse(raw);
    if (!snapshot || snapshot.version !== PROGRESS_STORAGE_VERSION) {
      return null;
    }
    // Editing scenarios.yaml invalidates saved progress rather than restoring it onto the wrong quiz.
    if (snapshot.signature !== getScenarioSignature(scenarios)) {
      return null;
    }
    if (!Array.isArray(snapshot.answers) || snapshot.answers.length !== scenarios.length) {
      return null;
    }
    if (!PERSISTED_STAGES.includes(snapshot.stage)) {
      return null;
    }
    return snapshot;
  } catch (error) {
    console.warn('Unable to read saved quiz progress:', error);
    return null;
  }
}

const selectors = {
  appRoot: () => document.getElementById('app-root'),
  headerIndicator: () => document.getElementById('theme-indicator')
};

const landingIntros = [
  {
    headline: 'Can you spot the threats before they land?',
    sub: 'New scenarios. Stay sharp.'
  },
  {
    headline: 'Time to test your instincts.',
    sub: 'Phishing attacks are getting smarter. Are you?'
  },
  {
    headline: 'Another round. Threats are getting smarter.',
    sub: 'Think you can spot them all this time?'
  },
  {
    headline: 'Your next scenario set is ready.',
    sub: 'Can you tell the real from the fake?'
  },
  {
    headline: "Stay sharp. Attackers don't take breaks.",
    sub: 'New scenarios are waiting.'
  }
];

const selectedLandingIntro = landingIntros[Math.floor(Math.random() * landingIntros.length)];

function escapeHTML(text = '') {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeBasicEntities(value = '') {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function formatMultiline(text = '') {
  return escapeHTML(text).replace(/\n/g, '<br />');
}

function applyInlineMarkdown(text = '', options = {}) {
  if (!text) {
    return '';
  }
  const renderLink = typeof options.renderLink === 'function'
    ? options.renderLink
    : ((href, labelHTML) => `<a href="${href}" class="sim-link">${labelHTML}</a>`);
  const placeholderStart = index => `%%MDLINKSTART${index}%%`;
  const placeholderEnd = index => `%%MDLINKEND${index}%%`;
  const links = [];
  let working = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
    const index = links.length;
    links.push({ href: (href || '').trim() });
    return `${placeholderStart(index)}${label}${placeholderEnd(index)}`;
  });
  let html = escapeHTML(working);
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');
  links.forEach((link, index) => {
    const startToken = placeholderStart(index);
    const endToken = placeholderEnd(index);
    const pattern = new RegExp(`${startToken}(.*?)${endToken}`, 'gs');
    html = html.replace(pattern, (_placeholder, innerHTML) => {
      const hrefValue = link.href || '#';
      const safeHref = escapeAttribute(hrefValue);
      return renderLink(safeHref, innerHTML);
    });
  });
  return html;
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

function resetQuizWithScenarios(nextScenarios = [], options = {}) {
  const { skipWelcome = false } = options;
  state.scenarios = nextScenarios;
  state.answers = new Array(nextScenarios.length).fill(null);
  state.stage = skipWelcome ? 'question' : 'welcome';
  state.hasLoggedSummary = false;
  state.currentIndex = 0;
  state.lastAnswer = null;
  state.errorMessage = '';
  state.reviewingFromSummary = false;
}

function restoreQuizFromProgress(nextScenarios, snapshot) {
  state.scenarios = nextScenarios;
  // Grades are recomputed from scenarios.yaml rather than trusted from storage, so edited
  // or stale localStorage can't fake a pass.
  state.answers = nextScenarios.map((scenario, index) => {
    const saved = snapshot.answers[index];
    const userAnswer = saved && saved.userAnswer;
    if (userAnswer !== 'phishing' && userAnswer !== 'legit') {
      return null;
    }
    const correctAnswer = scenario.is_phishing ? 'phishing' : 'legit';
    return {
      id: scenario.id,
      userAnswer,
      isCorrect: userAnswer === correctAnswer,
      correctAnswer
    };
  });

  const lastIndex = Math.max(nextScenarios.length - 1, 0);
  state.currentIndex = Number.isInteger(snapshot.currentIndex)
    ? Math.min(Math.max(snapshot.currentIndex, 0), lastIndex)
    : 0;

  state.profile = { ...DEFAULT_PROFILE };
  state.errorMessage = '';
  state.reviewingFromSummary = false;
  state.hasLoggedSummary = false;

  const currentAnswer = state.answers[state.currentIndex];
  state.stage = snapshot.stage === 'result' && !currentAnswer ? 'question' : snapshot.stage;
  state.lastAnswer = state.stage === 'result' && currentAnswer
    ? { userAnswer: currentAnswer.userAnswer, isCorrect: currentAnswer.isCorrect }
    : null;
}

function formatEmailBody(text = '') {
  if (!text) {
    return '';
  }
  const blocks = text.split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
  const transformInline = block => {
    const html = applyInlineMarkdown(block, {
      renderLink: (href, labelHTML) => {
        if (!href || href === '#') {
          return `<span class="gmail-link-wrap"><a href="#" class="sim-link gmail-link">${labelHTML}</a></span>`;
        }
        return `<span class="gmail-link-wrap"><a href="${href}" class="sim-link gmail-link" data-link-preview="${href}">${labelHTML}</a></span>`;
      }
    });
    return html.replace(/\n/g, '<br />');
  };
  return blocks.map(block => `<p>${transformInline(block)}</p>`).join('');
}

// Slack renders :shortcodes: as emoji; leaving them as literal text breaks immersion.
const SLACK_EMOJI = {
  warning: '\u26a0\ufe0f',
  white_check_mark: '\u2705',
  x: '\u274c',
  eyes: '\ud83d\udc40',
  tada: '\ud83c\udf89',
  rotating_light: '\ud83d\udea8',
  lock: '\ud83d\udd12',
  unlock: '\ud83d\udd13',
  link: '\ud83d\udd17',
  memo: '\ud83d\udcdd',
  '+1': '\ud83d\udc4d',
  '-1': '\ud83d\udc4e',
  thumbsup: '\ud83d\udc4d',
  pray: '\ud83d\ude4f',
  fire: '\ud83d\udd25',
  bell: '\ud83d\udd14',
  mega: '\ud83d\udce3',
  calendar: '\ud83d\udcc5',
  chart_with_upwards_trend: '\ud83d\udcc8',
  moneybag: '\ud83d\udcb0',
  credit_card: '\ud83d\udcb3',
  page_facing_up: '\ud83d\udcc4',
  paperclip: '\ud83d\udcce',
  hourglass: '\u23f3',
  alarm_clock: '\u23f0',
  question: '\u2753',
  exclamation: '\u2757',
  point_right: '\ud83d\udc49',
  wave: '\ud83d\udc4b',
  raised_hands: '\ud83d\ude4c',
  heavy_check_mark: '\u2714\ufe0f'
};

function replaceSlackEmoji(text = '') {
  return text.replace(/:([a-z0-9_+-]+):/gi, (match, code) => SLACK_EMOJI[code.toLowerCase()] || match);
}

function isSlackDm(scenario = {}) {
  const channel = (scenario.channel || '').trim();
  return !channel || /^direct message/i.test(channel);
}

function formatSlackBody(text = '') {
  if (!text) {
    return '';
  }
  let html = applyInlineMarkdown(replaceSlackEmoji(text), {
    renderLink: (href, labelHTML) => `<a href="${href}" class="sim-link slack-link">${labelHTML}</a>`
  });
  html = html.replace(/(^|\s)@([a-zA-Z0-9._-]+)/g, (_match, prefix, handle) => `${prefix}<span class="slack-mention">@${handle}</span>`);
  const storedAnchors = [];
  html = html.replace(/<a [^>]+?>[\s\S]*?<\/a>/g, match => {
    const token = `%%SLACKANCHOR${storedAnchors.length}%%`;
    storedAnchors.push(match);
    return token;
  });
  html = html.replace(/(https?:\/\/[^\s<]+)/g, url => {
    const decodedUrl = decodeBasicEntities(url);
    const safeHref = escapeAttribute(decodedUrl);
    let hostname = 'link';
    try {
      hostname = new URL(decodedUrl).hostname.replace(/^www\./i, '');
    } catch (_error) {
      hostname = 'link';
    }
    const displayText = escapeHTML(decodedUrl);
    return `<a href="${safeHref}" class="sim-link slack-link" data-domain="${escapeAttribute(hostname)}">${displayText}</a>`;
  });
  storedAnchors.forEach((markup, index) => {
    const token = `%%SLACKANCHOR${index}%%`;
    html = html.replace(token, markup);
  });
  return html.replace(/\n/g, '<br />');
}

function formatSmsBody(text = '') {
  if (!text) {
    return '';
  }
  let html = escapeHTML(text);
  html = html.replace(/(https?:\/\/[^\s<]+)/g, url => {
    const decodedUrl = decodeBasicEntities(url);
    const safeHref = escapeAttribute(decodedUrl);
    return `<a href="${safeHref}" class="sim-link sms-link" data-link-preview="${safeHref}">${escapeHTML(decodedUrl)}</a>`;
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
      <a href="${escapeAttribute(attachment.url)}" class="sim-link slack-attachment-title">${escapeHTML(attachment.title)}</a>
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
        <a href="${docUrl}" class="sim-link gmail-doc-link" data-link-preview="${docUrl}">Open in ${iconLabel}</a>
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
    const response = await fetch('/api/scenarios');
    if (!response.ok) {
      throw new Error(`Failed to load scenarios: ${response.status}`);
    }
    const yamlText = await response.text();
    const parsed = loadYamlDocument(yamlText);
    if (!Array.isArray(parsed)) {
      throw new Error('Scenario file must contain a list.');
    }
    const savedProgress = readSavedProgress(parsed);
    if (savedProgress) {
      restoreQuizFromProgress(parsed, savedProgress);
    } else {
      resetQuizWithScenarios(parsed);
    }
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
    indicator.textContent = 'Ready when you are';
    return;
  }
  if (state.stage === 'summary') {
    indicator.textContent = 'Training complete';
    return;
  }
  const currentNumber = Math.min(state.currentIndex + 1, state.scenarios.length);
  indicator.textContent = `Question ${currentNumber} of ${state.scenarios.length}`;
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
      return 'A new email just landed in your inbox. Take a close look before you decide.';
    case 'sms':
      return 'Your phone buzzed with a new text. Take a close look before you decide.';
    case 'slack':
      return isSlackDm(scenario)
        ? 'A new direct message just came in on Slack. Take a close look before you decide.'
        : `A new message just landed in ${scenario.channel}. Take a close look before you decide.`;
    default:
      return 'You have an incoming message. Take a close look before you decide.';
  }
}

function getScenarioLedeLabel(scenario) {
  switch (scenario.interface) {
    case 'email':
      return 'New email';
    case 'sms':
      return 'New text message';
    case 'slack':
      return 'New Slack message';
    default:
      return 'Incoming message';
  }
}

// The intro is task config: scenarios.yaml can set `intro:` per scenario ({{name}} tokens work).
function getScenarioIntro(scenario) {
  return scenario.intro || getScenarioPromptCopy(scenario);
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
  const introCopy = selectedLandingIntro || landingIntros[0];
  return `
    <div class="app-card welcome-hero">
      <div class="welcome-copy">
        <h2 class="welcome-headline">${escapeHTML(introCopy.headline)}</h2>
        <p class="welcome-subtext">${escapeHTML(introCopy.sub || `Phishing is the #1 cause of data breaches. Test yourself in ${scenarioLabel}.`)}</p>
      </div>
      <form id="quiz-intro-form" class="landing-form" novalidate>
        <button class="button landing-cta" type="submit">Take the Quiz</button>
      </form>
    </div>
  `;
}

function renderScenarioCard(scenario) {
  const personalizedScenario = personalizeScenario(scenario);
  return `
    <div class="app-card scenario-card">
      <div class="scenario-lede" data-state="intro">
        <p class="lede-heading">${escapeHTML(getScenarioLedeLabel(personalizedScenario))}</p>
        <p class="lede-body">${escapeHTML(getScenarioIntro(personalizedScenario))}</p>
        <p class="lede-note">Phishing or legit? Answer in the bar above.</p>
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
      <div class="scenario-lede" data-state="${lastAnswer.isCorrect ? 'correct' : 'incorrect'}">
        <p class="lede-heading">${heading} \u00b7 ${escapeHTML(insightHeading)}</p>
        <p class="lede-body">${escapeHTML(signalsSummary)}</p>
        ${explanationSummary ? `<p class="lede-note">${escapeHTML(explanationSummary)}</p>` : ''}
      </div>
      ${renderInterfaceShell(personalizedScenario)}
    </div>
  `;
}

function renderSummaryCard() {
  const { correct, total } = getScore();
  const incorrect = total - correct;
  const percentage = total ? Math.round((correct / total) * 100) : 0;
  const participantName = (getProfileValue('name', '').trim()) || '';
  const heroTitle = participantName
    ? `Nice work, ${escapeHTML(participantName)}!`
    : 'Nice work!';
  const heroCopy = total
    ? `You spotted ${correct} of ${total} messages correctly. Keep practicing to reach 100%.`
    : 'Ready to take the CodeSignal phishing quiz?';
  const scoreValue = total ? `${correct}/${total}` : '0/0';
  const resultsLabel = total ? `${percentage}%` : '0%';
  const missedLabel = total ? `${incorrect}` : '0';
  const resultsList = state.scenarios
    .map((scenario, index) => {
      const personalized = personalizeScenario(scenario);
      const answer = state.answers[index];
      const isCorrect = Boolean(answer?.isCorrect);
      const statusClass = isCorrect ? 'correct' : 'incorrect';
      const label = isCorrect ? 'Correct' : 'Needs review';
      const interfaceLabel = (scenario.interface || '').toUpperCase();
      const actionLabel = isCorrect ? 'Review' : 'Fix & review';
      return `<li class="scenario-item completed ${statusClass}">
        <div class="scenario-item-body">
          <span class="scenario-item-title">${index + 1}. ${escapeHTML(getScenarioTitle(personalized))}</span>
          <span class="scenario-item-meta">${escapeHTML(interfaceLabel)}</span>
        </div>
        <div class="scenario-item-actions">
          <span class="status-pill">${label}</span>
          <button type="button" class="button button-text scenario-review-btn" data-review-index="${index}">${actionLabel}</button>
        </div>
      </li>`;
    })
    .join('');

  return `
    <div class="app-card summary-card">
      <div class="summary-hero">
        <p class="summary-label">CodeSignal phishing quiz</p>
        <h2>${heroTitle}</h2>
        <p class="summary-lede">${heroCopy}</p>
      </div>
      <div class="summary-metrics">
        <div class="metric-card">
          <span class="metric-value">${scoreValue}</span>
          <span class="metric-label">Score</span>
        </div>
        <div class="metric-card">
          <span class="metric-value">${resultsLabel}</span>
          <span class="metric-label">Accuracy</span>
        </div>
        <div class="metric-card">
          <span class="metric-value">${missedLabel}</span>
          <span class="metric-label">Missed</span>
        </div>
      </div>
      <div class="summary-breakdown">
        <h3>Scenario breakdown</h3>
        <ul class="scenario-list">
          ${resultsList}
        </ul>
      </div>
      <div class="app-actions summary-actions">
        <button class="button button-primary" id="restart-training">Restart quiz</button>
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
  const learnerInitial = (getProfileValue('name', 'L').trim().charAt(0) || 'L').toUpperCase();
  return `
    <div class="scenario-view email-shell gmail-shell">
      <div class="gmail-appbar" aria-hidden="true">
        <span class="gmail-appbar-left">
          <svg class="gmail-hamburger" viewBox="0 0 24 24" aria-hidden="true"><line x1="4" y1="7" x2="20" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"></line><line x1="4" y1="12" x2="20" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"></line><line x1="4" y1="17" x2="20" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"></line></svg>
          <svg class="gmail-logo" viewBox="0 0 32 24" aria-hidden="true"><path d="M2 6v13a2 2 0 0 0 2 2h3V11l9 6.5L25 11v10h3a2 2 0 0 0 2-2V6" fill="none"></path><path d="M2 6a2 2 0 0 1 3.2-1.6L16 12.5 26.8 4.4A2 2 0 0 1 30 6l-14 10.5z" fill="#ea4335"></path><path d="M2 6v13a2 2 0 0 0 2 2h3V11z" fill="#4285f4"></path><path d="M30 6v13a2 2 0 0 1-2 2h-3V11z" fill="#34a853"></path><path d="M7 11 2 6a2 2 0 0 1 3.2-1.6L7 5.8z" fill="#c5221f"></path><path d="M25 11l5-5a2 2 0 0 0-3.2-1.6L25 5.8z" fill="#fbbc04"></path></svg>
          <span class="gmail-wordmark">Gmail</span>
        </span>
        <span class="gmail-search">
          <svg class="gmail-search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" stroke-width="1.8"></circle><line x1="15.5" y1="15.5" x2="20" y2="20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></line></svg>
          <span class="gmail-search-text">Search mail</span>
        </span>
        <span class="gmail-appbar-right">
          <svg class="gmail-gear" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.6"></circle><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path></svg>
          <span class="gmail-user-avatar">${escapeHTML(learnerInitial)}</span>
        </span>
      </div>
      <div class="gmail-toolbar" aria-hidden="true">
        ${toolbarButtons}
      </div>
      <div class="gmail-email">
        <div class="gmail-header">
          <div class="gmail-subject-row">
            <h2 class="gmail-subject">${escapeHTML(scenario.subject || 'No subject')} <span class="gmail-label-chips" aria-hidden="true"><span class="gmail-label-chip">Inbox</span><span class="gmail-label-chip">External</span></span></h2>
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
  const contactInitials = smsMeta.sender
    .split(/\s+/)
    .map(word => word.charAt(0))
    .join('')
    .substring(0, 2)
    .toUpperCase() || '?';
  // iOS shows "Text Message · Today 10:02 AM" centered above SMS threads
  const threadCaption = `${smsMeta.carrier} \u00b7 ${threadTimestamp}`;
  return `
    <div class="scenario-view sms-shell">
      <div class="sms-phone-wrap">
        <span class="sms-side-btn sms-btn-action" aria-hidden="true"></span>
        <span class="sms-side-btn sms-btn-vol-up" aria-hidden="true"></span>
        <span class="sms-side-btn sms-btn-vol-down" aria-hidden="true"></span>
        <span class="sms-side-btn sms-btn-power" aria-hidden="true"></span>
        <div class="sms-phone-frame">
        <div class="sms-statusbar" aria-hidden="true">
          <span class="sms-status-time">9:41</span>
          <span class="sms-dynamic-island"></span>
          <span class="sms-status-icons">
            <svg class="sms-status-icon" viewBox="0 0 18 12" aria-hidden="true"><rect x="0" y="8" width="3" height="4" rx="0.8" fill="currentColor"></rect><rect x="5" y="5.5" width="3" height="6.5" rx="0.8" fill="currentColor"></rect><rect x="10" y="3" width="3" height="9" rx="0.8" fill="currentColor"></rect><rect x="15" y="0.5" width="3" height="11.5" rx="0.8" fill="currentColor" opacity="0.35"></rect></svg>
            <svg class="sms-status-icon" viewBox="0 0 16 12" aria-hidden="true"><path d="M8 9.6a1.7 1.7 0 0 1 1.7 1.7L8 12l-1.7-.7A1.7 1.7 0 0 1 8 9.6zM4.6 8a5 5 0 0 1 6.8 0l-1.4 1.4a3 3 0 0 0-4 0zM1.4 4.8a9.5 9.5 0 0 1 13.2 0l-1.4 1.4a7.5 7.5 0 0 0-10.4 0z" fill="currentColor"></path></svg>
            <svg class="sms-status-icon sms-battery" viewBox="0 0 25 12" aria-hidden="true"><rect x="0.5" y="0.5" width="21" height="11" rx="3" fill="none" stroke="currentColor" opacity="0.5"></rect><rect x="2" y="2" width="15" height="8" rx="1.6" fill="currentColor"></rect><path d="M23.5 4v4a2.2 2.2 0 0 0 0-4z" fill="currentColor" opacity="0.5"></path></svg>
          </span>
        </div>
        <div class="sms-header" aria-hidden="true">
          <span class="sms-back">
            <svg viewBox="0 0 12 20" class="sms-back-chevron" aria-hidden="true"><polyline points="10 2 3 10 10 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></polyline></svg>
          </span>
          <span class="sms-contact">
            <span class="sms-contact-avatar">${escapeHTML(contactInitials)}</span>
            <span class="sms-contact-name">${escapeHTML(smsMeta.sender)} <span class="sms-contact-chevron">\u203a</span></span>
            ${smsMeta.senderNumber ? `<span class="sms-contact-number">${escapeHTML(smsMeta.senderNumber)}</span>` : ''}
          </span>
          <span class="sms-header-spacer"></span>
        </div>
        <div class="sms-thread">
          <div class="sms-thread-timestamp">${escapeHTML(threadCaption)}</div>
          <div class="sms-message-row incoming">
            <div class="sms-bubble sender js-sms-body">${formatSmsBody(scenario.body || '')}</div>
          </div>
          ${messageTime ? `<div class="sms-delivery-time">${escapeHTML(messageTime)}</div>` : ''}
        </div>
        <div class="sms-composer" aria-hidden="true">
          <span class="sms-compose-plus">
            <svg viewBox="0 0 20 20" class="sms-plus-icon" aria-hidden="true"><line x1="10" y1="4.5" x2="10" y2="15.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></line><line x1="4.5" y1="10" x2="15.5" y2="10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></line></svg>
          </span>
          <span class="sms-compose-placeholder">${escapeHTML(smsMeta.carrier)} \u00b7 SMS</span>
          <button type="button" class="sms-send-button">\u2191</button>
        </div>
          <div class="sms-home-indicator" aria-hidden="true"></div>
        </div>
      </div>
    </div>
  `;
}

function getSlackIconSvg(type) {
  const a = 'class="slack-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false"';
  switch (type) {
    case 'compose':
      return `<svg ${a}><path d="M13.6 3.2 16.8 6.4 8 15.2l-4 .8.8-4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path></svg>`;
    case 'threads':
      return `<svg ${a}><path d="M4 4h12v9H8l-4 3z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path></svg>`;
    case 'drafts':
      return `<svg ${a}><path d="M3 10.5 17 4l-4.5 13-3-5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path></svg>`;
    case 'person':
      return `<svg ${a}><circle cx="10" cy="7" r="3" fill="none" stroke="currentColor" stroke-width="1.5"></circle><path d="M4.5 16c.8-2.6 2.9-4 5.5-4s4.7 1.4 5.5 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path></svg>`;
    case 'search':
      return `<svg ${a}><circle cx="9" cy="9" r="5" fill="none" stroke="currentColor" stroke-width="1.6"></circle><line x1="13" y1="13" x2="17" y2="17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></line></svg>`;
    case 'info':
      return `<svg ${a}><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.5"></circle><line x1="10" y1="9" x2="10" y2="14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></line><circle cx="10" cy="6.2" r="0.9" fill="currentColor"></circle></svg>`;
    case 'emoji-add':
      return `<svg ${a}><circle cx="9" cy="10" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4"></circle><path d="M6.8 11.2c.5.9 1.3 1.4 2.2 1.4s1.7-.5 2.2-1.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"></path><circle cx="7.3" cy="8.7" r="0.7" fill="currentColor"></circle><circle cx="10.7" cy="8.7" r="0.7" fill="currentColor"></circle><line x1="15.5" y1="3" x2="15.5" y2="8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></line><line x1="13" y1="5.5" x2="18" y2="5.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></line></svg>`;
    case 'share':
      return `<svg ${a}><path d="M11 5.5 15.5 10 11 14.5v-3C7 11.5 5 13 4 15.5c0-4.5 2.5-7 7-7z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"></path></svg>`;
    case 'bookmark':
      return `<svg ${a}><path d="M6 3.5h8V17l-4-3-4 3z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path></svg>`;
    case 'kebab':
      return `<svg ${a}><circle cx="10" cy="4.5" r="1.2" fill="currentColor"></circle><circle cx="10" cy="10" r="1.2" fill="currentColor"></circle><circle cx="10" cy="15.5" r="1.2" fill="currentColor"></circle></svg>`;
    case 'plus':
      return `<svg ${a}><line x1="10" y1="5" x2="10" y2="15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></line><line x1="5" y1="10" x2="15" y2="10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></line></svg>`;
    case 'send':
      return `<svg ${a}><path d="M3 10 17 3.5 13 16.5l-3.5-4z" fill="currentColor"></path></svg>`;
    default:
      return '';
  }
}

function renderSlackHoverBar() {
  return `
    <div class="slack-hover-bar" aria-hidden="true">
      <button type="button" title="Add reaction">${getSlackIconSvg('emoji-add')}</button>
      <button type="button" title="Reply in thread">${getSlackIconSvg('threads')}</button>
      <button type="button" title="Forward">${getSlackIconSvg('share')}</button>
      <button type="button" title="Save for later">${getSlackIconSvg('bookmark')}</button>
      <button type="button" title="More actions">${getSlackIconSvg('kebab')}</button>
    </div>
  `;
}

function renderSlackShell(scenario) {
  const initials = (scenario.avatar_initials || (scenario.sender_name || '?').substring(0, 2)).toUpperCase();
  const avatarColor = scenario.avatar_color || getAvatarColor(scenario.sender_name || scenario.sender_handle || 'slack');
  const isDm = isSlackDm(scenario);
  const channelLabel = (scenario.channel || '').replace(/^#/, '');
  const senderBadge = scenario.is_bot ? '<span class="slack-sender-badge">APP</span>' : '';
  const verificationBadge = scenario.verified_app ? '<span class="slack-verified-badge">Verified</span>' : '';
  const externalBadge = scenario.external_org ? `<span class="slack-external-badge">${escapeHTML(scenario.external_org)}</span>` : '';
  const editedLabel = scenario.edited ? '<span class="slack-edited">(edited)</span>' : '';
  const attachmentMarkup = renderSlackAttachment(scenario.attachment || {});
  const reactionsMarkup = renderSlackReactions(scenario.reactions || []);
  const threadFooterMarkup = renderSlackThreadFooter(scenario);
  const senderName = scenario.sender_name || 'Teammate';
  const senderHandle = scenario.sender_handle || 'user';

  const topbar = isDm
    ? `
      <div class="slack-channel-wrap">
        <span class="slack-topbar-avatar" style="background:${escapeAttribute(avatarColor)};">${escapeHTML(initials)}</span>
        <span class="slack-channel">${escapeHTML(senderName)}</span>
        <span class="slack-presence-dot" title="Active"></span>
      </div>`
    : `
      <div class="slack-channel-wrap">
        <span class="slack-channel"><span class="slack-hash">#</span>${escapeHTML(channelLabel)}</span>
        ${scenario.channel_members ? `<span class="slack-channel-meta">${getSlackIconSvg('person')} ${escapeHTML(String(scenario.channel_members))}</span>` : ''}
      </div>`;

  const channelItems = ['announcements', 'general', 'help-it'];
  if (!isDm && channelLabel && !channelItems.includes(channelLabel)) {
    channelItems.splice(2, 0, channelLabel);
  }
  const channelListMarkup = channelItems
    .map(name => {
      const active = !isDm && name === channelLabel;
      return `<div class="slack-sidebar-item${active ? ' active' : ''}"><span class="slack-hash">#</span> ${escapeHTML(name)}</div>`;
    })
    .join('') + '<div class="slack-sidebar-item unread"><span class="slack-hash">#</span> security <span class="slack-unread-badge">2</span></div>';

  const dmListMarkup = `
    <div class="slack-sidebar-item${isDm ? ' active' : ''}"><span class="slack-presence-dot"></span> ${escapeHTML(senderName)}</div>
    <div class="slack-sidebar-item"><span class="slack-presence-dot"></span> Slackbot</div>
    <div class="slack-sidebar-item"><span class="slack-presence-dot away"></span> you</div>
  `;

  const composerPlaceholder = isDm ? `Message ${senderName}` : `Message #${channelLabel || 'channel'}`;

  return `
    <div class="scenario-view slack-shell">
      <div class="slack-frame">
        <aside class="slack-sidebar" aria-hidden="true">
          <div class="slack-workspace">
            <span>${escapeHTML(scenario.workspace || 'Company Workspace')}</span>
            <span class="slack-compose-btn">${getSlackIconSvg('compose')}</span>
          </div>
          <div class="slack-sidebar-group">
            <div class="slack-sidebar-item">${getSlackIconSvg('threads')} Threads</div>
            <div class="slack-sidebar-item">${getSlackIconSvg('drafts')} Drafts &amp; sent</div>
          </div>
          <div class="slack-sidebar-group">
            <span class="slack-sidebar-title">Channels</span>
            ${channelListMarkup}
          </div>
          <div class="slack-sidebar-group">
            <span class="slack-sidebar-title">Direct messages</span>
            ${dmListMarkup}
          </div>
        </aside>
        <div class="slack-main">
          <div class="slack-topbar">
            ${topbar}
            <div class="slack-top-actions" aria-hidden="true">${getSlackIconSvg('search')}${getSlackIconSvg('info')}</div>
          </div>
          <div class="slack-day-divider" aria-hidden="true"><span>Today</span></div>
          <div class="slack-message">
            ${renderSlackHoverBar()}
            <div class="slack-avatar" style="background:${escapeAttribute(avatarColor)};">${escapeHTML(initials)}</div>
            <div class="slack-body">
              <div class="slack-sender-row">
                <strong>${escapeHTML(senderName)}</strong>
                ${senderBadge}
                ${verificationBadge}
                ${externalBadge}
                <span class="body-small slack-timestamp">${escapeHTML(scenario.timestamp || '')}</span>
              </div>
              <div class="body-small slack-handle">@${escapeHTML(senderHandle)}</div>
              <p class="js-slack-body">${formatSlackBody(scenario.body || '')} ${editedLabel}</p>
              ${attachmentMarkup}
              ${reactionsMarkup}
              ${threadFooterMarkup}
            </div>
          </div>
          <div class="slack-composer" aria-hidden="true">
            <div class="slack-composer-toolbar">
              <span class="slack-format-icon"><b>B</b></span>
              <span class="slack-format-icon"><i>I</i></span>
              <span class="slack-format-icon"><s>S</s></span>
              <span class="slack-format-icon slack-format-code">&lt;/&gt;</span>
            </div>
            <div class="slack-composer-input">${escapeHTML(composerPlaceholder)}</div>
            <div class="slack-composer-bottom">
              <span class="slack-composer-tools">
                <span class="slack-composer-plus">${getSlackIconSvg('plus')}</span>
                <span class="slack-format-icon">Aa</span>
                <span class="slack-format-icon">${getSlackIconSvg('emoji-add')}</span>
                <span class="slack-format-icon">@</span>
              </span>
              <span class="slack-send-btn">${getSlackIconSvg('send')}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderQuizBar() {
  const actionsEl = document.getElementById('quiz-bar-actions');
  if (!actionsEl) {
    return;
  }
  let actions = '';
  if (state.stage === 'question' && state.scenarios[state.currentIndex]) {
    actions = `
      <button type="button" class="button button-danger quiz-bar-btn" data-answer-choice="phishing">Phishing</button>
      <button type="button" class="button button-primary quiz-bar-btn" data-answer-choice="legit">Legit</button>
    `;
  } else if (state.stage === 'result') {
    const isLastScenario = state.currentIndex === state.scenarios.length - 1;
    const nextCtaLabel = state.reviewingFromSummary
      ? 'Back to Summary'
      : (isLastScenario ? 'View Final Score' : 'Next Scenario');
    actions = `
      <button type="button" class="button button-secondary quiz-bar-btn" id="review-again">Review Scenario</button>
      <button type="button" class="button button-primary quiz-bar-btn" id="next-scenario">${nextCtaLabel}</button>
    `;
  }
  actionsEl.innerHTML = actions;
  const bar = document.getElementById('quiz-bar');
  if (bar) {
    bar.setAttribute('data-stage', state.stage);
  }
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
      state.reviewingFromSummary = false;
      markup = renderSummaryCard();
      break;
    default:
      markup = renderLoadingCard();
  }
  root.innerHTML = markup;
  renderQuizBar();
  attachEventHandlers();
  updateHeaderStatus();
  if (state.scenarios.length && PERSISTED_STAGES.includes(state.stage)) {
    saveProgress();
    publishSnapshot();
  }
  if (state.stage === 'summary') {
    logQuizResult();
  }
}

function attachEventHandlers() {
  const introForm = document.getElementById('quiz-intro-form');
  if (introForm) {
    introForm.addEventListener('submit', event => {
      event.preventDefault();
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

  document.querySelectorAll('[data-answer-choice]').forEach(button => {
    button.addEventListener('click', event => {
      const choice = event.currentTarget?.getAttribute('data-answer-choice');
      if (!choice || state.stage !== 'question') {
        return;
      }
      handleAnswer(choice);
    });
  });

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
      if (state.reviewingFromSummary) {
        state.stage = 'summary';
        state.reviewingFromSummary = false;
      } else if (state.currentIndex < state.scenarios.length - 1) {
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

  document.querySelectorAll('.scenario-review-btn[data-review-index]').forEach(button => {
    button.addEventListener('click', event => {
      const target = event.currentTarget;
      const indexValue = target?.getAttribute('data-review-index');
      const index = Number(indexValue);
      if (Number.isNaN(index) || !state.scenarios[index]) {
        return;
      }
      state.currentIndex = index;
      state.stage = 'question';
      state.lastAnswer = null;
      state.reviewingFromSummary = true;
      renderApp();
    });
  });

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

function buildSnapshotSubmission() {
  return {
    stage: state.stage,
    profile: { ...state.profile },
    // Only the raw choice is reported. The server grades it against scenarios.yaml, so the
    // state an evaluator reads from GET /snapshot never depends on the browser's own scoring.
    answers: state.scenarios.map((scenario, index) => {
      const answer = state.answers[index];
      return {
        id: scenario.id,
        answer: answer ? answer.userAnswer : null
      };
    })
  };
}

async function postSnapshot(submission) {
  try {
    const response = await fetch('/snapshot', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(submission)
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Snapshot rejected (${response.status}): ${text}`);
    }
  } catch (error) {
    console.error('Failed to publish quiz snapshot:', error);
  }
}

function publishSnapshot({ immediate = false } = {}) {
  if (!state.scenarios.length) {
    return;
  }
  const submission = buildSnapshotSubmission();
  if (snapshotTimer) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
  }
  if (immediate) {
    postSnapshot(submission);
    return;
  }
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    postSnapshot(submission);
  }, SNAPSHOT_DEBOUNCE_MS);
}

function logQuizResult() {
  if (state.hasLoggedSummary) {
    return;
  }
  const { total, correct } = getScore();
  console.log(`QUIZ_COMPLETE: ${correct}/${total} correct locally. Graded state: GET /snapshot`);
  publishSnapshot({ immediate: true });
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

async function initialize() {
  const root = selectors.appRoot();
  if (root) {
    root.innerHTML = renderLoadingCard();
  }
  await loadScenarios();
  renderApp();
  initializeWebSocket();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
