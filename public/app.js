// Load & Clash: browser client.
// All game rules come from the server (/api/rules), so the UI never has its
// own copy of them. All user-provided text is inserted with textContent.

const SESSION_KEY = 'clash.session'; // per tab, so two tabs can play each other
const NAME_KEY = 'clash.name';
const CODE_RE = /^[A-Z0-9]{5}$/;

// Keyboard shortcuts. Enter locks in the highlighted move.
const KEYS = {
  load: 'l',
  mag: 'q',
  nv: 'w',
  shield: 'e',
  rebound: 'r',
  path: 'a',
  boss: 's',
  dam: 'd',
  icy: 'f',
  touche: 'g',
  storm: 'h',
  beast: 'j',
  professor: 'k',
};
const MOVE_BY_KEY = Object.fromEntries(Object.entries(KEYS).map(([id, key]) => [key, id]));

const $ = (selector, root = document) => root.querySelector(selector);

/** Tiny element builder. Text is always set as text, never as HTML. */
function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value == null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const kid of kids.flat()) if (kid != null) node.append(kid);
  return node;
}

// ---------------------------------------------------------------- state ----

let rules = null; // { load, defenses, attacks }
let moveById = {};
let maxScore = 12; // number of cells on the meter
let session = null; // { code, token, seat }
let state = null; // latest view from the server
let selected = null; // move id chosen but not locked in yet
let lastRound = null;
let lastHistoryLength = 0;
let busy = false;
let locking = false;
let offlineSince = null; // when the opponent was first seen offline
let offlineTimer = null;
let clockOffset = 0; // server time minus this device's time, in ms
let timerLoop = null;

// Connection: a live stream when it works, polling when it does not.
let stream = null; // EventSource
let transport = 'sse'; // 'sse' | 'poll'
let gotFirstState = false;
let sseErrors = 0;
let sseWatchdog = null;
let reconnectAttempts = 0;
let pollTimer = null;
let pollFailures = 0;
let pollVersion = -1;
let keepAliveTimer = null;
let flashTimer = null;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const moveName = (id) => moveById[id].name;

// ------------------------------------------------------------------ api ----

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) throw new Error((data && data.error) || `Something went wrong (${res.status}).`);
  return data;
}

function notice(message) {
  const node = $('#notice');
  if (!message) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.textContent = message;
  node.hidden = false;
}

// -------------------------------------------------------------- session ----

function saveSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* private mode: the game still works until the tab is refreshed */
  }
}

function loadSession() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (stored && CODE_RE.test(stored.code) && typeof stored.token === 'string') return stored;
  } catch {
    /* ignore */
  }
  return null;
}

