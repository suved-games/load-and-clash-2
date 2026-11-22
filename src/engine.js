// Game rules for "Load & Clash". Pure functions, no I/O, so the server and the
// tests share exactly the same logic.
//
// Rules, as described by the game's designer:
//  - Two players start at score 0 and pick a move each round, in secret.
//  - Load: your score goes up by 1.
//  - Defenses (Mag, N.V, Shield, Rebound) can be used at any time.
//  - Each attack unlocks at a score equal to its number.
//  - If the defender uses a matching defense, the attacker's score drops by the
//    attack's number. If the defender uses anything else (including Load),
//    the defender loses. Three attacks have special rules:
//      Dam    + Rebound            -> the attacker loses.
//      Touch E + Rebound           -> the two scores are swapped.
//      Touch E + anything else     -> the attacker absorbs the defender's whole
//                                     score (also when the defender loaded).
//  - Both players attack in the same round:
//      the same attack             -> both scores drop by that attack's number;
//      Touch E vs another attack   -> the Touch E player loses;
//      any other two attacks       -> the bigger attack wins.

export const LOAD = Object.freeze({ id: 'load', type: 'load', name: 'Load' });

export const DEFENSES = Object.freeze({
  mag: { id: 'mag', type: 'defense', name: 'Mag' },
  nv: { id: 'nv', type: 'defense', name: 'N.V' },
  shield: { id: 'shield', type: 'defense', name: 'Shield' },
  rebound: { id: 'rebound', type: 'defense', name: 'Rebound' },
});

// value = score needed to unlock = score the attacker loses when blocked.
// `counters` lists the defenses that answer the attack. It is also what the
// interface shows. Touch E lists Rebound because Rebound is its special answer
// (the swap), even though the engine handles Touch E on its own below.
export const ATTACKS = Object.freeze({
  path: { id: 'path', type: 'attack', name: 'Path', value: 1, counters: ['mag', 'nv'] },
  boss: { id: 'boss', type: 'attack', name: 'Boss', value: 2, counters: ['shield'] },
  dam: { id: 'dam', type: 'attack', name: 'Dam', value: 3, counters: ['mag'] },
  icy: { id: 'icy', type: 'attack', name: 'ICY', value: 4, counters: ['nv'] },
  touche: { id: 'touche', type: 'attack', name: 'Touch E', value: 5, counters: ['rebound'] },
  storm: { id: 'storm', type: 'attack', name: 'Storm', value: 7, counters: ['nv'] },
  beast: { id: 'beast', type: 'attack', name: 'Beast', value: 10, counters: ['shield'] },
  professor: { id: 'professor', type: 'attack', name: 'Professor', value: 12, counters: ['mag'] },
});

const MOVES = { load: LOAD, ...DEFENSES, ...ATTACKS };

export function getMove(id) {
  const move = Object.prototype.hasOwnProperty.call(MOVES, id) ? MOVES[id] : null;
  if (!move) throw new Error(`Unknown move: ${id}`);
  return move;
}

export function isKnownMove(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(MOVES, id);
}

/** A move is legal if it exists and, for attacks, the score has unlocked it. */
export function isLegalMove(id, score) {
  if (!isKnownMove(id)) return false;
  const move = MOVES[id];
  return move.type !== 'attack' || score >= move.value;
}

export function legalMoves(score) {
  return Object.keys(MOVES).filter((id) => isLegalMove(id, score));
}

/** Plain-data description of the rules, sent to the browser so the UI never
 *  has to duplicate them. */
export function rulesForClient() {
  return {
    load: LOAD,
    defenses: Object.values(DEFENSES),
    attacks: Object.values(ATTACKS),
  };
}

/**
 * Resolve one round.
 *
 * @param {[string, string]} moveIds  moves chosen by seat 0 and seat 1
 * @param {[number, number]} scores   scores before the round
 * @returns {{
 *   kind: 'quiet'|'blocked'|'hit'|'reflect'|'swap'|'absorb'|'clash'|'clash-same'|'touch-loses',
 *   scores: [number, number],   scores after the round
 *   finished: boolean,
 *   winner: 0|1|null,
 *   attacker: 0|1|null,        the seat that attacked (or, for 'touch-loses', the Touch E seat)
 *   penalty: number,           points lost by the attacker ('blocked') or by both ('clash-same')
 *   absorbed: number,          points the attacker took from the defender ('absorb')
 * }}
 */
export function resolveRound(moveIds, scores) {
  const [a, b] = moveIds.map(getMove);
  const next = [scores[0], scores[1]];
  const out = {
    kind: 'quiet',
    scores: next,
    finished: false,
    winner: null,
    attacker: null,
    penalty: 0,
    absorbed: 0,
  };

  const finish = (kind, winner, attacker = null) => {
    out.kind = kind;
    out.finished = true;
    out.winner = winner;
    out.attacker = attacker;
    return out;
  };

  // Both players attack.
  if (a.type === 'attack' && b.type === 'attack') {
    if (a.id === b.id) {
      out.kind = 'clash-same';
      out.penalty = a.value;
      next[0] = Math.max(0, next[0] - a.value);
      next[1] = Math.max(0, next[1] - a.value);
      return out;
    }
    if (a.id === 'touche') return finish('touch-loses', 1, 0);
    if (b.id === 'touche') return finish('touch-loses', 0, 1);
    return finish('clash', a.value > b.value ? 0 : 1);
  }

  // One attack against something that is not an attack (a defense or Load).
  if (a.type === 'attack' || b.type === 'attack') {
    const attacker = a.type === 'attack' ? 0 : 1;
    const defender = 1 - attacker;
    const attack = attacker === 0 ? a : b;
    const reply = attacker === 0 ? b : a;
    out.attacker = attacker;

    if (attack.id === 'touche') {
      if (reply.id === 'rebound') {
        out.kind = 'swap';
        next[0] = scores[1];
        next[1] = scores[0];
        return out;
      }
      // Any other defense, or Load: the attacker takes the defender's whole
      // score as it stood at the start of the round.
      out.kind = 'absorb';
      out.absorbed = scores[defender];
      next[attacker] = scores[attacker] + scores[defender];
      next[defender] = 0;
      return out;
    }

    if (attack.id === 'dam' && reply.id === 'rebound') {
      return finish('reflect', defender, attacker);
    }

    if (reply.type === 'defense' && attack.counters.includes(reply.id)) {
      out.kind = 'blocked';
      out.penalty = attack.value;
      next[attacker] = Math.max(0, scores[attacker] - attack.value);
      return out;
    }

    return finish('hit', attacker, attacker);
  }

  // No attacks: only Load changes anything.
  if (a.type === 'load') next[0] += 1;
  if (b.type === 'load') next[1] += 1;
  return out;
}
