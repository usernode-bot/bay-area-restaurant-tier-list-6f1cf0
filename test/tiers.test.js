const test = require('node:test');
const assert = require('node:assert/strict');
const { TIERS, SCORE, groupTierOf, compareGroup } = require('../lib/tiers');

// Places from the demo board, named for readability.
const S = 'S', A = 'A', B = 'B', C = 'C', D = 'D', F = 'F';

test('six tiers, S counts 6 down to F counts 1', () => {
  assert.deepEqual(TIERS, ['S', 'A', 'B', 'C', 'D', 'F']);
  assert.deepEqual(SCORE, { S: 6, A: 5, B: 4, C: 3, D: 2, F: 1 });
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

test('S plus A has mean 5.5, and the exact half rounds up to S', () => {
  const g = groupTierOf([{ tier: S }, { tier: A }]);
  assert.equal(g.mean, 5.5);
  assert.equal(g.tier, 'S');
});

test('A plus B has mean 4.5, and the exact half rounds up to A', () => {
  const g = groupTierOf([{ tier: A }, { tier: B }]);
  assert.equal(g.mean, 4.5);
  assert.equal(g.tier, 'A');
});

test('the 3.5 line splits B from C: mean 3.5 is B, mean 3.4 is C', () => {
  // C + B is exactly 3.5 → B.
  assert.equal(groupTierOf([{ tier: C }, { tier: B }]).tier, 'B');
  // C, C, C, B, B is 17/5 = 3.4, just under the line → C.
  assert.equal(groupTierOf([{ tier: C }, { tier: C }, { tier: C }, { tier: B }, { tier: B }]).tier, 'C');
});

test('all Cs give C', () => {
  assert.equal(groupTierOf([{ tier: C }, { tier: C }]).tier, 'C');
});

test('C plus D has mean 2.5, and the exact half rounds up to C', () => {
  const g = groupTierOf([{ tier: C }, { tier: D }]);
  assert.equal(g.mean, 2.5);
  assert.equal(g.tier, 'C');
});

test('D plus F has mean 1.5, and the exact half rounds up to D', () => {
  const g = groupTierOf([{ tier: D }, { tier: F }]);
  assert.equal(g.mean, 1.5);
  assert.equal(g.tier, 'D');
});

test('all Ds give D; all Fs give F', () => {
  assert.equal(groupTierOf([{ tier: D }, { tier: D }, { tier: D }]).tier, 'D');
  assert.equal(groupTierOf([{ tier: F }, { tier: F }]).tier, 'F');
  const f = groupTierOf([{ tier: F }]);
  assert.equal(f.mean, 1);
  assert.equal(f.agree, 1);
});

test('every list using only S to C keeps the group tier it had before', () => {
  // The scale moved from S=4 … C=1 to S=6 … F=1 and every cut-off up by 2.
  // Any list of S to C letters therefore raises its mean by exactly 2 and
  // lands on the same letter — D and F only fill up as people use them.
  const OLD_SCORE = { S: 4, A: 3, B: 2, C: 1 };
  const oldTier = (mean) =>
    mean >= 3.5 ? 'S' : mean >= 2.5 ? 'A' : mean >= 1.5 ? 'B' : 'C';
  const lists = [[]];
  for (let size = 1; size <= 5; size++) {
    // All multisets of S/A/B/C of this size: count each letter's share.
    const grow = (prefix, remaining) => {
      if (remaining === 0) { lists.push(prefix); return; }
      const start = prefix.length ? ['S', 'A', 'B', 'C'].indexOf(prefix[prefix.length - 1]) : 0;
      for (const t of ['S', 'A', 'B', 'C'].slice(start)) grow(prefix.concat(t), remaining - 1);
    };
    grow([], size);
  }
  for (const list of lists) {
    const placements = list.map((t) => ({ tier: t }));
    if (!list.length) {
      assert.deepEqual(groupTierOf(placements), { tier: null, mean: null, count: 0, agree: 0 });
      continue;
    }
    const oldMean = list.reduce((sum, t) => sum + OLD_SCORE[t], 0) / list.length;
    assert.equal(groupTierOf(placements).tier, oldTier(oldMean), JSON.stringify(list));
  }
});

test('agree counts the placements that match the group tier', () => {
  // Two A and one S: mean 5.33, group A, two people agree.
  const g = groupTierOf([{ tier: A }, { tier: A }, { tier: S }]);
  assert.equal(g.tier, 'A');
  assert.equal(g.agree, 2);
  assert.equal(g.count, 3);
});

test('demo row 900003, Telegraph Tacos: group S, 3 of 5 agree', () => {
  // ana S, ben S, cleo A, dev S, viewer A — as seeded for ?demo=1.
  const g = groupTierOf([{ tier: S }, { tier: S }, { tier: A }, { tier: S }, { tier: A }]);
  assert.equal(g.tier, 'S');
  assert.equal(g.mean, 5.6);
  assert.equal(g.count, 5);
  assert.equal(g.agree, 3);
});

test('demo row 900006, Dolores Dosa: group A', () => {
  // ana A, ben A, cleo B, viewer S.
  const g = groupTierOf([{ tier: A }, { tier: A }, { tier: B }, { tier: S }]);
  assert.equal(g.tier, 'A');
  assert.equal(g.agree, 2);
});

test('demo row 900019, Late Night Nachos: group D, 2 of 4 agree', () => {
  // ana D, ben D, cleo C, dev F.
  const g = groupTierOf([{ tier: D }, { tier: D }, { tier: C }, { tier: F }]);
  assert.equal(g.tier, 'D');
  assert.equal(g.mean, 2);
  assert.equal(g.count, 4);
  assert.equal(g.agree, 2);
  // With the viewer's own F (seeded on their first ?demo=1 visit) the mean
  // is 1.8 — still D.
  const withViewer = groupTierOf([{ tier: D }, { tier: D }, { tier: C }, { tier: F }, { tier: F }]);
  assert.equal(withViewer.tier, 'D');
  assert.equal(withViewer.mean, 1.8);
});

test('demo row 900020, Airport Sandwich Kiosk: group F, 3 of 4 agree', () => {
  // ana F, ben F, cleo D, eli F.
  const g = groupTierOf([{ tier: F }, { tier: F }, { tier: D }, { tier: F }]);
  assert.equal(g.tier, 'F');
  assert.equal(g.mean, 1.25);
  assert.equal(g.count, 4);
  assert.equal(g.agree, 3);
  // With the viewer's own D the mean is 1.4 — still F.
  const withViewer = groupTierOf([{ tier: F }, { tier: F }, { tier: D }, { tier: F }, { tier: D }]);
  assert.equal(withViewer.tier, 'F');
  assert.equal(withViewer.mean, 1.4);
});

test('compareGroup orders by mean descending', () => {
  const high = { name: 'high', group: { mean: 5.5, count: 1 } };
  const low = { name: 'low', group: { mean: 4.5, count: 5 } };
  assert.equal(compareGroup(high, low) < 0, true);
  assert.equal(compareGroup(low, high) > 0, true);
});

test('compareGroup breaks a mean tie by count, then by name', () => {
  const more = { name: 'zeta', group: { mean: 5, count: 4 } };
  const fewer = { name: 'alpha', group: { mean: 5, count: 2 } };
  // Same mean: more rankers first, name second.
  assert.equal(compareGroup(more, fewer) < 0, true);
  const bName = { name: 'beta', group: { mean: 5, count: 2 } };
  const aName = { name: 'Alpha', group: { mean: 5, count: 2 } };
  assert.equal(compareGroup(bName, aName) > 0, true);
});

test('compareGroup puts never-ranked restaurants last', () => {
  // The lowest real mean is now an all-F one, 1 — still above -1.
  const ranked = { name: 'zeta', group: { mean: 1, count: 3 } };
  const unranked = { name: 'alpha', group: { tier: null, mean: null, count: 0 } };
  assert.equal(compareGroup(unranked, ranked) > 0, true);
});