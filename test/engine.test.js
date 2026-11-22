import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACKS,
  DEFENSES,
  getMove,
  isLegalMove,
  legalMoves,
  resolveRound,
} from '../src/engine.js';

// ------------------------------------------------------------- the tables ----

test('rule table matches the design', () => {
  const expected = {
    path: [1, ['mag', 'nv']],
    boss: [2, ['shield']],
    dam: [3, ['mag']],
    icy: [4, ['nv']],
    touche: [5, ['rebound']],
    storm: [7, ['nv']],
    beast: [10, ['shield']],
    professor: [12, ['mag']],
  };
  assert.deepEqual(Object.keys(ATTACKS).sort(), Object.keys(expected).sort());
  for (const [id, [value, counters]] of Object.entries(expected)) {
    assert.equal(ATTACKS[id].value, value, `${id} value`);
    assert.deepEqual(ATTACKS[id].counters, counters, `${id} counters`);
  }
  assert.deepEqual(Object.keys(DEFENSES).sort(), ['mag', 'nv', 'rebound', 'shield']);
});

test('at score 0 only Load and defenses are available', () => {
  assert.deepEqual(legalMoves(0).sort(), ['load', 'mag', 'nv', 'rebound', 'shield']);
});

test('attacks unlock exactly at their number', () => {
  assert.equal(isLegalMove('path', 0), false);
  assert.equal(isLegalMove('path', 1), true);
  assert.equal(isLegalMove('touche', 4), false);
  assert.equal(isLegalMove('touche', 5), true);
  assert.equal(isLegalMove('storm', 6), false);
  assert.equal(isLegalMove('storm', 7), true);
  assert.equal(isLegalMove('professor', 11), false);
  assert.equal(isLegalMove('professor', 12), true);
  assert.equal(isLegalMove('professor', 40), true);
});

test('unknown moves are rejected', () => {
  assert.equal(isLegalMove('nuke', 99), false);
  assert.equal(isLegalMove('toString', 99), false);
  assert.equal(isLegalMove('__proto__', 99), false);
  assert.throws(() => getMove('constructor'));
});

// ---------------------------------------------------- loading and defending ----

test('both players Load: both gain a point', () => {
  const r = resolveRound(['load', 'load'], [0, 0]);
  assert.deepEqual(r.scores, [1, 1]);
  assert.equal(r.finished, false);
  assert.equal(r.kind, 'quiet');
});

test('Load against a defense: only the loader gains', () => {
  assert.deepEqual(resolveRound(['load', 'shield'], [2, 2]).scores, [3, 2]);
  assert.deepEqual(resolveRound(['mag', 'load'], [2, 2]).scores, [2, 3]);
});

test('two defenses change nothing', () => {
  const r = resolveRound(['mag', 'shield'], [3, 3]);
  assert.deepEqual(r.scores, [3, 3]);
  assert.equal(r.finished, false);
});

// ------------------------------------------------------- ordinary attacks ----

test('blocked attack costs the attacker the attack number', () => {
  const r = resolveRound(['dam', 'mag'], [5, 2]);
  assert.equal(r.kind, 'blocked');
  assert.equal(r.attacker, 0);
  assert.equal(r.penalty, 3);
  assert.deepEqual(r.scores, [2, 2]);
  assert.equal(r.finished, false);
});

test('blocked attack from seat 1 works the same way', () => {
  const r = resolveRound(['shield', 'beast'], [0, 10]);
  assert.equal(r.kind, 'blocked');
  assert.equal(r.attacker, 1);
  assert.deepEqual(r.scores, [0, 0]);
});

test('every normal attack is blocked by each of its listed defenses', () => {
  const normal = {
    path: ['mag', 'nv'],
    boss: ['shield'],
    dam: ['mag'],
    icy: ['nv'],
    storm: ['nv'],
    beast: ['shield'],
    professor: ['mag'],
  };
  for (const [attack, defenses] of Object.entries(normal)) {
    for (const defense of defenses) {
      const r = resolveRound([attack, defense], [12, 0]);
      assert.equal(r.kind, 'blocked', `${attack} vs ${defense}`);
      assert.equal(r.scores[0], 12 - ATTACKS[attack].value);
      assert.equal(r.finished, false);
    }
  }
});

test('wrong defense loses (normal attacks)', () => {
  for (const [attack, wrong] of [
    ['path', 'shield'],
    ['path', 'rebound'],
    ['boss', 'mag'],
    ['boss', 'rebound'],
    ['icy', 'mag'],
    ['storm', 'rebound'],
    ['beast', 'nv'],
    ['professor', 'shield'],
    ['dam', 'nv'],
    ['dam', 'shield'],
  ]) {
    const r = resolveRound([attack, wrong], [12, 0]);
    assert.equal(r.kind, 'hit', `${attack} vs ${wrong}`);
    assert.equal(r.winner, 0);
    assert.equal(r.finished, true);
  }
});

