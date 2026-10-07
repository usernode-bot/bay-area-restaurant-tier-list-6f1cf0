# Bay Area Restaurant Tier List

A shared tier list for Bay Area restaurants, built with a group of friends
on Homeroom. Anyone can add a place; everyone ranks each one into their own
S / A / B / C tiers; the board shows where the group lands on average.

- **The board** is what the app opens on: four tier bands, S to C, each
  holding the restaurants the group put there on average. A small letter on
  each chip shows where you put it; a dashed one means you haven't ranked
  it yet.
- **Group / Mine** flips between the group's board and your own. On Mine
  you drag a restaurant onto a band (press and hold on a phone) or tap it
  and pick a tier; dropping it back on "To rank" clears your choice. On
  Group, signed in, you can drag too: dropping a restaurant on a band sets
  your own tier (the group band then re-averages), and dropping it on
  "Not ranked yet" clears it.
- **Tap a restaurant** to see its note, who added it, your four tier
  buttons, and how the group splits — who put it where, and how much the
  group agrees.
- **Anyone can add** from the Add button: a name, an optional note, and an
  optional tier of your own. Whoever added a restaurant can edit or remove
  it; anyone else can report it. A report hides it for the reporter at
  once, and for everyone at two reports.

Visitors without a Homeroom account can look at the board; adding and
ranking ask them to make an account. The app follows the viewer's Homeroom
light or dark theme, works at phone and desktop width, and follows the
design recorded in `CLAUDE.md`'s "Design" section.

## Development

```sh
npm install
npm run build   # compiles styles/tailwind-input.css to public/tailwind.css
npm test        # unit tests for the tier maths (lib/tiers.js)
node server.js  # needs DATABASE_URL and the platform's JWT env vars
```

Schema is created idempotently on boot. On staging, `/?demo=1` shows a
populated demo board: made-up restaurants, made-up friends, and the
viewer's own demo tiers written once. Nothing demo ever appears without
`?demo=1` on staging.