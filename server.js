const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { TIERS, groupTierOf, compareGroup } = require('./lib/tiers');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// An idle pooled connection that the database closed (a database restart,
// say) emits an error; without this handler the whole app dies on it. pg
// discards the broken client itself.
pool.on('error', (err) => console.error('Idle database client error:', err.message));

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

// ── Schema ──────────────────────────────────────────────────────────────
// Applied idempotently on boot. `restaurants` and `placements` are public
// (the board's whole point is that the group sees them). `reports` and
// `demo_viewers` are private: reports hold who reported whom, and
// demo_viewers marks which account opened a demo preview — neither is
// board content.

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS restaurants (
      id serial PRIMARY KEY,
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
      note text CHECK (note IS NULL OR char_length(note) <= 200),
      added_by_id text NOT NULL,
      added_by_name text NOT NULL,
      is_demo boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      removed_at timestamptz
    );
    -- Two places with the same name (case and spacing ignored) are not
    -- allowed while both are on the list; a removed one frees the name.
    CREATE UNIQUE INDEX IF NOT EXISTS restaurants_active_name_idx
      ON restaurants (is_demo, lower(name)) WHERE removed_at IS NULL;
    CREATE TABLE IF NOT EXISTS placements (
      restaurant_id integer NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      username text NOT NULL,
      tier char(1) NOT NULL CHECK (tier IN ('S','A','B','C','D','F')),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (restaurant_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS placements_user_idx ON placements (user_id);
    CREATE TABLE IF NOT EXISTS reports (
      restaurant_id integer NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (restaurant_id, user_id)
    );
    COMMENT ON TABLE reports IS 'staging:private';
    CREATE TABLE IF NOT EXISTS demo_viewers (
      user_id text PRIMARY KEY,
      seeded_at timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE demo_viewers IS 'staging:private';
    -- D and F joined the tier list later. Databases created before that
    -- still carry the old four-letter CHECK, so widen it in place —
    -- forward-only, nothing dropped or rewritten. Postgres names an inline
    -- column CHECK placements_tier_check, so the same name covers both
    -- fresh and old tables. Both statements run in this one multi-statement
    -- query (one implicit transaction), so there is no window without a
    -- check; every existing row satisfies the wider one.
    ALTER TABLE placements DROP CONSTRAINT IF EXISTS placements_tier_check;
    ALTER TABLE placements ADD CONSTRAINT placements_tier_check
      CHECK (tier IN ('S','A','B','C','D','F'));
  `);
}

// ── Staging demo (first version's ?demo=1 board) ────────────────────────
// 21 made-up restaurants and five made-up friends who ranked them, plus
// the viewer's own 15 tiers written once on their first ?demo=1 visit.
// Everything is `is_demo = true` and the board filters on that, so the
// plain route never shows or touches any of it. All inserts are
// ON CONFLICT DO NOTHING with no target, so re-running is safe, and what
// the viewer changes afterwards stays changed (the demo_viewers marker is
// written once).

const DEMO_PEOPLE = ['demo-ana', 'demo-ben', 'demo-cleo', 'demo-dev', 'demo-eli'];

// tier order in `tiers` follows DEMO_PEOPLE; null means that friend has
// not ranked it.
const DEMO_SEED = [
  { id: 900001, name: 'Fogline Dumplings',     note: 'Soup dumplings, expect a line',       addedBy: 'demo-ana', tiers: ['S', 'S', 'S', 'A', 'S'] },
  { id: 900002, name: 'Merritt Ramen Lab',     note: 'Order the black garlic bowl',         addedBy: 'demo-ben', tiers: ['S', 'A', 'S', 'S', null] },
  { id: 900003, name: 'Telegraph Tacos',       note: 'Al pastor off the spit. Cash only.',  addedBy: 'demo-cleo', tiers: ['S', 'S', 'A', 'S', null] },
  { id: 900004, name: 'Sunset Pho',            note: 'Huge bowls, rare steak',              addedBy: 'demo-ana', tiers: ['A', 'A', 'S', 'B', 'A'] },
  { id: 900005, name: 'Clement Dim Sum',       note: 'Go before 11 on weekends',            addedBy: 'demo-ben', tiers: ['A', 'S', 'A', 'A', null] },
  { id: 900006, name: 'Dolores Dosa',          note: 'Weekends only',                       addedBy: 'demo-cleo', tiers: ['A', 'A', 'B', null, null] },
  { id: 900007, name: 'Temescal Tteok',        note: null,                                  addedBy: 'demo-dev', tiers: ['S', 'A', 'A', 'B', null] },
  { id: 900008, name: 'J-Town Katsu',          note: 'Get the curry on the side',           addedBy: 'demo-eli', tiers: ['A', 'A', 'S', null, 'A'] },
  { id: 900009, name: 'Cable Car Congee',      note: null,                                  addedBy: 'demo-ana', tiers: ['B', 'B', 'A', 'C', null] },
  { id: 900010, name: 'Bao Stop',              note: 'Good for a quick lunch',              addedBy: 'demo-ben', tiers: ['B', 'A', 'B', null, null] },
  { id: 900011, name: 'Ocean Beach Burgers',   note: 'Windy patio',                         addedBy: 'demo-cleo', tiers: ['B', 'B', null, null, 'C'] },
  { id: 900012, name: 'Nopa Noodles',          note: null,                                  addedBy: 'demo-dev', tiers: ['A', 'B', 'B', 'C', 'B'] },
  { id: 900013, name: 'Valencia Vada Pav',     note: 'Spicy, in a good way',                addedBy: 'demo-eli', tiers: ['B', 'C', null, 'B', null] },
  { id: 900014, name: 'Sourdough & Sons',      note: null,                                  addedBy: 'demo-ana', tiers: ['C', 'C', 'B', null, null] },
  { id: 900015, name: 'Half Moon Fish Fry',    note: 'Long drive, small portions',          addedBy: 'demo-ben', tiers: ['C', 'B', 'C', null, null] },
  { id: 900016, name: 'Crab Counter',          note: null,                                  addedBy: 'demo-dev', tiers: ['C', 'C', null, 'C', 'B'] },
  { id: 900017, name: 'Bernal Bakery',         note: 'Morning buns sell out early',         addedBy: 'demo-cleo', tiers: [null, null, null, null, null] },
  { id: 900018, name: 'Fruitvale Pupusas',     note: null,                                  addedBy: 'demo-eli', tiers: [null, null, null, null, null] },
  // The bottom of the board: the D and F bands need demo rows too, so they
  // can be seen on the demo board without anybody ranking first.
  { id: 900019, name: 'Late Night Nachos',     note: 'Soggy by the second bite',            addedBy: 'demo-ana', tiers: ['D', 'D', 'C', 'F', null] },
  { id: 900020, name: 'Airport Sandwich Kiosk', note: 'Only if your flight is delayed',     addedBy: 'demo-ben', tiers: ['F', 'F', 'D', null, 'F'] },
  { id: 900021, name: 'Lukewarm Bagel Co',     note: null,                                  addedBy: 'demo-cleo', tiers: ['D', 'C', 'D', null, null] },
];

// The viewer's own demo tiers, by restaurant id — 15 of the 21, so the
// your-tier tags, the Mine view and the "5 yet" strip all have something
// of the viewer's to show. 900019 and 900020 give the viewer a pick in the
// new D and F bands too; 900021 stays unranked for them.
const VIEWER_TIERS = {
  900001: 'S', 900002: 'S', 900003: 'A', 900004: 'A', 900005: 'A',
  900006: 'S', 900008: 'B', 900009: 'B', 900010: 'C', 900012: 'B',
  900013: 'B', 900014: 'C', 900016: 'C', 900019: 'F', 900020: 'D',
};

async function seedDemoBoard() {
  for (const r of DEMO_SEED) {
    await pool.query(
      `INSERT INTO restaurants (id, name, note, added_by_id, added_by_name, is_demo)
       VALUES ($1, $2, $3, $4, $4, true)
       ON CONFLICT DO NOTHING`,
      [r.id, r.name, r.note, r.addedBy]
    );
    for (let i = 0; i < DEMO_PEOPLE.length; i++) {
      if (!r.tiers[i]) continue;
      await pool.query(
        `INSERT INTO placements (restaurant_id, user_id, username, tier)
         VALUES ($1, $2, $2, $3)
         ON CONFLICT DO NOTHING`,
        [r.id, DEMO_PEOPLE[i], r.tiers[i]]
      );
    }
  }
  // Keep real rows out of the demo id range for good.
  await pool.query(`SELECT setval(pg_get_serial_sequence('restaurants', 'id'), 900100, true)`);
}

async function seedDemoViewer(user) {
  const marked = await pool.query(
    `INSERT INTO demo_viewers (user_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING user_id`,
    [String(user.id)]
  );
  if (marked.rowCount === 0) return; // already seeded once for this viewer
  for (const [id, tier] of Object.entries(VIEWER_TIERS)) {
    await pool.query(
      `INSERT INTO placements (restaurant_id, user_id, username, tier)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [Number(id), String(user.id), user.username, tier]
    );
  }
}

// ── Shared helpers ──────────────────────────────────────────────────────

function cleanName(raw) {
  if (typeof raw !== 'string') return { error: 'Add a name.' };
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name) return { error: 'Add a name.' };
  if (name.length > 80) return { error: 'Keep the name to 80 characters or fewer.' };
  return { valid: name };
}

