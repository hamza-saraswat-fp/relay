# FieldPulse brand guidelines (Relay)

The reference for how Relay looks and feels. Tokens live in
[`app/brand.css`](../app/brand.css); a rendered kit lives at
[`design/ui-kit.html`](../design/ui-kit.html). Raw logo files are in
[`public/brand/`](../public/brand).

## The idea

FieldPulse's mark is a signal, three arcs radiating out like a pulse. Relay is
the product that carries that signal to the customer: their support tickets,
tracked live, "where is it right now." Lean into that. Motion that reads as a
heartbeat or a live feed, a board that feels current, status that updates in
front of you. That is the one thing every screen should evoke.

## Color

| Token | Hex | Where it goes |
|---|---|---|
| Navy | `#00034D` | Primary. Backgrounds, headlines, the wordmark, all body ink. |
| Cobalt | `#253E9A` | Primary action, links, "with support" status, secondary fills. |
| Sky | `#6183D8` | "In progress" status, charts, supporting accents, hovers. |
| Aqua | `#6CB4E4` | The live/pulse accent. Signal dots, active indicators, glow. |
| Quartz | `#8B8ED6` | Soft tertiary. Dividers on dark, muted labels, decorative. |
| Fog | `#E2E2E2` | Neutral gray. Borders, disabled, quiet surfaces. |

Navy is the anchor. Aqua is the spark, use it sparingly so it stays loud. Every
other neutral in the product (text, lines, page background) is derived from navy
rather than a flat gray, which keeps the whole surface reading as one brand. See
the `--fp-ink-*`, `--fp-line-*`, and `*-050 / *-100` tint tokens.

### Status semantics

Four ticket states, each with a fixed meaning. Reinforce with a filled vs.
outline treatment and an icon, never hue alone (accessibility).

| State | Meaning | Color |
|---|---|---|
| Waiting for You | Customer action needed. The one that must stand out. | Attention amber `#D98324` |
| Waiting for Support | Queued with us. | Cobalt |
| In Progress | Actively being worked. | Sky |
| Resolved | Done. | Success green `#1E7A57` |

Amber and green sit outside the core brand palette on purpose: they are
functional colors. An all-blue status system cannot signal urgency or success
clearly, so we allow exactly two warm/green accents, used only for status.

## Logo

Assets in `public/brand/` (SVG preferred, PNG fallback):

- `navy_logo.svg` — wordmark for light backgrounds.
- `white_logo.svg` — wordmark for navy/dark backgrounds.
- `fp_icon.svg` — the standalone signal mark (rounded square). App icon, favicon,
  compact lockups, avatars.

Rules:

- Pick the logo by contrast: navy wordmark on light, white wordmark on dark.
  Never navy on navy.
- Keep clear space around the wordmark equal to the height of the signal arcs.
- Do not recolor, stretch, add effects, or box the wordmark in a competing color.
- The browser-tab favicon is `fp_icon.svg`, wired through `app/icon.svg`.

## Typography

The wordmark is a bold rounded geometric. Product type should feel engineered
and trustworthy, not decorative. Avoid the generic defaults (Inter, Roboto,
Arial, system-ui as a brand choice). Pair one distinctive display face with a
clean, highly legible body face, and use a mono for anything tabular (times,
ticket numbers, the status board) so columns align and the product reads "live."

Type hooks are exposed as `--fp-font-display`, `--fp-font-sans`, and
`--fp-font-mono` so the chosen faces are swapped in one place.

## Motion

One idea, applied with restraint: the pulse. A slow signal ripple on live
indicators, a staggered reveal on load so the board feels like it is coming in,
a gentle count-up on the headline stats. High-impact moments over scattered
micro-interactions. Respect `prefers-reduced-motion`.
