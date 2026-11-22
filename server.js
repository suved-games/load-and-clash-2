// Load & Clash: zero-dependency multiplayer server.
//
// Transport: plain HTTP. Each player opens a Server-Sent Events stream to
// receive live state, and POSTs their moves. Some hosts and phone networks
// buffer streams, so the same state can also be fetched by polling
// (GET /api/rooms/:code/state). No WebSocket library is needed, so there is
// nothing to install and it runs on any Node 20+ host.
//
// Moves are secret until both players have locked in: the state sent to a
// player only says *whether* the opponent has locked in, never what they chose.
//
// Round timer: each round lasts ROUND_MS (5 seconds). A player who has not
// locked in when it runs out plays Load. The timer only runs while both
// players are connected, so a dropped connection never costs anyone a game.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomInt } from 'node:crypto';
import {
  isKnownMove,
  isLegalMove,
  legalMoves,
  resolveRound,
  rulesForClient,
} from './src/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROUND_MS = Number(process.env.ROUND_MS) || 5000;
// Render (and most hosts) put a proxy in front of the server. RENDER is set
// automatically on Render; set TRUST_PROXY=1 yourself on other hosts.
const TRUST_PROXY = Boolean(process.env.TRUST_PROXY || process.env.RENDER);

const MAX_ROOMS = 5000;
const ROOM_IDLE_MS = 3 * 60 * 60 * 1000; // drop rooms nobody has touched for 3 hours
const POLL_GRACE_MS = 5000; // a polling player counts as connected for this long after their last poll
const MAX_HISTORY = 200;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const CODE_LENGTH = 5;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/** @type {Map<string, any>} */
const rooms = new Map();

// ---------------------------------------------------------------- rooms ----

function cleanName(raw, fallback) {
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
  return name || fallback;
}

function makePlayer(name) {
  return { token: randomBytes(16).toString('hex'), name, streams: new Set(), lastPoll: 0 };
}

function isConnected(player, now = Date.now()) {
  return Boolean(player) && (player.streams.size > 0 || now - player.lastPoll < POLL_GRACE_MS);
}

function bothConnected(room, now = Date.now()) {
  return isConnected(room.players[0], now) && isConnected(room.players[1], now);
}

function newCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('Could not allocate a room code');
}

function createRoom(hostName) {
  const code = newCode();
  const host = makePlayer(hostName);
  const room = {
    code,
    lastActive: Date.now(),
    players: [host, null],
    status: 'waiting', // waiting | playing | finished
    scores: [0, 0],
    pending: [null, null],
    round: 1,
    history: [],
    result: null, // { winner: 0|1 }
    rematch: [false, false],
    deadline: null, // when the current round's timer ends (ms since epoch), or null while paused
    version: 0, // goes up every time the state changes, so pollers can skip unchanged state
    conn: [false, false], // last connection state we told the players about
  };
  rooms.set(code, room);
  return { room, player: host };
}

function seatOf(room, token) {
  if (typeof token !== 'string' || token.length === 0) return -1;
  for (let seat = 0; seat < 2; seat++) {
    const p = room.players[seat];
    if (p && p.token === token) return seat;
  }
  return -1;
}

function resetMatch(room) {
  room.scores = [0, 0];
  room.pending = [null, null];
  room.round = 1;
  room.history = [];
  room.result = null;
  room.rematch = [false, false];
  room.status = 'playing';
  room.deadline = null; // the timer tick starts it once both players are connected
}

// ----------------------------------------------------------- state views ----

function historyFor(entry, seat) {
  const opp = 1 - seat;
  return {
    round: entry.round,
    you: entry.moves[seat],
    opp: entry.moves[opp],
    kind: entry.kind,
    attacker: entry.attacker === null ? null : entry.attacker === seat ? 'you' : 'opp',
    penalty: entry.penalty,
    absorbed: entry.absorbed,
    timedOut: { you: entry.timedOut[seat], opp: entry.timedOut[opp] },
    scores: { you: entry.scores[seat], opp: entry.scores[opp] },
    result: !entry.finished ? null : entry.winner === seat ? 'win' : 'lose',
  };
}

/** What one player is allowed to know. Never includes the opponent's pending move. */
function viewFor(room, seat) {
  const opp = 1 - seat;
  const me = room.players[seat];
  const them = room.players[opp];
  const playing = room.status === 'playing';
  const now = Date.now();
  return {
    code: room.code,
    version: room.version,
    serverNow: now,
    roundMs: ROUND_MS,
    deadline: playing ? room.deadline : null,
    status: room.status,
    round: room.round,
    result: !room.result ? null : room.result.winner === seat ? 'win' : 'lose',
    you: {
      name: me.name,
      score: room.scores[seat],
      locked: room.pending[seat] !== null,
      legal: playing ? legalMoves(room.scores[seat]) : [],
      wantsRematch: room.rematch[seat],
    },
    opponent: {
      name: them ? them.name : null,
      joined: Boolean(them),
      connected: isConnected(them, now),
      score: room.scores[opp],
      locked: room.pending[opp] !== null,
      wantsRematch: room.rematch[opp],
    },
    history: room.history.map((entry) => historyFor(entry, seat)),
  };
}