test('not defending (Load) against a normal attack loses', () => {
  const r = resolveRound(['load', 'dam'], [0, 3]);
  assert.equal(r.kind, 'hit');
  assert.equal(r.winner, 1);
  assert.equal(r.finished, true);
});

// ------------------------------------------------------------------ Dam ----

test('Dam against Rebound: the attacker loses', () => {
  const r = resolveRound(['dam', 'rebound'], [3, 0]);
  assert.equal(r.kind, 'reflect');
  assert.equal(r.finished, true);
  assert.equal(r.winner, 1);
  assert.equal(r.attacker, 0);
  const r2 = resolveRound(['rebound', 'dam'], [0, 8]);
  assert.equal(r2.kind, 'reflect');
  assert.equal(r2.winner, 0);
  assert.equal(r2.attacker, 1);
});

test('Dam is still blocked normally by Mag', () => {
  assert.equal(resolveRound(['dam', 'mag'], [3, 0]).kind, 'blocked');
});

// -------------------------------------------------------------- Touch E ----

test('Touch E against Rebound: the scores are swapped', () => {
  const r = resolveRound(['touche', 'rebound'], [5, 2]);
  assert.equal(r.kind, 'swap');
  assert.deepEqual(r.scores, [2, 5]);
  assert.equal(r.finished, false);
  assert.equal(r.attacker, 0);
  const r2 = resolveRound(['rebound', 'touche'], [9, 6]);
  assert.deepEqual(r2.scores, [6, 9]);
  assert.equal(r2.attacker, 1);
});

test('Touch E against any other defense: the attacker absorbs the defender score', () => {
  for (const defense of ['mag', 'nv', 'shield']) {
    const r = resolveRound(['touche', defense], [5, 4]);
    assert.equal(r.kind, 'absorb', defense);
    assert.deepEqual(r.scores, [9, 0], defense);
    assert.equal(r.absorbed, 4);
    assert.equal(r.finished, false);
  }
  const r = resolveRound(['nv', 'touche'], [3, 6]);
  assert.deepEqual(r.scores, [0, 9]);
  assert.equal(r.attacker, 1);
});

test('Touch E against Load: the attacker absorbs the score the defender had before the round', () => {
  const r = resolveRound(['touche', 'load'], [5, 4]);
  assert.equal(r.kind, 'absorb');
  assert.deepEqual(r.scores, [9, 0]);
  assert.equal(r.absorbed, 4);
});

test('absorbing a score of zero changes nothing', () => {
  const r = resolveRound(['touche', 'mag'], [5, 0]);
  assert.equal(r.kind, 'absorb');
  assert.deepEqual(r.scores, [5, 0]);
  assert.equal(r.absorbed, 0);
});

test('Touch E against any other attack: the Touch E player loses', () => {
  for (const other of ['path', 'boss', 'dam', 'icy', 'storm', 'beast', 'professor']) {
    const r = resolveRound(['touche', other], [12, 12]);
    assert.equal(r.kind, 'touch-loses', other);
    assert.equal(r.finished, true);
    assert.equal(r.winner, 1, other);
    assert.equal(r.attacker, 0);
    const mirrored = resolveRound([other, 'touche'], [12, 12]);
    assert.equal(mirrored.winner, 0, other);
    assert.equal(mirrored.attacker, 1);
  }
});

// -------------------------------------------------------- both players attack ----

test('both attack: the bigger attack wins the game', () => {
  const r = resolveRound(['storm', 'boss'], [7, 2]);
  assert.equal(r.kind, 'clash');
  assert.equal(r.winner, 0);
  assert.equal(r.finished, true);
  assert.equal(resolveRound(['path', 'icy'], [1, 4]).winner, 1);
  assert.equal(resolveRound(['professor', 'beast'], [12, 10]).winner, 0);
});

test('both attack with the same attack: both lose that many points, game goes on', () => {
  const r = resolveRound(['dam', 'dam'], [5, 3]);
  assert.equal(r.kind, 'clash-same');
  assert.equal(r.penalty, 3);
  assert.deepEqual(r.scores, [2, 0]);
  assert.equal(r.finished, false);
  assert.equal(r.winner, null);
});

test('same Touch E from both players: both lose 5 points (not the Touch E loss rule)', () => {
  const r = resolveRound(['touche', 'touche'], [8, 5]);
  assert.equal(r.kind, 'clash-same');
  assert.deepEqual(r.scores, [3, 0]);
  assert.equal(r.finished, false);
});

test('same attack from both: scores never go below zero', () => {
  const r = resolveRound(['professor', 'professor'], [12, 12]);
  assert.deepEqual(r.scores, [0, 0]);
});

test('resolveRound does not mutate the input scores', () => {
  const scores = [5, 4];
  resolveRound(['touche', 'mag'], scores);
  resolveRound(['load', 'load'], scores);
  assert.deepEqual(scores, [5, 4]);
});
