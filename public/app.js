/* The tier board client.
 *
 * The server works out each restaurant's group tier (lib/tiers.js, unit
 * tested); this file renders the board, keeps the viewer's own choices
 * optimistic, and hands writes to the small API. Native-feel behaviour
 * (sheets, drag-to-place, pull-to-refresh, toasts) comes from the
 * platform's centrally hosted kit; a plain local run without it still
 * works: the restaurant falls back to a <dialog> and dragging is off.
 */

const UN = window.unNative || null;
const DEMO = new URLSearchParams(location.search).get('demo') === '1';
// The shell injects the viewer's identity token as ?token= on load; the
// server accepts it as a header on every fetch after that.
const TOKEN = new URLSearchParams(location.search).get('token');
function authHeaders() {
  return TOKEN ? { 'x-usernode-token': TOKEN } : {};
}

const TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];

// Whole-literal class names only: the stylesheet is compiled from literals
// found in the source, so a class glued together at runtime would render
// unstyled. These lookups are the one place the letter variants live.
const BAND_CLASS = { S: 'tier-band tier-s', A: 'tier-band tier-a', B: 'tier-band tier-b', C: 'tier-band tier-c', D: 'tier-band tier-d', F: 'tier-band tier-f' };
const TAG_CLASS = { S: 'chip-tag t-s', A: 'chip-tag t-a', B: 'chip-tag t-b', C: 'chip-tag t-c', D: 'chip-tag t-d', F: 'chip-tag t-f' };
const TAG_EMPTY = 'chip-tag is-empty';
const FILL_CLASS = { S: 'fill t-s', A: 'fill t-a', B: 'fill t-b', C: 'fill t-c', D: 'fill t-d', F: 'fill t-f' };
const PICK_CLASS = { S: 'pick p-s', A: 'pick p-a', B: 'pick p-b', C: 'pick p-c', D: 'pick p-d', F: 'pick p-f' };
const ROW_OF = { S: 0, A: 1, B: 2, C: 3, D: 4, F: 5, shelf: 6 };
const TIER_OF_ROW = ['S', 'A', 'B', 'C', 'D', 'F', null];

const state = {
  // Remembers the last view on this device.
  view: (function () { try { return localStorage.getItem('tierlist:view') === 'mine' ? 'mine' : 'group'; } catch (_) { return 'group'; } })(),
  data: null,          // the /api/board answer
  status: 'loading',   // loading | ready | error
};

let dragHandle = null;
let dragging = false;
let pendingRender = false;
let activeSheet = null;   // { close }
let openRestaurantId = null;
let sheetWrap = null;

const $ = (id) => document.getElementById(id);
const me = () => (state.data ? state.data.me : null);

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function api(path) {
  return path + (DEMO ? (path.includes('?') ? '&' : '?') + 'demo=1' : '');
}
function byId(id) {
  return state.data ? state.data.restaurants.find((r) => String(r.id) === String(id)) : null;
}
function mineOf(r) { return r.mine || null; }
function myUpdatedAt(r) {
  const m = me();
  if (!m) return '';
  const p = r.placements.find((p) => p.userId === m.id);
  return p ? p.updatedAt : '';
}

/* ── Feedback: toast, confirm, sheet ─────────────────────────────────── */

function toast(message) {
  if (UN && UN.toast) { UN.toast(message); return; }
  let t = document.querySelector('.js-toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'js-toast';
    t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:rgb(var(--fg));color:rgb(var(--ground));padding:10px 16px;border-radius:999px;font:600 14px/20px system-ui,sans-serif;z-index:9999';
    document.body.appendChild(t);
  }
  t.textContent = message;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.remove(), 2200);
}

async function confirmDialog(title, message, confirmLabel) {
  if (UN && UN.alert) {
    const res = await UN.alert({
      title,
      message,
      buttons: [{ label: 'Cancel', style: 'cancel' }, { label: confirmLabel, style: 'destructive' }],
    });
    return !!(res && res.button && res.button.label === confirmLabel);
  }
  return window.confirm(title + ' ' + message);
}