function send(res, payload) {
  res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(room) {
  room.version += 1;
  room.lastActive = Date.now();
  for (let seat = 0; seat < 2; seat++) {
    const player = room.players[seat];
    if (!player) continue;
    const view = viewFor(room, seat);
    for (const res of player.streams) send(res, view);
  }
}

// ----------------------------------------------------- rounds and timer ----

/** Resolve the round using both pending moves. `timedOut` says whose move was
 *  filled in with Load because the timer ran out. */
function settleRound(room, timedOut = [false, false]) {
  const moves = [room.pending[0], room.pending[1]];
  const outcome = resolveRound(moves, room.scores);
  room.scores = outcome.scores;
  room.history.push({
    round: room.round,
    moves,
    kind: outcome.kind,
    attacker: outcome.attacker,
    penalty: outcome.penalty,
    absorbed: outcome.absorbed,
    scores: [...outcome.scores],
    finished: outcome.finished,
    winner: outcome.winner,
    timedOut,
  });
  if (room.history.length > MAX_HISTORY) room.history.shift();
  room.pending = [null, null];
  room.deadline = null;
  if (outcome.finished) {
    room.status = 'finished';
    room.result = { winner: outcome.winner };
  } else {
    room.round += 1;
    if (bothConnected(room)) room.deadline = Date.now() + ROUND_MS;
  }
}

/** The timer ran out: anyone who has not locked in plays Load. */
function expireRound(room) {
  const timedOut = [room.pending[0] === null, room.pending[1] === null];
  for (let seat = 0; seat < 2; seat++) if (room.pending[seat] === null) room.pending[seat] = 'load';
  settleRound(room, timedOut);
  broadcast(room);
}

/** Starts, pauses or expires one room's round timer, and tells the players if
 *  anyone's connection changed. Called whenever a connection opens or closes,
 *  and several times a second by tick(). */
function updateRoom(room, now = Date.now()) {
  const conn = [isConnected(room.players[0], now), isConnected(room.players[1], now)];
  let changed = conn[0] !== room.conn[0] || conn[1] !== room.conn[1];
  room.conn = conn;

  if (room.status === 'playing') {
    const both = conn[0] && conn[1];
    if (!both && room.deadline !== null) {
      room.deadline = null; // pause while someone is offline
      changed = true;
    } else if (both && room.deadline === null) {
      room.deadline = now + ROUND_MS;
      changed = true;
    } else if (room.deadline !== null && now >= room.deadline) {
      expireRound(room);
      return;
    }
  } else if (room.deadline !== null) {
    room.deadline = null;
  }

  if (changed) broadcast(room);
}

function tick() {
  const now = Date.now();
  for (const room of rooms.values()) updateRoom(room, now);
}

// --------------------------------------------------------------- helpers ----

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

async function readJson(req, limit = 4096) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
}

