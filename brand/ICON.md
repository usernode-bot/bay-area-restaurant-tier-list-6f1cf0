# App icon and featured image

The mark: a noodle bowl with two chopsticks standing in it like the towers
of a suspension bridge, a noodle hung between them like a cable, and three
left-aligned rounded tier bars below it (shorter as they go down) — the
letter-less version of a tier list. Flat, no text, no gradients, shadows or
filters. Every smooth edge is a blend of the two palette colours it sits
between.

## Files

| File | What it is |
| --- | --- |
| `icon.svg` | 1024×1024 source of the app icon (black ground, cream mark) |
| `icon.png` | 1024×1024 render of `icon.svg`, the file `dapp.json` points at |
| `featured-dark.svg` / `featured-dark.png` | 1600×900, cream mark on a black ground (same geometry scaled 1.05× and centred) |
| `featured-light.svg` / `featured-light.png` | 1600×900, black mark on a cream ground; the tier bars keep their colours with a black outline so yellow stays clear on cream |

The PNGs were rendered from the SVGs at their exact pixel sizes with the
in-loop browser (viewport set to the image's size, screenshot saved to
`brand/`). The PNGs are opaque full-bleed squares/rectangles with square
corners; Homeroom rounds the tile's corners when it shows them.

Note: the featured PNGs are committed for review but nothing on the platform
reads them yet — `dapp.json` has no documented featured-image field.

## Colours (Homeroom brand palette only)

| Colour | Hex | Where |
| --- | --- | --- |
| Black | `#000000` | app-icon ground; light featured ground; light featured mark |
| Cream | `#FFFEEA` | app-icon mark; dark featured ground; light featured ground |
| Yellow | `#FFEE6F` | tier bar 1 |
| Blue | `#3090E1` | tier bar 2 |
| Green | `#A9CF97` | tier bar 3 |

Grey `#B9B9B9`, White `#FFFFFF` and pale yellow `#FCFAB3` are not used.
Pairings follow the brand: Cream on Black, and Yellow, Blue and Green on
Black (bars), with the Black-on-Cream pairing for the light featured image.

## Geometry (1024 grid, `icon.svg`)

- Ground: `rect 0 0 1024 1024` black.
- Chopsticks: lines x=372 and x=652, y 160→430, cream, width 56, round caps.
- Noodle cable: `M372 168 Q512 420 652 168`, cream, width 44, round caps, no fill.
- Bowl: `M212 430 H812 A300 180 0 0 1 212 430 Z`, cream fill.
- Tier bars: `rx 32`, height 64, left edge x=212 — yellow y=652 w=560,
  blue y=740 w=400, green y=828 w=240.

The featured SVGs reuse this group inside
`transform="translate(262.4 -87.6) scale(1.05)"` on a 1600×900 ground
(the 1.3× suggested in triage would not fit the mark's height in 900 px).