function clearSession() {
  session = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

function playerName() {
  const name = $('#name').value.trim();
  try {
    if (name) localStorage.setItem(NAME_KEY, name);
  } catch {
    /* ignore */
  }
  return name;
}

function parseHash() {
  const code = location.hash.replace(/^#/, '').toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

// ---------------------------------------------------------------- views ----

function showView(name) {
  for (const view of ['lobby', 'waiting', 'game']) $(`#view-${view}`).hidden = view !== name;
  const inRoom = name !== 'lobby';
  $('#roomtag').hidden = !inRoom;
  if (inRoom && session) $('#roomcode').textContent = session.code;
}

function goToLobby(message) {
  stopTransport();
  clearSession();
  state = null;
  selected = null;
  lastRound = null;
  lastHistoryLength = 0;
  offlineSince = null;
  clearTimeout(offlineTimer);
  offlineTimer = null;
  history.replaceState(null, '', location.pathname);
  $('#conn').hidden = true;
  $('#timer').hidden = true;
  $('#invite-note').hidden = true;
  $('#create-block').hidden = false;
  $('#btn-show-create').hidden = true;
  showView('lobby');
  notice(message || '');
}

// ----------------------------------------------------------- connection ----

function syncClock(serverNow) {
  if (typeof serverNow === 'number') clockOffset = serverNow - Date.now();
}

function applyState(next) {
  pollVersion = next.version;
  syncClock(next.serverNow);
  state = next;
  render(next);
}

function stopTransport() {
  if (stream) {
    const old = stream;
    stream = null;
    old.close();
  }
  clearTimeout(sseWatchdog);
  clearTimeout(pollTimer);
  clearInterval(keepAliveTimer);
  sseWatchdog = null;
  pollTimer = null;
  keepAliveTimer = null;
  transport = 'sse';
}

function connect() {
  stopTransport();
  gotFirstState = false;
  sseErrors = 0;
  reconnectAttempts = 0;
  pollVersion = -1;

  // Free hosts put a service to sleep when nothing visits it for a while.
  // A quiet request every few minutes keeps a waiting room alive.
  keepAliveTimer = setInterval(() => fetch('/healthz', { cache: 'no-store' }).catch(() => {}), 4 * 60 * 1000);

  const url = `/api/rooms/${session.code}/events?token=${encodeURIComponent(session.token)}`;
  const source = new EventSource(url);
  stream = source;

  source.addEventListener('state', (event) => {
    if (stream !== source) return;
    gotFirstState = true;
    sseErrors = 0;
    reconnectAttempts = 0;
    clearTimeout(sseWatchdog);
    $('#conn').hidden = true;
    applyState(JSON.parse(event.data));
  });

  source.onerror = () => {
    if (stream !== source) return;
    if (source.readyState === EventSource.CLOSED) {
      handleStreamClosed(source);
      return;
    }
    sseErrors += 1;
    $('#conn').hidden = false; // the browser is retrying by itself
    if (!gotFirstState && sseErrors >= 2) startPolling();
  };

  // Some networks and hosts hold a live stream back until it fills up. If
  // nothing arrives in 5 seconds, ask for the game state by polling instead.
  sseWatchdog = setTimeout(() => {
    if (stream === source && !gotFirstState) startPolling();
  }, 5000);
}

/** A closed stream does not always mean the room is gone: Chrome also reports
 *  it while a page is being refreshed. Ask the server before giving up. */
async function handleStreamClosed(source) {
  const code = session && session.code;
  if (!code) return;
  try {
    const res = await fetch(`/api/rooms/${code}`);
    if (stream !== source) return;
    if (res.status === 404) {
      goToLobby('That room is no longer available. Create a new one or enter another code.');
      return;
    }
  } catch {
    /* offline, or the page is unloading: fall through and retry */
  }
  if (stream !== source) return;
  reconnectAttempts += 1;
  if (reconnectAttempts > 5) {
    goToLobby('Could not reconnect to that room. Create a new one or enter another code.');
    return;
  }
  $('#conn').hidden = false;
  setTimeout(() => {
    if (stream === source && session) connect();
  }, 2000);
}

function startPolling() {
  if (!session || transport === 'poll') return;
  if (stream) {
    const old = stream;
    stream = null;
    old.close();
  }
  clearTimeout(sseWatchdog);
  transport = 'poll';
  pollFailures = 0;
  pollLoop(session);
}

async function pollLoop(mine) {
  if (session !== mine || transport !== 'poll') return;
  let delay = 1000;
  try {
    const url = `/api/rooms/${mine.code}/state?token=${encodeURIComponent(mine.token)}&v=${pollVersion}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (session !== mine || transport !== 'poll') return;
    if (res.status === 404 || res.status === 403) {
      goToLobby('That room is no longer available. Create a new one or enter another code.');
      return;
    }
    if (!res.ok) throw new Error('poll failed');
    const data = await res.json();
    if (session !== mine || transport !== 'poll') return;
    pollFailures = 0;
    $('#conn').hidden = true;
    if (data.unchanged) syncClock(data.serverNow);
    else applyState(data);
  } catch {
    pollFailures += 1;
    if (pollFailures >= 2) $('#conn').hidden = false;
    delay = 2000;
  }
  pollTimer = setTimeout(() => pollLoop(mine), delay);
}

function enterRoom(info) {
  session = { code: info.code, token: info.token, seat: info.seat };
  saveSession();
  history.replaceState(null, '', `#${info.code}`);
  notice('');
  connect();
}

// -------------------------------------------------------------- lobby -----

async function createRoom() {
  if (busy) return;
  busy = true;
  notice('');
  try {
    enterRoom(await api('/api/rooms', { method: 'POST', body: { name: playerName() } }));
  } catch (err) {
    notice(err.message);
  } finally {
    busy = false;
  }
}

async function joinRoom(rawCode) {
  if (busy) return;
  const code = String(rawCode || '').toUpperCase();
  if (!CODE_RE.test(code)) {
    notice('Enter the 5-character room code.');
    $('#code').focus();
    return;
  }
  busy = true;
  notice('');
  try {
    enterRoom(await api(`/api/rooms/${code}/join`, { method: 'POST', body: { name: playerName() } }));
  } catch (err) {
    notice(err.message);
  } finally {
    busy = false;
  }
}

async function showInvite(code) {
  try {
    const info = await api(`/api/rooms/${code}`);
    if (info.full) {
      history.replaceState(null, '', location.pathname);
      notice('That room already has two players. Create your own room below.');
      return;
    }
    $('#invite-code').textContent = code;
    $('#invite-note').hidden = false;
    $('#code').value = code;
    $('#create-block').hidden = true;
    $('#btn-show-create').hidden = false;
    $('#name').focus();
  } catch (err) {
    history.replaceState(null, '', location.pathname);
    notice(err.message);
  }
}

// -------------------------------------------------------------- meters ----

function buildMeter(container) {
  const byValue = new Map(rules.attacks.map((attack) => [attack.value, attack]));
  const cells = [];
  for (let n = 1; n <= maxScore; n++) {
    const cell = h('span', { class: 'cell', 'data-n': n });
    const attack = byValue.get(n);
    if (attack) {
      cell.classList.add('has');
      cell.title = `${attack.name} unlocks at ${n}`;
      cell.style.setProperty('--c1', `var(--${attack.counters[0]})`);
      cell.style.setProperty('--c2', `var(--${attack.counters[1] || attack.counters[0]})`);
    }
    cells.push(cell);
  }
  container.replaceChildren(...cells);
}

function updateMeter(container, score) {
  container.setAttribute('aria-label', `Score ${score}`);
  container.querySelectorAll('.cell').forEach((cell) => {
    cell.classList.toggle('on', Number(cell.dataset.n) <= score);
  });
}

function captionFor(score, isYou) {
  const unlocked = rules.attacks.filter((a) => a.value <= score);
  const next = rules.attacks.find((a) => a.value > score);
  const top = unlocked[unlocked.length - 1];
  if (!top) {
    return isYou ? `No attacks yet. ${next.name} unlocks at ${next.value}.` : 'No attacks unlocked yet.';
  }
  const base = `Strongest attack: ${top.name}.`;
  return isYou && next ? `${base} Next: ${next.name} at ${next.value}.` : base;
}

// Plays once on the home screen: the meter fills so the notches are noticed.
function playHeroMeter() {
  const meter = $('#hero-meter');
  buildMeter(meter);
  const cells = [...meter.querySelectorAll('.cell')];
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    cells.forEach((cell) => cell.classList.add('on'));
    return;
  }
  cells.forEach((cell, i) => setTimeout(() => cell.classList.add('on'), 250 + i * 90));
}

// --------------------------------------------------------------- timer ----

function updateTimer() {
  const box = $('#timer');
  if (!state || state.status !== 'playing' || !state.opponent.joined || $('#view-game').hidden) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const fill = $('#timer-fill');
  const num = $('#timer-num');
  if (state.deadline == null) {
    box.classList.add('paused');
    box.classList.remove('urgent');
    fill.style.transform = 'scaleX(1)';
    num.textContent = 'Paused';
    return;
  }
  box.classList.remove('paused');
  const left = Math.max(0, state.deadline - (Date.now() + clockOffset));
  fill.style.transform = `scaleX(${Math.min(1, left / state.roundMs)})`;
  box.classList.toggle('urgent', left <= 2000);
  num.textContent = String(Math.ceil(left / 1000));
}

// -------------------------------------------------------------- picker ----

function keyCap(id) {
  return h('kbd', { 'aria-hidden': 'true', text: KEYS[id].toUpperCase() });
}

function moveButton(move) {
  const classes = ['move', move.type];
  if (move.type === 'defense') classes.push(move.id);
  const button = h('button', {
    type: 'button',
    class: classes.join(' '),
    'data-move': move.id,
    'aria-pressed': 'false',
    'aria-keyshortcuts': KEYS[move.id].toUpperCase(),
  });

  if (move.type === 'load') {
    button.append(h('span', { class: 'move-name', text: move.name }), h('span', { class: 'move-note', text: '+1 point' }), keyCap(move.id));
  } else if (move.type === 'defense') {
    button.append(h('span', { class: 'move-head' }, h('span', { class: 'move-name', text: move.name }), keyCap(move.id)));
  } else {
    const counters = move.counters.map((id) => moveById[id].name);
    button.setAttribute('aria-label', `${move.name}, unlocks at ${move.value}, answered by ${counters.join(' or ')}`);
    button.append(
      h('span', { class: 'move-head' }, h('span', { class: 'move-name', text: move.name }), keyCap(move.id)),
      h(
        'span',
        { class: 'move-sub' },
        h('span', { class: 'badge', text: move.value }),
        h(
          'span',
          { class: 'chips' },
          move.counters.map((id) => h('span', { class: 'chip' }, h('i', { class: `dot ${id}` }), moveById[id].name)),
        ),
      ),
      h('span', { class: 'lock-note' }),
    );
  }
  return button;
}

function buildPicker() {
  $('#g-load').replaceChildren(moveButton(rules.load));
  $('#g-def').replaceChildren(...rules.defenses.map(moveButton));
  $('#g-atk').replaceChildren(...rules.attacks.map(moveButton));
}

function updatePicker(s) {
  const legal = new Set(s.you.legal);
  const canAct = s.status === 'playing' && !s.you.locked;
  document.querySelectorAll('#picker .move').forEach((button) => {
    const id = button.dataset.move;
    const move = moveById[id];
    const scoreLocked = move.type === 'attack' && s.you.score < move.value;
    button.disabled = !canAct || !legal.has(id);
    button.classList.toggle('is-locked', scoreLocked && canAct);
    button.setAttribute('aria-pressed', String(selected === id));
    if (move.type === 'attack') {
      $('.lock-note', button).textContent = scoreLocked ? `Needs ${move.value - s.you.score} more` : '';
    }
  });

  const lockbar = $('#lockbar');
  lockbar.hidden = s.status !== 'playing';
  const label = $('#selection');
  const lock = $('#btn-lock');
  if (s.you.locked) {
    label.textContent = selected ? `Locked in: ${moveName(selected)}` : 'Locked in';
    lock.disabled = true;
  } else if (selected) {
    label.textContent = `Selected: ${moveName(selected)}`;
    lock.disabled = false;
  } else {
    label.textContent = 'Choose a move';
    lock.disabled = true;
  }
}

/** Show a short message in the lock bar, then go back to the normal label. */
function flashSelection(message) {
  $('#selection').textContent = message;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    if (state) updatePicker(state);
  }, 1800);
}

function chooseMove(id) {
  if (!state || state.status !== 'playing' || state.you.locked) return;
  const move = moveById[id];
  if (!state.you.legal.includes(id)) {
    flashSelection(`${move.name} unlocks at ${move.value}. Your score is ${state.you.score}.`);
    return;
  }
  clearTimeout(flashTimer);
  selected = id;
  updatePicker(state);
}

async function lockIn() {
  if (!state || state.status !== 'playing' || state.you.locked || !session || locking) return;
  if (!selected) {
    flashSelection('Choose a move first.');
    return;
  }
  locking = true;
  notice('');
  $('#btn-lock').disabled = true;
  try {
    await api(`/api/rooms/${session.code}/move`, {
      method: 'POST',
      body: { token: session.token, move: selected, round: state.round },
    });
  } catch (err) {
    notice(err.message);
    if (state) updatePicker(state);
  } finally {
    locking = false;
  }
}

// ------------------------------------------------------- round wording ----

function timeoutNote(entry, s) {
  const { you, opp } = entry.timedOut || {};
  if (you && opp) return ' Time ran out for both players, so Load was played for each.';
  if (you) return ' Time ran out for you, so Load was played for you.';
  if (opp) return ` Time ran out for ${s.opponent.name}, so Load was played for them.`;
  return '';
}

function describeCore(entry, s) {
  const opp = s.opponent.name;
  const youMove = moveById[entry.you];
  const oppMove = moveById[entry.opp];
  const youAttacked = entry.attacker === 'you';

  switch (entry.kind) {
    case 'quiet':
      if (youMove.type === 'load' && oppMove.type === 'load') return 'Both players loaded and gained 1 point.';
      if (youMove.type !== 'load' && oppMove.type !== 'load') return 'Both players defended. Nothing changed.';
      if (youMove.type === 'load') return `You loaded and gained 1 point. ${opp} defended with ${oppMove.name}.`;
      return `${opp} loaded and gained 1 point. You defended with ${youMove.name}.`;

    case 'blocked': {
      const attack = youAttacked ? youMove : oppMove;
      const defense = youAttacked ? oppMove : youMove;
      return youAttacked
        ? `${opp} blocked your ${attack.name} with ${defense.name}. You lost ${plural(entry.penalty, 'point')}.`
        : `You blocked ${opp}'s ${attack.name} with ${defense.name}. ${opp} lost ${plural(entry.penalty, 'point')}.`;
    }

    case 'hit': {
      const attack = youAttacked ? youMove : oppMove;
      const defense = youAttacked ? oppMove : youMove;
      const counters = attack.counters.map(moveName).join(' or ');
      const answered = (subject, were) =>
        defense.type === 'load' ? `${subject} ${were} loading` : `${subject} used ${defense.name}`;
      return youAttacked
        ? `${answered(opp, 'was')}, but ${attack.name} is only blocked by ${counters}. You win.`
        : `${answered('You', 'were')}, but ${attack.name} is only blocked by ${counters}. ${opp} wins.`;
    }

    case 'reflect':
      return youAttacked
        ? `${opp} used Rebound against your Dam and reflected it back. You lose.`
        : `You used Rebound against ${opp}'s Dam and reflected it back. You win.`;

    case 'swap': {
      const who = youAttacked ? `${opp} used Rebound against your Touch E` : `You used Rebound against ${opp}'s Touch E`;
      return `${who}, so the scores were swapped. You now have ${entry.scores.you} and ${opp} has ${entry.scores.opp}.`;
    }

    case 'absorb': {
      const taken = plural(entry.absorbed, 'point');
      if (youAttacked) {
        const how = oppMove.type === 'load' ? 'was loading' : `used ${oppMove.name}`;
        return `${opp} ${how}, so your Touch E absorbed their ${taken}. You now have ${entry.scores.you}.`;
      }
      const how = youMove.type === 'load' ? 'You were loading' : `You used ${youMove.name}`;
      return `${how}, so ${opp}'s Touch E absorbed your ${taken}. You now have ${entry.scores.you}.`;
    }

    case 'touch-loses':
      return youAttacked
        ? `You used Touch E, but ${opp} attacked with ${oppMove.name}. Touch E loses to any other attack, so ${opp} wins.`
        : `${opp} used Touch E, but you attacked with ${youMove.name}. Touch E loses to any other attack, so you win.`;

    case 'clash':
      return entry.result === 'win'
        ? `Both attacked. Your ${youMove.name} (${youMove.value}) beat ${opp}'s ${oppMove.name} (${oppMove.value}).`
        : `Both attacked. ${opp}'s ${oppMove.name} (${oppMove.value}) beat your ${youMove.name} (${youMove.value}).`;

    case 'clash-same':
      return `Both players used ${youMove.name}. Each of you loses ${plural(entry.penalty, 'point')}.`;

    default:
      return '';
  }
}

const describe = (entry, s) => describeCore(entry, s) + timeoutNote(entry, s);

// -------------------------------------------------------------- render ----

function statusText(s) {
  if (s.status === 'finished') return '';
  const opp = s.opponent.name;
  if (s.you.locked) return `Locked in. Waiting for ${opp}.`;
  if (s.opponent.locked) return `${opp} has locked in. Your move.`;
  return `Round ${s.round}. Choose your move.`;
}

/** True only once the opponent has been offline for a few seconds, so the
 *  message doesn't flash while their connection is still opening. */
function opponentOffline(s) {
  const offline = s.status === 'playing' && !s.opponent.connected;
  if (!offline) {
    offlineSince = null;
    clearTimeout(offlineTimer);
    offlineTimer = null;
    return false;
  }
  if (offlineSince === null) offlineSince = Date.now();
  const elapsed = Date.now() - offlineSince;
  if (elapsed >= 3000) return true;
  if (!offlineTimer) {
    offlineTimer = setTimeout(() => {
      offlineTimer = null;
      if (state) render(state);
    }, 3050 - elapsed);
  }
  return false;
}

function renderReveal(s) {
  const last = s.history[s.history.length - 1];
  const reveal = $('#reveal');
  $('#results-empty').hidden = Boolean(last);
  if (!last) {
    reveal.hidden = true;
    return;
  }
  reveal.hidden = false;
  $('#reveal-title').textContent = `Round ${last.round} result`;
  $('#rv-opp-name').textContent = s.opponent.name;
  for (const [side, id] of [['you', last.you], ['opp', last.opp]]) {
    const move = $(`#rv-${side}`);
    move.textContent = moveName(id);
    move.parentElement.className = `played ${side}${moveById[id].type === 'defense' ? ` t-${id}` : ''}`;
  }
  $('#rv-text').textContent = describe(last, s);

  if (s.history.length !== lastHistoryLength) {
    // Only animate when a new round has just resolved, not on every update.
    if (lastHistoryLength !== 0 || s.history.length === 1) {
      reveal.classList.remove('fresh');
      void reveal.offsetWidth; // restart the animation
      reveal.classList.add('fresh');
    }
  }
}

function renderBanner(s) {
  const banner = $('#banner');
  if (s.status !== 'finished') {
    banner.hidden = true;
    return;
  }
  const last = s.history[s.history.length - 1];
  banner.hidden = false;
  $('#banner-title').textContent = s.result === 'win' ? 'You win' : 'You lose';
  $('#banner-text').textContent = last ? describe(last, s) : '';
  const button = $('#btn-rematch');
  const opp = s.opponent.name;
  button.disabled = s.you.wantsRematch;
  button.textContent = s.you.wantsRematch ? 'Waiting for a rematch' : 'Play again';
  $('#rematch-note').textContent = s.you.wantsRematch
    ? `Waiting for ${opp} to accept.`
    : s.opponent.wantsRematch
      ? `${opp} wants to play again.`
      : '';
}

function renderLog(s) {
  const items = s.history
    .slice()
    .reverse()
    .slice(0, 60)
    .map((entry) =>
      h(
        'li',
        {},
        h('strong', { text: `Round ${entry.round}. ` }),
        `${s.you.name}: ${moveName(entry.you)}. ${s.opponent.name}: ${moveName(entry.opp)}. ${describe(entry, s)}`,
      ),
    );
  $('#log').replaceChildren(...items);
  $('#log-summary').textContent = s.history.length ? `Round log (${s.history.length})` : 'Round log';
}

function render(s) {
  if (s.status === 'waiting' || !s.opponent.joined) {
    showView('waiting');
    $('#waiting-code').textContent = s.code;
    const link = `${location.origin}/#${s.code}`;
    if ($('#invite-link').value !== link) $('#invite-link').value = link;
    return;
  }

  showView('game');

  if (s.round !== lastRound || s.status !== 'playing') selected = null;
  if (selected && !s.you.legal.includes(selected)) selected = null;
  const roundChanged = s.round !== lastRound;
  lastRound = s.round;

  $('#you-name').textContent = `${s.you.name} (you)`;
  $('#opp-name').textContent = s.opponent.name;
  $('#you-score').textContent = s.you.score;
  $('#opp-score').textContent = s.opponent.score;
  updateMeter($('#you-meter'), s.you.score);
  updateMeter($('#opp-meter'), s.opponent.score);
  $('#you-caption').textContent = captionFor(s.you.score, true);
  $('#opp-caption').textContent = captionFor(s.opponent.score, false);

  let status = statusText(s);
  if (opponentOffline(s)) {
    status += ` ${s.opponent.name} is offline. The timer is paused until they are back.`;
  }
  $('#status').textContent = status;

  renderReveal(s);
  lastHistoryLength = s.history.length;
  renderBanner(s);
  updatePicker(s);
  renderLog(s);
  updateTimer();

  if (roundChanged && s.status === 'playing') notice('');
}

// ----------------------------------------------------------------- rules ----

function renderRules() {
  const chipsFor = (attack) =>
    h(
      'span',
      { class: 'chips' },
      attack.counters.map((id) => h('span', { class: 'chip' }, h('i', { class: `dot ${id}` }), moveById[id].name)),
    );
  const rows = rules.attacks.map((attack) =>
    h('tr', {}, h('td', { text: attack.name }), h('td', { text: attack.value }), h('td', {}, chipsFor(attack))),
  );
  const list = (...items) => h('ul', {}, items.map((text) => h('li', { text })));

  $('#rules-body').replaceChildren(
    h('h3', { text: 'The basics' }),
    list(
      'Both players start at 0 and pick a move each round. Moves stay hidden until both players have locked in.',
      'You have 5 seconds each round. If you have not locked in when time runs out, Load is played for you.',
      'Load adds 1 point to your score.',
      "You can defend at any time. If you are attacked and use a matching defense, the attacker loses points equal to the attack's number.",
      'If you are attacked and do not use a matching defense, including by loading, you lose.',
      'An attack unlocks once your score reaches its number.',
    ),
    h('h3', { text: 'Special rules' }),
    list(
      'Dam against Rebound: the player who used Dam loses.',
      'Touch E against Rebound: the two scores are swapped.',
      "Touch E against any other defense, or against Load: the Touch E player takes the other player's whole score.",
      'Touch E against any other attack: the Touch E player loses.',
      'Both players attack: the bigger attack wins the game. If both use the same attack, each loses that many points and the game goes on.',
    ),
    h('h3', { text: 'Attacks' }),
    h(
      'table',
      { class: 'rules-table' },
      h('caption', { class: 'sr-only', text: 'Attacks, the score that unlocks them, and the defenses that answer them' }),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Attack' }), h('th', { scope: 'col', text: 'Unlocks at' }), h('th', { scope: 'col', text: 'Answered by' }))),
      h('tbody', {}, rows),
    ),
    h('h3', { text: 'Keyboard' }),
    list(
      'Load: L',
      'Defenses: Q Mag, W N.V, E Shield, R Rebound',
      'Attacks: A Path, S Boss, D Dam, F ICY, G Touch E, H Storm, J Beast, K Professor',
      'Enter locks in your highlighted move.',
    ),
  );
}

// ------------------------------------------------------------ copy link ----

async function copyLink() {
  const input = $('#invite-link');
  const button = $('#btn-copy');
  let copied = false;
  try {
    await navigator.clipboard.writeText(input.value);
    copied = true;
  } catch {
    input.select();
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
  }
  button.textContent = copied ? 'Copied' : 'Press Ctrl+C to copy';
  setTimeout(() => {
    button.textContent = 'Copy link';
  }, 1800);
}

// ------------------------------------------------------------------ keys ----

function onKeyDown(event) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  const target = event.target;
  const tag = target && target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'SUMMARY' || tag === 'A') return;
  if (target && target.isContentEditable) return;
  if (!state || state.status !== 'playing' || $('#view-game').hidden) return;

  if (event.key === 'Enter') {
    // Other buttons (Leave, Play again) keep their normal Enter behaviour.
    if (tag === 'BUTTON' && !target.classList.contains('move') && target.id !== 'btn-lock') return;
    event.preventDefault();
    lockIn();
    return;
  }

  if (event.key.length !== 1) return;
  const id = MOVE_BY_KEY[event.key.toLowerCase()];
  if (!id) return;
  event.preventDefault();
  chooseMove(id);
}