function cleanNote(raw) {
  if (raw == null) return { valid: null };
  if (typeof raw !== 'string') return { error: 'Notes are text.' };
  const note = raw.trim();
  if (!note) return { valid: null };
  if (note.length > 200) return { error: 'Keep the note to 200 characters or fewer.' };
  return { valid: note };
}

// One restaurant as the board renders it: placements collected, group tier
// worked out by the tested rule in lib/tiers.js, and the viewer's own bits
// (mine, canEdit) filled in for whoever is asking.
function restaurantShape(row, placements, user) {
  const viewerId = user ? String(user.id) : null;
  const group = groupTierOf(placements);
  const mine = viewerId
    ? (placements.find((p) => p.userId === viewerId) || {}).tier || null
    : null;
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    addedBy: { id: row.added_by_id, username: row.added_by_name },
    canEdit: !!(user && row.added_by_id === viewerId),
    mine,
    placements,
    group: { tier: group.tier, mean: group.mean, count: group.count, agree: group.agree },
  };
}

// The row and its placements, or null when there is no such restaurant in
// this mode: wrong is_demo, removed, or no such id at all.
async function loadRestaurant(id, demo) {
  const { rows } = await pool.query(
    `SELECT id, name, note, added_by_id, added_by_name, created_at
       FROM restaurants
      WHERE id = $1 AND is_demo = $2 AND removed_at IS NULL`,
    [id, demo]
  );
  if (!rows.length) return null;
  const placed = await pool.query(
    `SELECT user_id AS "userId", username, tier, updated_at AS "updatedAt"
       FROM placements
      WHERE restaurant_id = $1
      ORDER BY updated_at`,
    [id]
  );
  return { row: rows[0], placements: placed.rows };
}

