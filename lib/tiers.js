// The tier maths, kept pure so it can be unit-tested without a database.
// Both the server (group tiers in /api/board) and the plan behind the
// client's ordering come from here — one rule, one place.
//
// The rule the group agreed on: S counts 6, A 5, B 4, C 3, D 2, F 1, the
// group tier is the nearest letter to the average, and an exact half rounds
// up. (The scale used to run S=4 … C=1 with cut-offs at 3.5, 2.5, 1.5; every
// score and cut-off moved up by the same 2 when D and F joined, so nothing
// already ranked changed tier.)

const TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];
const SCORE = { S: 6, A: 5, B: 4, C: 3, D: 2, F: 1 };

// placements: [{ tier, ... }] — anything carrying a `tier` letter works.
// Returns { tier, mean, count, agree }; tier is null when nobody has
// ranked the restaurant yet.
function groupTierOf(placements) {
  const list = (placements || []).filter((p) => p && TIERS.includes(p.tier));
  if (list.length === 0) return { tier: null, mean: null, count: 0, agree: 0 };
  const mean = list.reduce((sum, p) => sum + SCORE[p.tier], 0) / list.length;
  const tier = mean >= 5.5 ? 'S' : mean >= 4.5 ? 'A' : mean >= 3.5 ? 'B'
    : mean >= 2.5 ? 'C' : mean >= 1.5 ? 'D' : 'F';
  const agree = list.filter((p) => p.tier === tier).length;
  return { tier, mean, count: list.length, agree };
}

// The group board's order within a band (and across the whole list):
// mean descending, then how many people ranked it, then name A to Z,
// ignoring case. Restaurants nobody has ranked sort last, by name.
function compareGroup(a, b) {
  const ma = a.group && a.group.mean != null ? a.group.mean : -1;
  const mb = b.group && b.group.mean != null ? b.group.mean : -1;
  if (mb !== ma) return mb - ma;
  const ca = a.group ? a.group.count : 0;
  const cb = b.group ? b.group.count : 0;
  if (cb !== ca) return cb - ca;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

module.exports = { TIERS, SCORE, groupTierOf, compareGroup };