// Sheet on a phone, centred modal from 640 px up; plain <dialog> without
// the kit.
function present(contentEl, onDismiss) {
  const wide = window.matchMedia('(min-width: 640px)').matches;
  if (UN && UN.presentModal && wide) return UN.presentModal({ contentEl, onDismiss });
  if (UN && UN.presentSheet) return UN.presentSheet({ contentEl, onDismiss });
  const dlg = document.createElement('dialog');
  dlg.className = 'fallback-sheet';
  dlg.appendChild(contentEl);
  dlg.addEventListener('close', () => { if (onDismiss) onDismiss(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  document.body.appendChild(dlg);
  dlg.showModal();
  return { el: dlg, dismiss: () => dlg.close() };
}

// The native kit fires a sheet's onDismiss some time after close(), so a
// sheet dismissed to make room for the next one reports back late. A
// generation counter keeps that late report from clearing the state of the
// sheet that replaced it.
let sheetGen = 0;
function openSheet(contentEl) {
  closeSheet();
  const gen = ++sheetGen;
  const handle = present(contentEl, () => {
    if (gen === sheetGen) {
      activeSheet = null;
      openRestaurantId = null;
      sheetWrap = null;
    }
  });
  activeSheet = { close: () => handle.dismiss() };
  sheetWrap = contentEl;
}

function closeSheet() {
  if (!activeSheet) return;
  const s = activeSheet;
  activeSheet = null;
  openRestaurantId = null;
  sheetWrap = null;
  sheetGen++;
  s.close();
}

/* ── Writes: optimistic, with rollback ───────────────────────────────── */

// The group-tier rule, mirrored from lib/tiers.js (which carries the unit
// tests). Only used to paint the optimistic update for the instant before
// the quiet reload brings the server's own numbers back.
const SCORE = { S: 6, A: 5, B: 4, C: 3, D: 2, F: 1 };
function localGroupTier(placements) {
  const list = placements.filter((p) => TIERS.includes(p.tier));
  if (!list.length) return { tier: null, mean: null, count: 0, agree: 0 };
  const mean = list.reduce((sum, p) => sum + SCORE[p.tier], 0) / list.length;
  const tier = mean >= 5.5 ? 'S' : mean >= 4.5 ? 'A' : mean >= 3.5 ? 'B'
    : mean >= 2.5 ? 'C' : mean >= 1.5 ? 'D' : 'F';
  return { tier, mean, count: list.length, agree: list.filter((p) => p.tier === tier).length };
}

function applyMine(r, tier) {
  const m = me();
  r.mine = tier || null;
  if (!m) return;
  const rest = r.placements.filter((p) => p.userId !== m.id);
  if (tier) rest.unshift({ userId: m.id, username: m.username, tier, updatedAt: new Date().toISOString() });
  r.placements = rest;
  r.group = localGroupTier(rest);
}

async function send(path, body, method) {
  return fetch(path, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function setTier(id, tier) {
  const r = byId(id);
  if (!r) return;
  const prevMine = mineOf(r);
  if (prevMine === (tier || null)) return;
  const prevPlacements = r.placements.slice();
  const prevGroup = r.group;
  applyMine(r, tier);
  render();
  rerenderSheetIfOpen(r.id);
  let res;
  try {
    res = await send(api(`/api/restaurants/${r.id}/placement`), { tier }, 'PUT');
  } catch (_) { res = { ok: false }; }
  if (!res.ok) {
    r.mine = prevMine;
    r.placements = prevPlacements;
    r.group = prevGroup;
    if (res.status === 404) return gone();
    toast('Couldn’t save your tier. Try again.');
    render();
    rerenderSheetIfOpen(r.id);
    return;
  }
  if (tier) toast(`Your tier: ${tier}`);
  load();
}

function rerenderSheetIfOpen(id) {
  if (openRestaurantId !== String(id) || !sheetWrap) return;
  const fresh = byId(id);
  if (fresh) renderRestaurantSheet(sheetWrap, fresh);
}

// The restaurant vanished under the viewer (removed, or reported twice).
function gone() {
  toast('That restaurant is no longer on the list.');
  closeSheet();
  load();
}

/* ── Board data ──────────────────────────────────────────────────────── */

async function load() {
  let data;
  try {
    const res = await fetch(api('/api/board'), { headers: authHeaders() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (_) {
    if (state.data) return; // a background refresh failed: keep the board
    state.status = 'error';
    render();
    return;
  }
  state.data = data;
  state.status = 'ready';
  render();
  if (openRestaurantId) rerenderSheetIfOpen(openRestaurantId);
}

/* ── Rendering ───────────────────────────────────────────────────────── */

function render() {
  if (dragging) { pendingRender = true; return; }
  const main = $('board');
  if (state.status === 'loading') {
    main.dataset.state = 'loading';
    main.innerHTML = skeletonHTML();
    hideAround();
    return;
  }
  if (state.status === 'error') {
    main.dataset.state = 'error';
    main.innerHTML = '';
    main.appendChild(errorEl());
    hideAround();
    return;
  }
  const d = state.data;
  $('demo-line').hidden = !d.demo;
  if (!d.restaurants.length) {
    main.dataset.state = 'empty';
    main.innerHTML = '';
    main.appendChild(emptyEl());
    // Show the six bands even when the board is empty, so a newcomer sees
    // what the tier list will look like. appendChild first keeps the Add
    // button's listener on the already-inserted node.
    main.insertAdjacentHTML('beforeend', boardHTML());
    detachDrag();
    $('summary').textContent = '';
    $('foot').textContent = '';
    $('nudge').hidden = true;
    $('shelf').hidden = true;
    return;
  }
  main.dataset.state = 'ready';
  main.innerHTML = boardHTML();
  // The drag host is the app shell, not the board: shelf chips sit outside
  // <main>, and a drag has to be liftable from the shelf too. Group drags
  // too when signed in; guests can't save a tier, so their board stays tap-only.
  if (state.view === 'mine' || me()) attachDrag(main.closest('.app-shell')); else detachDrag();
  renderSummary();
  renderNudge();
  renderShelf();
  renderFoot();
}

function hideAround() {
  $('demo-line').hidden = true;
  $('summary').textContent = '';
  $('nudge').hidden = true;
  $('shelf').hidden = true;
  $('foot').textContent = '';
}

// Six grey band shapes with grey chip shapes, while the board loads.
function skeletonHTML() {
  const widths = [[92, 64], [120, 56, 72], [80, 104], [64, 88], [96, 72], [110, 60]];
  let html = '';
  for (let i = 0; i < widths.length; i++) {
    const chips = widths[i]
      .map((w) => `<span class="skeleton" style="display:inline-block;width:${w}px;height:44px;border-radius:10px"></span>`)
      .join('');
    html += `<section class="tier-band"><div class="skeleton" style="width:52px;border-radius:0"></div><div class="tier-chips">${chips}</div></section>`;
  }
  return `<div class="flex flex-col gap-2">${html}</div>`;
}

function errorEl() {
  const box = el(`<div class="state-error">
    <p class="m-0 font-semibold">Couldn’t load the tier list.</p>
    <p class="m-0 text-small text-muted">Nothing you ranked is lost. Check your connection and try again.</p>
    <button type="button" class="btn-secondary mt-2 js-retry">Retry</button>
  </div>`);
  box.querySelector('.js-retry').addEventListener('click', () => {
    state.status = 'loading';
    render();
    load();
  });
  return box;
}

function emptyEl() {
  const box = el(`<div class="state-empty">
    <p class="m-0 font-semibold">No restaurants yet.</p>
    <p class="m-0 text-small text-muted">Add a place you love, then everyone ranks it.</p>
    ${me() ? '<button type="button" class="btn-primary mt-2 js-add">Add restaurant</button>' : ''}
  </div>`);
  const btn = box.querySelector('.js-add');
  if (btn) btn.addEventListener('click', openAddForm);
  return box;
}

function boardHTML() {
  let html = '<div class="flex flex-col gap-2">';
  for (const t of TIERS) {
    const rows = state.view === 'group'
      ? state.data.restaurants.filter((r) => r.group && r.group.tier === t)
      : mineBand(t);
    const chips = rows.map((r) => chipHTML(r, state.view)).join('')
      || '<p class="empty-note">Nothing here yet</p>';
    html += `<section class="${BAND_CLASS[t]}" data-tier="${t}" aria-label="${t} tier">`
      + `<div class="tier-tile" aria-hidden="true">${t}</div>`
      + `<div class="tier-chips">${chips}</div></section>`;
  }
  return html + '</div>';
}

// On Mine, a band holds the viewer's own choices in the order they placed
// them.
function mineBand(t) {
  return state.data.restaurants
    .filter((r) => mineOf(r) === t)
    .sort((a, b) => (myUpdatedAt(a) < myUpdatedAt(b) ? -1 : myUpdatedAt(a) > myUpdatedAt(b) ? 1 : 0));
}

function chipHTML(r, view) {
  const name = esc(r.name);
  if (view !== 'group') {
    return `<button type="button" class="chip" data-id="${r.id}" aria-label="${name}">${name}</button>`;
  }
  const mine = mineOf(r);
  const tag = `<span class="${mine ? TAG_CLASS[mine] : TAG_EMPTY}" aria-hidden="true">${mine || ''}</span>`;
  const groupBit = r.group && r.group.tier ? `group tier ${r.group.tier}` : 'group not ranked';
  const label = `${r.name}, ${groupBit}, your tier ${mine || 'not set'}`;
  return `<button type="button" class="chip" data-id="${r.id}" aria-label="${esc(label)}">${tag}${name}</button>`;
}

function wireChips() {
  // One delegated listener per persistent container, added once: innerHTML
  // is replaced on every render, so per-render listeners would stack.
  for (const container of [$('board'), $('shelf-chips')]) {
    container.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (chip && container.contains(chip)) openRestaurant(chip.dataset.id);
    });
  }
}

function renderSummary() {
  const d = state.data;
  const n = d.restaurants.length;
  if (state.view === 'group') {
    const k = d.rankers;
    $('summary').textContent = `${n} restaurant${n === 1 ? '' : 's'}, ranked by ${k} ${k === 1 ? 'person' : 'people'}`;
  } else {
    const done = d.restaurants.filter((r) => mineOf(r)).length;
    $('summary').textContent = `You've ranked ${done} of ${n}. Drag one to a tier, or tap it.`;
  }
}

function renderNudge() {
  const count = state.view === 'group' && me()
    ? state.data.restaurants.filter((r) => !mineOf(r)).length
    : 0;
  $('nudge').hidden = count === 0;
  if (count) $('nudge-text').textContent = `You haven't ranked ${count} yet.`;
}

function renderShelf() {
  const shelf = $('shelf');
  const view = state.view;
  const rows = view === 'group'
    ? state.data.restaurants.filter((r) => !r.group || r.group.tier == null)
    : state.data.restaurants.filter((r) => !mineOf(r));
  if (view === 'group' && rows.length === 0) { shelf.hidden = true; return; }
  shelf.hidden = false;
  $('shelf-label').textContent = view === 'group' ? 'Not ranked yet' : 'To rank';
  $('shelf-chips').innerHTML = rows.map((r) => chipHTML(r, view)).join('')
    || '<p class="empty-note">Everything’s ranked. Drop one here to unrank it.</p>';
}

function renderFoot() {
  $('foot').textContent = state.view === 'group'
    ? 'Each band is where the group puts a restaurant on average. The small letter is your tier; a dashed one means you haven\'t ranked it.'
      + (me() ? ' Drag a restaurant onto a band to set your tier, or tap it.' : '')
    : 'These bands hold only your choices. Drag a restaurant onto a band, or tap it to pick a tier.';
}

function setView(view) {
  state.view = view;
  try { localStorage.setItem('tierlist:view', view); } catch (_) {}
  setSegUI();
  render();
}

function setSegUI() {
  $('seg-group').setAttribute('aria-pressed', String(state.view === 'group'));
  $('seg-mine').setAttribute('aria-pressed', String(state.view === 'mine'));
}

/* ── Drag a restaurant to a tier (Mine and, signed in, Group) ────────── */

function clearDropTargets() {
  document.querySelectorAll('.is-drop-target').forEach((n) => n.classList.remove('is-drop-target'));
}

function bandForCell(cell) {
  const tier = TIER_OF_ROW[cell.row];
  if (!tier) return $('shelf');
  return document.querySelector(`.tier-band[data-tier='${tier}']`);
}

function attachDrag(board) {
  detachDrag();
  // Without the kit, tapping still ranks: drag is simply off.
  if (!UN || !UN.attachGridPlacement) return;
  dragHandle = UN.attachGridPlacement(board, {
    itemSelector: '.chip',
    cellFromPoint(x, y, info) {
      // Answer from the dragged tile's centre, not from the finger.
      const cx = info ? info.centerX : x;
      const cy = info ? info.centerY : y;
      const hit = document.elementFromPoint(cx, cy);
      const band = hit && hit.closest("[data-tier], #shelf");
      if (!band) return null;
      return { col: 0, row: ROW_OF[band.id === 'shelf' ? 'shelf' : band.dataset.tier] };
    },
    canPlace(item, cell) {
      const r = byId(item.dataset.id);
      return !!r && TIER_OF_ROW[cell.row] !== mineOf(r);
    },
    onHover(item, cell, ok) {
      clearDropTargets();
      if (cell && ok) {
        const band = bandForCell(cell);
        if (band) band.classList.add('is-drop-target');
      }
    },
    rectForCell(item, cell) {
      const band = bandForCell(cell);
      if (!band) return null;
      const area = band.querySelector('.tier-chips, .shelf-chips') || band;
      return area.getBoundingClientRect();
    },
    onLift(item) {
      dragging = true;
      // The kit sizes the ghost from the chip's rect while the pointer is
      // still down, and a pressed button sits under the kit's :active
      // scale (0.97) -- so the ghost would come out ~3% narrower than the
      // chip and long names would wrap mid-word. Re-measure from the
      // chip's layout box, which transforms leave alone, before anything
      // paints.
      const ghost = document.querySelector('.un-reorder-ghost');
      if (ghost) {
        const cs = getComputedStyle(item);
        ghost.style.width = cs.width;
        ghost.style.height = cs.height;
      }
    },
    onPlace(item, cell) {
      // Optimistic move; the re-render is held until the release settles.
      pendingRender = true;
      setTier(item.dataset.id, TIER_OF_ROW[cell.row]);
    },
    onSettle() {
      dragging = false;
      clearDropTargets();
      if (pendingRender) { pendingRender = false; render(); }
    },
  });
}

function detachDrag() {
  if (dragHandle) { dragHandle.detach(); dragHandle = null; }
  clearDropTargets();
}

/* ── The restaurant sheet ────────────────────────────────────────────── */

function tierPickHTML(current) {
  return TIERS.map((t) =>
    `<button type="button" class="${PICK_CLASS[t]}" data-tier="${t}" aria-pressed="${current === t}">${t}</button>`
  ).join('');
}

function openRestaurant(id) {
  const r = byId(id);
  if (!r) { toast('That restaurant is no longer on the list.'); load(); return; }
  openRestaurantId = String(r.id);
  const wrap = document.createElement('div');
  openSheet(wrap);
  renderRestaurantSheet(wrap, r);
}

function verdict(g) {
  if (g.tier == null) return 'Nobody has ranked it yet.';
  return `Group tier ${g.tier}. ${g.agree} of ${g.count} people put it there.`;
}

function distRow(t, r, m) {
  const inTier = r.placements.filter((p) => p.tier === t);
  const total = r.placements.length;
  // The viewer leads the row as "You"; everyone else in placement order.
  const names = [];
  if (m) {
    for (const p of inTier) if (p.userId === m.id) names.push('You');
  }
  for (const p of inTier) if (!m || p.userId !== m.id) names.push(p.username);
  const pct = total ? Math.round((inTier.length / total) * 100) : 0;
  const who = names.length ? esc(names.join(', ')) : 'Nobody';
  return `<li><span class="${TAG_CLASS[t]}" aria-hidden="true">${t}</span>`
    + `<div><div class="bar"><div class="${FILL_CLASS[t]}" style="width:${pct}%"></div></div>`
    + `<p class="who">${who}</p></div>`
    + `<span class="count">${inTier.length}</span></li>`;
}

function renderRestaurantSheet(wrap, r) {
  const m = me();
  const mine = mineOf(r);
  const g = r.group || { tier: null, count: 0, agree: 0 };
  let html = `<h2 class="sheet-title">${esc(r.name)}</h2>`;
  if (r.note) html += `<p class="note">${esc(r.note)}</p>`;
  html += `<p class="meta">Added by ${esc(r.addedBy.username)}</p>`;
  if (m) {
    html += `<div class="label-row"><h3 class="section-label">Your tier</h3>`
      + `${mine ? '<button type="button" class="text-btn js-clear">Clear my tier</button>' : ''}</div>`
      + `<div class="tier-pick" role="group" aria-label="Your tier">${tierPickHTML(mine)}</div>`;
  }
  html += `<div class="label-row"><h3 class="section-label">The group</h3></div>`
    + `<p class="verdict">${esc(verdict(g))}</p>`
    + `<ul class="dist">${TIERS.map((t) => distRow(t, r, m)).join('')}</ul>`;
  if (m) {
    const left = r.canEdit
      ? `<button type="button" class="quiet js-edit"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/></svg>Edit</button>`
        + `<button type="button" class="quiet js-remove">Remove</button>`
      : `<button type="button" class="quiet js-report"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/></svg>Report</button>`;
    html += `<div class="actions">${left}<button type="button" class="btn-secondary js-done">Done</button></div>`;
  } else {
    html += `<p class="meta mt-3">Make an account to rank.</p>`
      + `<div class="actions"><span></span><button type="button" class="btn-secondary js-done">Done</button></div>`;
  }
  wrap.innerHTML = html;

  wrap.querySelectorAll('.pick').forEach((btn) => btn.addEventListener('click', () => {
    const t = btn.dataset.tier;
    setTier(r.id, mineOf(r) === t ? null : t);
  }));
  const clear = wrap.querySelector('.js-clear');
  if (clear) clear.addEventListener('click', () => setTier(r.id, null));
  const done = wrap.querySelector('.js-done');
  if (done) done.addEventListener('click', closeSheet);
  const edit = wrap.querySelector('.js-edit');
  if (edit) edit.addEventListener('click', () => { closeSheet(); openEditForm(r); });
  const remove = wrap.querySelector('.js-remove');
  if (remove) remove.addEventListener('click', () => removeRestaurant(r));
  const report = wrap.querySelector('.js-report');
  if (report) report.addEventListener('click', () => reportRestaurant(r));
}

async function removeRestaurant(r) {
  const ok = await confirmDialog(
    `Remove ${r.name}?`,
    'Everyone’s tiers for it go too.',
    'Remove'
  );
  if (!ok) return;
  const res = await send(api(`/api/restaurants/${r.id}`), undefined, 'DELETE');
  if (res.status === 404) return gone();
  if (!res.ok) { toast('Couldn’t remove it. Try again.'); return; }
  toast('Removed');
  closeSheet();
  load();
}

async function reportRestaurant(r) {
  const ok = await confirmDialog(
    `Report ${r.name}?`,
    'It’s hidden for you now, and for everyone once two people report it.',
    'Report'
  );
  if (!ok) return;
  const res = await send(api(`/api/restaurants/${r.id}/report`), {});
  if (res.status === 404) return gone();
  if (!res.ok) { toast('Couldn’t report it. Try again.'); return; }
  toast('Reported');
  closeSheet();
  load();
}

/* ── Add and Edit ────────────────────────────────────────────────────── */

function fieldError(form, field, message, duplicateId) {
  const p = form.querySelector(`.field-error[data-field='${field}']`);
  if (!p) { toast(message); return; }
  p.textContent = message;
  p.hidden = false;
  if (duplicateId != null) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'text-btn';
    b.textContent = 'Open it';
    b.addEventListener('click', () => { closeSheet(); openRestaurant(duplicateId); });
    p.appendChild(document.createTextNode(' '));
    p.appendChild(b);
  }
}

function wireTierPick(form, get, set) {
  form.querySelectorAll('.pick').forEach((btn) => btn.addEventListener('click', () => {
    const t = btn.dataset.tier;
    set(get() === t ? null : t);
    form.querySelectorAll('.pick').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tier === get())));
  }));
}

function openAddForm() {
  let picked = null;
  const form = el(`<form class="flex flex-col gap-4" novalidate>
    <h2 class="sheet-title">Add a restaurant</h2>
    <div>
      <label class="section-label" for="add-name">Name</label>
      <input id="add-name" class="field" name="name" maxlength="80" placeholder="e.g. Sunset Pho" autocomplete="off">
      <p class="field-error" data-field="name" hidden></p>
    </div>
    <div>
      <label class="section-label" for="add-note">Note (optional)</label>
      <input id="add-note" class="field" name="note" maxlength="200" placeholder="e.g. Get the garlic noodles" autocomplete="off">
      <p class="field-error" data-field="note" hidden></p>
    </div>
    <div>
      <span class="section-label">Your tier</span>
      <div class="tier-pick" role="group" aria-label="Your tier">${tierPickHTML(null)}</div>
      <p class="meta mt-1">Optional: rank it as you add it.</p>
    </div>
    <button type="submit" class="btn-primary js-submit">Add restaurant</button>
  </form>`);
  wireTierPick(form, () => picked, (t) => (picked = t));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('.js-submit');
    form.querySelectorAll('.field-error').forEach((p) => { p.textContent = ''; p.hidden = true; });
    btn.disabled = true;
    let res;
    try {
      res = await send(api('/api/restaurants'), {
        name: form.querySelector('#add-name').value,
        note: form.querySelector('#add-note').value,
        tier: picked,
      });
    } catch (_) {
      btn.disabled = false;
      toast('Couldn’t add it. Try again.');
      return;
    }
    if (res.status === 409) {
      const data = await res.json().catch(() => ({}));
      fieldError(form, 'name', `${data.name || form.querySelector('#add-name').value} is already on the list.`, data.id);
      btn.disabled = false;
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      fieldError(form, data.field || 'name', data.error || 'Couldn’t add it. Try again.');
      btn.disabled = false;
      return;
    }
    const added = await res.json();
    closeSheet();
    toast(`Added ${added.name}`);
    load();
  });
  openSheet(form);
  form.querySelector('#add-name').focus();
}