// ------------------------------------------------------------------ init ----

function wireEvents() {
  $('#btn-create').addEventListener('click', createRoom);
  $('#join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    joinRoom($('#code').value);
  });
  $('#code').addEventListener('input', (event) => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  $('#name').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (!$('#invite-note').hidden) joinRoom($('#code').value);
    else createRoom();
  });
  $('#btn-show-create').addEventListener('click', () => {
    $('#create-block').hidden = false;
    $('#btn-show-create').hidden = true;
    $('#invite-note').hidden = true;
    $('#code').value = '';
    history.replaceState(null, '', location.pathname);
  });

  $('#btn-copy').addEventListener('click', copyLink);
  $('#invite-link').addEventListener('focus', (event) => event.target.select());

  $('#btn-leave').addEventListener('click', () => {
    const playing = state && state.status === 'playing';
    if (playing && !window.confirm('Leave this game? Your opponent will be left waiting.')) return;
    goToLobby('');
  });

  $('#picker').addEventListener('click', (event) => {
    const button = event.target.closest('button.move');
    if (!button || button.disabled) return;
    chooseMove(button.dataset.move);
  });
  $('#btn-lock').addEventListener('click', lockIn);
  document.addEventListener('keydown', onKeyDown);

  $('#btn-rematch').addEventListener('click', async () => {
    if (!session) return;
    try {
      await api(`/api/rooms/${session.code}/rematch`, { method: 'POST', body: { token: session.token } });
    } catch (err) {
      notice(err.message);
    }
  });
}

async function init() {
  try {
    const stored = localStorage.getItem(NAME_KEY);
    if (stored) $('#name').value = stored;
  } catch {
    /* ignore */
  }

  try {
    rules = await api('/api/rules');
  } catch (err) {
    notice(err.message);
    return;
  }
  moveById = Object.fromEntries([rules.load, ...rules.defenses, ...rules.attacks].map((m) => [m.id, m]));
  rules.attacks.sort((a, b) => a.value - b.value);
  maxScore = rules.attacks[rules.attacks.length - 1].value;

  buildMeter($('#you-meter'));
  buildMeter($('#opp-meter'));
  buildPicker();
  renderRules();
  wireEvents();
  timerLoop = setInterval(updateTimer, 100);

  // On a wide screen the round log is open beside the board.
  if (window.matchMedia('(min-width: 961px)').matches) $('#log-box').open = true;

  const hashCode = parseHash();
  const stored = loadSession();
  if (stored && (!hashCode || hashCode === stored.code)) {
    // Resuming after a refresh: hide the lobby until the first state arrives.
    session = stored;
    showView('none');
    connect();
    return;
  }

  showView('lobby');
  playHeroMeter();
  if (hashCode) showInvite(hashCode);
}

init();