function parseId(raw) {
  return /^\d+$/.test(String(raw)) ? Number.parseInt(raw, 10) : null;
}

// ── API ─────────────────────────────────────────────────────────────────
// `demo` is staging plus ?demo=1, and nothing else: every route filters on
// is_demo, so a plain visit never shows or touches demo rows. A write on a
// restaurant from the other mode, or a removed one, is a 404. The auth
// middleware above has already answered guests' writes with 401
// account_required, so every route below can read req.user.

app.get('/api/board', async (req, res) => {
  try {
    const demo = IS_STAGING && req.query.demo === '1';
    if (demo && req.user) await seedDemoViewer(req.user);
    const viewerId = req.user ? String(req.user.id) : null;
    const { rows } = await pool.query(
      `SELECT r.id, r.name, r.note, r.added_by_id, r.added_by_name,
              COALESCE(
                json_agg(json_build_object(
                    'userId', p.user_id, 'username', p.username,
                    'tier', p.tier, 'updatedAt', p.updated_at)
                  ORDER BY p.updated_at)
                FILTER (WHERE p.user_id IS NOT NULL),
                '[]'::json) AS placements
         FROM restaurants r
         LEFT JOIN placements p ON p.restaurant_id = r.id
        WHERE r.is_demo = $1
          AND r.removed_at IS NULL
          -- hidden from everyone at two distinct reports
          AND (SELECT count(*) FROM reports rp WHERE rp.restaurant_id = r.id) < 2
          -- hidden from the viewer who reported it
          AND ($2::text IS NULL OR NOT EXISTS (
                SELECT 1 FROM reports mine
                 WHERE mine.restaurant_id = r.id AND mine.user_id = $2))
        GROUP BY r.id`,
      [demo, viewerId]
    );
    const restaurants = rows.map((row) =>
      restaurantShape(row, row.placements, req.user)
    );
    // The board's order: mean descending, rankers descending, then name.
    restaurants.sort(compareGroup);
    const rankers = new Set();
    for (const r of restaurants) for (const p of r.placements) rankers.add(p.userId);
    res.json({
      me: req.user ? { id: viewerId, username: req.user.username } : null,
      demo,
      restaurants,
      rankers: rankers.size,
    });
  } catch (err) {
    console.error('GET /api/board failed:', err.message);
    res.status(500).json({ error: 'Could not load the board.' });
  }
});