function openEditForm(r) {
  const form = el(`<form class="flex flex-col gap-4" novalidate>
    <h2 class="sheet-title">Edit ${esc(r.name)}</h2>
    <div>
      <label class="section-label" for="edit-name">Name</label>
      <input id="edit-name" class="field" name="name" maxlength="80" autocomplete="off">
      <p class="field-error" data-field="name" hidden></p>
    </div>
    <div>
      <label class="section-label" for="edit-note">Note (optional)</label>
      <input id="edit-note" class="field" name="note" maxlength="200" autocomplete="off">
      <p class="field-error" data-field="note" hidden></p>
    </div>
    <button type="submit" class="btn-primary js-submit">Save changes</button>
  </form>`);
  form.querySelector('#edit-name').value = r.name;
  form.querySelector('#edit-note').value = r.note || '';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('.js-submit');
    form.querySelectorAll('.field-error').forEach((p) => { p.textContent = ''; p.hidden = true; });
    btn.disabled = true;
    let res;
    try {
      res = await send(api(`/api/restaurants/${r.id}`), {
        name: form.querySelector('#edit-name').value,
        note: form.querySelector('#edit-note').value,
      }, 'PATCH');
    } catch (_) {
      btn.disabled = false;
      toast('Couldn’t save changes. Try again.');
      return;
    }
    if (res.status === 404) return gone();
    if (res.status === 409) {
      const data = await res.json().catch(() => ({}));
      fieldError(form, 'name', `${data.name || form.querySelector('#edit-name').value} is already on the list.`, data.id);
      btn.disabled = false;
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      fieldError(form, data.field || 'name', data.error || 'Couldn’t save changes. Try again.');
      btn.disabled = false;
      return;
    }
    closeSheet();
    load();
  });
  openSheet(form);
  form.querySelector('#edit-name').focus();
}

/* ── Boot ────────────────────────────────────────────────────────────── */

(function init() {
  wireChips();
  $('seg-group').addEventListener('click', () => setView('group'));
  $('seg-mine').addEventListener('click', () => setView('mine'));
  $('add-btn').addEventListener('click', () => {
    if (!me()) { toast('Make an account to add restaurants.'); return; }
    openAddForm();
  });
  $('rank-them').addEventListener('click', () => {
    setView('mine');
    const smooth = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    requestAnimationFrame(() => $('shelf').scrollIntoView({ behavior: smooth, block: 'start' }));
  });
  setSegUI();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.data) load();
  });
  if (UN && UN.attachPullToRefresh) UN.attachPullToRefresh(window, () => load());
  render();
  load();
})();