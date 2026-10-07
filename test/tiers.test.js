const test = require('node:test');
const assert = require('node:assert/strict');
const { TIERS, SCORE, groupTierOf, compareGroup } = require('../lib/tiers');

// Places from the demo board, named for readability.
const S = 'S', A = 'A', B = 'B', C = 'C';

test('four tiers, S counts 4 down to C counts 1', () => {
  assert.deepEqual(TIERS, ['S', 'A', 'B', 'C']);
  assert.deepEqual(SCORE, { S: 4, A: 3, B: 2, C: 1 });
});

test('an empty list gives a null tier', () => {
  assert.deepEqual(groupTierOf([]), { tier: null, mean: null, count: 0, agree: 0 });
  assert.deepEqual(groupTierOf(undefined), { tier: null, mean: null, count: 0, agree: 0 });
});

test('one S gives S', () => {
  const g = groupTierOf([{ tier: S }]);
  assert.equal(g.tier, 'S');
  assert.equal(g.count, 1);
  assert.equal(g.agree, 1);
});

test('S plus A has mean 3.5, and the exact half rounds up to S', () => {
  const g = groupTierOf([{ tier: S }, { tier: A }]);
  assert.equal(g.mean, 3.5);
  assert.equal(g.tier, 'S');
});

test('A plus B has mean 2.5, and the exact half rounds up to A', () => {
  const g = groupTierOf([{ tier: A }, { tier: B }]);
  assert.equal(g.mean, 2.5);
  assert.equal(g.tier, 'A');
});

test('the 1.5 line splits B from C: mean 1.5 is B, mean 1.4 is C', () => {
  // C + B is exactly 1.5 → B.
  assert.equal(groupTierOf([{ tier: C }, { tier: B }]).tier, 'B');
  // C, C, C, B, B is 7/5 = 1.4, just under the line → C.
  assert.equal(groupTierOf([{ tier: C }, { tier: C }, { tier: C }, { tier: B }, { tier: B }]).tier, 'C');
});

test('all Cs give C', () => {
  assert.equal(groupTierOf([{ tier: C }, { tier: C }]).tier, 'C');
});

test('agree counts the placements that match the group tier', () => {
  // Two A and one S: mean 3.33, group A, two people agree.
  const g = groupTierOf([{ tier: A }, { tier: A }, { tier: S }]);
  assert.equal(g.tier, 'A');
  assert.equal(g.agree, 2);
  assert.equal(g.count, 3);
});

test('demo row 900003, Telegraph Tacos: group S, 3 of 5 agree', () => {
  // ana S, ben S, cleo A, dev S, viewer A — as seeded for ?demo=1.
  const g = groupTierOf([{ tier: S }, { tier: S }, { tier: A }, { tier: S }, { tier: A }]);
  assert.equal(g.tier, 'S');
  assert.equal(g.mean, 3.6);
  assert.equal(g.count, 5);
  assert.equal(g.agree, 3);
});

test('demo row 900006, Dolores Dosa: group A', () => {
  // ana A, ben A, cleo B, viewer S.
  const g = groupTierOf([{ tier: A }, { tier: A }, { tier: B }, { tier: S }]);
  assert.equal(g.tier, 'A');
  assert.equal(g.agree, 2);
});

test('compareGroup orders by mean descending', () => {
  const high = { name: 'high', group: { mean: 3.5, count: 1 } };
  const low = { name: 'low', group: { mean: 2.5, count: 5 } };
  assert.equal(compareGroup(high, low) < 0, true);
  assert.equal(compareGroup(low, high) > 0, true);
});

test('compareGroup breaks a mean tie by count, then by name', () => {
  const more = { name: 'zeta', group: { mean: 3, count: 4 } };
  const fewer = { name: 'alpha', group: { mean: 3, count: 2 } };
  // Same mean: more rankers first, name second.
  assert.equal(compareGroup(more, fewer) < 0, true);
  const bName = { name: 'beta', group: { mean: 3, count: 2 } };
  const aName = { name: 'Alpha', group: { mean: 3, count: 2 } };
  assert.equal(compareGroup(bName, aName) > 0, true);
});

test('compareGroup puts never-ranked restaurants last', () => {
  const ranked = { name: 'zeta', group: { mean: 1, count: 3 } };
  const unranked = { name: 'alpha', group: { tier: null, mean: null, count: 0 } };
  assert.equal(compareGroup(unranked, ranked) > 0, true);
});