function clientIp(req) {
  const forwarded = TRUST_PROXY ? req.headers['x-forwarded-for'] : null;
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// Small guard against someone scripting thousands of rooms: 20 new rooms per
// IP address every 10 minutes.
const createLog = new Map();
function allowCreate(ip) {
  const now = Date.now();
  const recent = (createLog.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (recent.length >= 20) {
    createLog.set(ip, recent);
    return false;
  }
  recent.push(now);
  createLog.set(ip, recent);
  return true;
}

function getRoom(code) {
  const room = rooms.get(String(code).toUpperCase());
  if (!room) throw new HttpError(404, 'Room not found. Check the code and try again.');
  return room;
}

function requireSeat(room, token) {
  const seat = seatOf(room, token);
  if (seat === -1) throw new HttpError(403, 'You are not a player in this room.');
  return seat;
}

// ------------------------------------------------------------------ API ----

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/rules' && method === 'GET') {
    return json(res, 200, rulesForClient());
  }

  if (pathname === '/api/rooms' && method === 'POST') {
    if (!allowCreate(clientIp(req))) {
      throw new HttpError(429, 'Too many rooms created. Wait a few minutes and try again.');
    }
    if (rooms.size >= MAX_ROOMS) throw new HttpError(503, 'The server is full. Try again later.');
    const body = await readJson(req);
    const { room, player } = createRoom(cleanName(body.name, 'Player 1'));
    return json(res, 201, { code: room.code, token: player.token, seat: 0 });
  }

  const match = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)(?:\/(events|state|join|move|rematch))?$/);
  if (!match) throw new HttpError(404, 'Not found.');
  const [, rawCode, action] = match;
  const code = rawCode.toUpperCase();
  if (!CODE_RE.test(code)) throw new HttpError(404, 'Room not found. Check the code and try again.');
  const room = getRoom(code);

  // Is the room there, and does it have space? Used by invite links.
  if (!action && method === 'GET') {
    return json(res, 200, { code: room.code, status: room.status, full: Boolean(room.players[1]) });
  }

  if (action === 'join' && method === 'POST') {
    if (room.players[1]) throw new HttpError(409, 'This room already has two players.');
    const body = await readJson(req);
    const guest = makePlayer(cleanName(body.name, 'Player 2'));
    room.players[1] = guest;
    resetMatch(room);
    broadcast(room);
    return json(res, 200, { code: room.code, token: guest.token, seat: 1 });
  }

  if (action === 'events' && method === 'GET') {
    const seat = requireSeat(room, url.searchParams.get('token'));
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 2000\n:${' '.repeat(2048)}\n\n`); // padding helps proxies that buffer small writes
    const player = room.players[seat];
    player.streams.add(res);
    updateRoom(room); // tells the opponent this player is connected, and may start the timer
    send(res, viewFor(room, seat));
    req.on('close', () => {
      player.streams.delete(res);
      if (rooms.get(code) === room) updateRoom(room); // tells the opponent, and pauses the timer
    });
    return undefined;
  }

  // Polling fallback: same state as the stream. `v` is the version the player
  // already has; if nothing changed the reply is tiny.
  if (action === 'state' && method === 'GET') {
    const seat = requireSeat(room, url.searchParams.get('token'));
    const player = room.players[seat];
    player.lastPoll = Date.now();
    updateRoom(room); // a player who just started polling is now connected
    const since = Number(url.searchParams.get('v'));
    if (since === room.version) return json(res, 200, { unchanged: true, serverNow: Date.now() });
    return json(res, 200, viewFor(room, seat));
  }

  if (action === 'move' && method === 'POST') {
    const body = await readJson(req);
    const seat = requireSeat(room, body.token);
    if (room.status !== 'playing') throw new HttpError(409, 'The game is not in progress.');
    if (body.round !== undefined && body.round !== room.round) {
      throw new HttpError(409, 'That round already ended. Choose your move for the new round.');
    }
    if (room.pending[seat] !== null) throw new HttpError(409, 'You already locked in a move this round.');
    if (!isKnownMove(body.move)) throw new HttpError(400, 'Unknown move.');
    if (!isLegalMove(body.move, room.scores[seat])) {
      throw new HttpError(400, 'That attack is not unlocked yet. Build up your score first.');
    }
    if (room.deadline !== null && Date.now() >= room.deadline) {
      throw new HttpError(409, 'Time ran out for this round.');
    }
    room.pending[seat] = body.move;
    if (room.pending[0] !== null && room.pending[1] !== null) settleRound(room);
    broadcast(room);
    return json(res, 200, { ok: true });
  }

  if (action === 'rematch' && method === 'POST') {
    const body = await readJson(req);
    const seat = requireSeat(room, body.token);
    if (room.status !== 'finished') throw new HttpError(409, 'The game is not over yet.');
    room.rematch[seat] = true;
    if (room.rematch[0] && room.rematch[1]) resetMatch(room);
    broadcast(room);
    return json(res, 200, { ok: true });
  }

  throw new HttpError(405, 'Method not allowed.');
}

// -------------------------------------------------------- static files ----

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'Bad request.');
  }
  if (rel.includes('\0')) throw new HttpError(400, 'Bad request.');
  if (rel === '/guide') rel = '/guide.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Forbidden.');

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  });
}

// --------------------------------------------------------------- server ----

const server = http.createServer(async (req, res) => {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, rooms: rooms.size });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (res.headersSent) {
      res.end();
      return undefined;
    }
    return json(res, status, { error: status === 500 ? 'Something went wrong on the server.' : err.message });
  }
});

// Keep SSE connections alive through proxies, run the round timers, and drop
// abandoned rooms.
const keepAlive = setInterval(() => {
  for (const room of rooms.values()) {
    for (const player of room.players) {
      if (player) for (const res of player.streams) res.write(': ping\n\n');
    }
  }
}, 20_000);

const ticker = setInterval(tick, 200);

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const connected = room.players.some((p) => isConnected(p, now));
    if (!connected && now - room.lastActive > ROOM_IDLE_MS) rooms.delete(code);
  }
}, 5 * 60 * 1000);
keepAlive.unref();
ticker.unref();
sweeper.unref();

function shutdown() {
  console.log('Shutting down...');
  server.close(() => process.exit(0));
  for (const room of rooms.values()) {
    for (const player of room.players) {
      if (player) for (const res of player.streams) res.end();
    }
  }
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.log(`Load & Clash is running at http://localhost:${PORT}`);
});