app.post('/api/restaurants', async (req, res) => {
  const demo = IS_STAGING && req.query.demo === '1';
  const name = cleanName(req.body && req.body.name);
  if (name.error) return res.status(400).json({ error: name.error, field: 'name' });
  const note = cleanNote(req.body && req.body.note);
  if (note.error) return res.status(400).json({ error: note.error, field: 'note' });
  const tier = req.body && req.body.tier != null ? req.body.tier : null;
  if (tier != null && !TIERS.includes(tier)) {
    return res.status(400).json({ error: 'Pick a tier: S, A, B, C, D or F.', field: 'tier' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dupe = await client.query(
      `SELECT id, name FROM restaurants
        WHERE is_demo = $1 AND removed_at IS NULL AND lower(name) = lower($2)
        LIMIT 1`,
      [demo, name.valid]
    );
    if (dupe.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'duplicate', id: dupe.rows[0].id, name: dupe.rows[0].name });
    }
    const inserted = await client.query(
      `INSERT INTO restaurants (name, note, added_by_id, added_by_name, is_demo)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, note, added_by_id, added_by_name, created_at`,
      [name.valid, note.valid, String(req.user.id), req.user.username, demo]
    );
    const row = inserted.rows[0];
    const placements = [];
    if (tier) {
      await client.query(
        `INSERT INTO placements (restaurant_id, user_id, username, tier)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [row.id, String(req.user.id), req.user.username, tier]
      );
      placements.push({
        userId: String(req.user.id),
        username: req.user.username,
        tier,
        updatedAt: row.created_at,
      });
    }
    await client.query('COMMIT');
    res.status(201).json(restaurantShape(row, placements, req.user));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Lost the race with a simultaneous add of the same name.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'duplicate' });
    }
    console.error('POST /api/restaurants failed:', err.message);
    res.status(500).json({ error: 'Could not add the restaurant.' });
  } finally {
    client.release();
  }
});

app.patch('/api/restaurants/:id', async (req, res) => {
  try {
    const demo = IS_STAGING && req.query.demo === '1';
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const found = await loadRestaurant(id, demo);
    if (!found) return res.status(404).json({ error: 'not_found' });
    if (found.row.added_by_id !== String(req.user.id)) {
      return res.status(403).json({ error: 'Only the person who added it can edit it.' });
    }
    const name = cleanName(req.body && req.body.name);
    if (name.error) return res.status(400).json({ error: name.error, field: 'name' });
    const note = cleanNote(req.body && req.body.note);
    if (note.error) return res.status(400).json({ error: note.error, field: 'note' });
    const dupe = await pool.query(
      `SELECT id, name FROM restaurants
        WHERE is_demo = $1 AND removed_at IS NULL AND id <> $2 AND lower(name) = lower($3)
        LIMIT 1`,
      [demo, id, name.valid]
    );
    if (dupe.rows.length) {
      return res.status(409).json({ error: 'duplicate', id: dupe.rows[0].id, name: dupe.rows[0].name });
    }
    const updated = await pool.query(
      `UPDATE restaurants SET name = $1, note = $2, updated_at = now()
        WHERE id = $3
        RETURNING id, name, note, added_by_id, added_by_name, created_at`,
      [name.valid, note.valid, id]
    );
    res.json(restaurantShape(updated.rows[0], found.placements, req.user));
  } catch (err) {
    console.error('PATCH /api/restaurants failed:', err.message);
    res.status(500).json({ error: 'Could not save the changes.' });
  }
});

app.delete('/api/restaurants/:id', async (req, res) => {
  try {
    const demo = IS_STAGING && req.query.demo === '1';
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const found = await loadRestaurant(id, demo);
    if (!found) return res.status(404).json({ error: 'not_found' });
    if (found.row.added_by_id !== String(req.user.id)) {
      return res.status(403).json({ error: 'Only the person who added it can remove it.' });
    }
    // Soft delete: the row stays (so a name clash never resurrects old
    // data oddly), the unique index frees the name for reuse.
    await pool.query(
      `UPDATE restaurants SET removed_at = now(), updated_at = now() WHERE id = $1`,
      [id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/restaurants failed:', err.message);
    res.status(500).json({ error: 'Could not remove it.' });
  }
});

app.put('/api/restaurants/:id/placement', async (req, res) => {
  try {
    const demo = IS_STAGING && req.query.demo === '1';
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const found = await loadRestaurant(id, demo);
    if (!found) return res.status(404).json({ error: 'not_found' });
    const tier = req.body ? req.body.tier : undefined;
    if (tier !== null && !TIERS.includes(tier)) {
      return res.status(400).json({ error: 'Pick a tier: S, A, B, C, D or F.' });
    }
    const userId = String(req.user.id);
    if (tier === null) {
      await pool.query(
        `DELETE FROM placements WHERE restaurant_id = $1 AND user_id = $2`,
        [id, userId]
      );
    } else {
      await pool.query(
        `INSERT INTO placements (restaurant_id, user_id, username, tier, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (restaurant_id, user_id)
         DO UPDATE SET tier = EXCLUDED.tier, username = EXCLUDED.username, updated_at = now()`,
        [id, userId, req.user.username, tier]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/restaurants/:id/placement failed:', err.message);
    res.status(500).json({ error: 'Could not save your tier.' });
  }
});

app.post('/api/restaurants/:id/report', async (req, res) => {
  try {
    const demo = IS_STAGING && req.query.demo === '1';
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const found = await loadRestaurant(id, demo);
    if (!found) return res.status(404).json({ error: 'not_found' });
    const userId = String(req.user.id);
    if (found.row.added_by_id === userId) {
      return res.status(400).json({ error: 'You added this one, so you can remove it instead.' });
    }
    await pool.query(
      `INSERT INTO reports (restaurant_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [id, userId]
    );
    res.status(204).end();
  } catch (err) {
    console.error('POST /api/restaurants/:id/report failed:', err.message);
    res.status(500).json({ error: 'Could not report it.' });
  }
});

app.get('/health', (req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting-down' });
  res.json({ status: 'ok' });
});

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/bay-area-restaurant-tier-list-6f1cf0/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/bay-area-restaurant-tier-list-6f1cf0/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Graceful shutdown ───────────────────────────────────────────────────
// Stop accepting connections, let in-flight requests finish under a hard
// deadline, close the pool, exit. Idempotent: a repeat signal during the
// drain must not run the teardown twice.

const DRAIN_MS = 3000;
let shuttingDown = false;
let server = null;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining`);
  if (server) {
    server.close(() => {});
    if (server.closeIdleConnections) server.closeIdleConnections();
    const t = setTimeout(() => {
      if (server.closeAllConnections) server.closeAllConnections();
    }, DRAIN_MS);
    if (t.unref) t.unref();
  }
  try {
    await pool.end();
  } catch (err) {
    console.error('[shutdown] pool.end failed:', err.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function start() {
  // The migration runs before listen: a request that arrives before the
  // tables exist is the one failure a fresh container can always hit.
  await migrate();
  if (IS_STAGING) await seedDemoBoard();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });