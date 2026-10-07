# Bay Area Restaurant Tier List — notes for Claude Code

This app runs on **Homeroom**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://app.onhomeroom.com/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Homeroom's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

## Connector permission prompts

This repo ships `.claude/settings.json`, which allows the **read-only**
Homeroom connector calls (`mcp__homeroom__get_*`,
`…__list_*`, `…__whoami`) so they stop prompting one at a time. Everything
that acts — filing a request, opening or advancing a proposal — still asks.
Claude Code applies those rules only after you accept the
workspace trust dialog, which lists them for review. See `.claude/README.md`
for the whole story, including what to do if you are still being prompted
(usually: your connector is registered under a different name than the rules
assume).

## Check that this checkout is current

You may be working in a fork of this app whose `main` is behind the app's
canonical repository, and nothing in the checkout says so: `git fetch origin`
compares the fork with itself. This matters before you **read** code to answer
a question about how the app behaves now, not only before you edit it.

The canonical repository is named in `.claude/homeroom-canonical-repo`. Check against
it, not against `origin`:

```sh
git fetch "$(cat .claude/homeroom-canonical-repo)" main
git merge-base --is-ancestor FETCH_HEAD HEAD && echo current || echo behind
```

`behind` means this checkout does not contain the canonical `main`. To answer
a question, read the canonical code instead (`git show FETCH_HEAD:<path>`,
`git grep <pattern> FETCH_HEAD`). To change code, start from the exact base
commit your Homeroom work order gives, and never merge or rebase onto the
canonical `main` yourself: which commit a change is diffed against decides
what the group votes on. With the Homeroom connector, `get_checkout_status`
answers the same question.

A session-start hook (`.claude/hooks/homeroom-freshness.sh`, see `.claude/README.md`) runs
this check for you and tells you when you are behind. It is silent offline, so
its silence is not proof the checkout is current. Inside Homeroom's dev-chat
the platform fixes the base commit, and none of this applies.

## Starter template

The screen this app currently ships — the "Starter template" hero with
the app's thumbnail tile and the plain-English note on how the app gets
built (by asking Homeroom bot) — is placeholder content from the
Homeroom starter template, not product intent.

When the user asks for their first real feature, REPLACE the template
screen rather than building alongside it:

- remove the `usernode-starter-notice@1` block in `public/index.html`
  (both sentinel comments and everything between them),
- rewrite `README.md` to describe the actual app.

Keep the `usernode-dev-console@1` forwarder `<script>` when rewriting the
HTML — that block is platform infrastructure, not template content. So is
the bridge `<script>`. The design kit is not placeholder either: build the
real app with it, and fill in "## Design" below.

The screen has a light and a dark look and follows the viewer's Homeroom
theme, switching live when they change it: the theme `<script>` right after
the bridge tag sets a `dark` class on `<html>`. Keep that script, and give
everything you build both looks (the design kit's colour tokens carry both), unless one
fixed look is the point of this app, like a game's own scene; then say so
under "## Design" below. Unless a request asks for one, add
no theme picker: the viewer's Homeroom setting is the control. "The
platform's light/dark theme inside the app frame" in the platform
conventions has the details.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About Bay Area Restaurant Tier List

A shared tier list for Bay Area restaurants that a group of friends uses
together. Anyone in the group can add a place (name plus an optional note);
everyone ranks each one into their own S / A / B / C tier; the board shows
where the group lands on average. Visitors without a Homeroom account can
look at the board; adding and ranking ask them to make an account.

## Design

This app's look. Set by the first version; every later change follows it,
and updates it when a request changes the look on purpose.

- **Palette:** cool fog greys (a Bay Area morning, not warm stone) for the
  neutrals; the action colour is **ink** — near-black in light, near-white
  in dark — because red is the S tier's colour and the primary button must
  not read as a tier. Focus ring is blue; danger is the kit default. Tier
  colours are the ones every tier list in the world already uses, as their
  own tokens: tier-s coral red, tier-a orange, tier-b yellow, tier-c green,
  tier-d teal, tier-f cool grey,
  with ink-dark `--on-tier` letters on them (5:1 or better on every tier
  colour in both looks). Tier colours appear only as tier markers — tiles,
  chip tags, split bars, tier buttons — never as accents.
- **Signature element:** the tier band — a full-height tile in the tier's
  colour holding a heavy rounded letter, restaurants beside it like
  stickers on a board. The same letter-in-a-tile returns at every size:
  the 22 px your-tier tag on each chip, the 28 px rows of the group split
  in the sheet, the 56 px tier buttons, and the app mark (a line-drawn
  noodle bowl in a coral S tile).
- **Type scale:** `text-title` (1.625rem/2rem, weight 800),
  `text-heading` (1.125rem/1.5rem, weight 650), `text-body` (1rem/1.5rem),
  `text-small` (0.875rem/1.25rem). `font-display` (ui-rounded, then SF Pro
  Rounded, then system-ui) is used ONLY for tier letters and the app
  title, at weight 800; everything else is `font-sans` (system-ui).
- **Both looks:** light and dark, following the viewer's Homeroom theme,
  switching live. No theme picker: the viewer's Homeroom setting is the
  control.

The kit is in `styles/tailwind-input.css`: colour tokens with a light and
a dark value (named in `tailwind.config.js`), and a few components
(`btn-primary`, `btn-secondary`, `field`, `list` and `list-row`,
`card`, `section-label`, `skeleton`, `state-empty`, `state-error`) plus
the board's own (`tier-band`, `tier-tile`, `chip`, `chip-tag`, `seg`,
`tier-pick`/`pick`, `dist`, `shelf-chips`, `is-drop-target`).
Re-theme by changing the token values there, keeping every text pair at
4.5:1 or more in both looks.

- Colour comes only from the tokens (`bg-ground`, `bg-surface`,
  `text-fg`, `text-muted`, `border-line`, `bg-accent` with
  `text-on-accent`, ...): never a raw hex value or a stock palette class.
- Tap targets are at least 44 px; the buttons and fields already are.
- A field's label says what it is; its placeholder, if any, is an example
  that says so ("e.g. Sunset Pho"), never a bare value that could pass for
  one already entered.
- Every screen that loads data has honest loading, empty and error states.
  Never show the empty state while loading or after a failure; an error says
  what failed, what still works, and offers Retry.
- Seed obviously fake staging demo data so the populated screen can be seen
  ("Staging mock data" in the platform conventions).
- No cards in cards, no uppercase eyebrows, no emoji as icons.

## App-specific conventions

- **Tiers are fixed at S, A, B, C, D, F.** The group-tier rule lives ONLY in
  `lib/tiers.js` (S counts 6 … F counts 1, group tier is the nearest
  letter to the mean, exact half rounds up) and is unit-tested in
  `test/tiers.test.js`. The client mirrors it in `app.js` only to paint
  the optimistic update; the quiet reload after every write brings the
  server's numbers back. Change the rule in `lib/tiers.js`, never in the
  client.
- **`is_demo` rows are never shown without staging plus `?demo=1`.** Every
  API route computes `demo = IS_STAGING && req.query.demo === '1'` and
  filters on it; a write on a restaurant whose `is_demo` does not match,
  or that is removed, is a 404. The `demo_viewers` marker is written once
  per viewer on their first `?demo=1` board request, so what a viewer
  changes in the demo stays changed.
- **`reports` is `staging:private`** (as is `demo_viewers`): a report
  hides a restaurant for the reporter at once and for everyone at two
  distinct reports. Nobody reviews reports.
- **Removing a restaurant is a soft delete** (`removed_at`): the unique
  index `(is_demo, lower(name)) WHERE removed_at IS NULL` frees the name
  for reuse, and only the adder can edit or remove.
- **User ids are stored as `String(req.user.id)`** and usernames come from
  `req.user.username`; read routes work for guests (`req.user ? … : null`),
  since guests can read every GET.
- Class names for tier variants are written as whole literals via lookup
  objects in `public/app.js` (`BAND_CLASS`, `TAG_CLASS`, …), never built by
  gluing `t-` + tier together — the stylesheet is compiled from literals.
- No new dependencies without a reason; the app is Express + pg only.
