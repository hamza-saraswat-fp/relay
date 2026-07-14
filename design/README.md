# Relay redesign · design drafts

Customer-facing redesign explorations for the support status page. These are
self-contained HTML drafts rendered with the real seed account (Bluebird
Plumbing & Air) so we can compare directions before porting the winner into the
Next.js app.

## View them

From the repo root:

```bash
python3 -m http.server 4599
# then open http://127.0.0.1:4599/design/
```

`design/index.html` is a gallery with live thumbnails linking to each option.

## The three directions

| File | Name | Concept | Feels like |
|---|---|---|---|
| `option-a-board.html` | **The Board** | A live departures / mission-control board. Dark navy, monospace data columns, pulsing "live" signal, status "gates." Leans hardest into the flight-tracker analogy. | Bold, technical, premium ops screen |
| `option-b-signal.html` | **Signal** | A modern live-status page. Light and airy, a pulse-line hero card, a per-ticket status meter (Opened to Resolved). | Clean, modern SaaS, confident |
| `option-c-journey.html` | **The Journey** | Support tickets reframed as deliveries in transit. Warm paper, serif headline, per-ticket transit tracks with stage icons, message bubbles from the team. | Warm, human, reassuring |

All three share:

- The **FieldPulse palette** (navy, cobalt, sky, aqua, quartz, fog) from `app/brand.css`.
- The **live-signal idea** carried through motion (pulse beacons, ripples).
- The **same four-state status system** and the same ticket data.
- The **real logo**: white wordmark on dark (A), navy wordmark on light (B, C), signal mark as favicon everywhere.

## A note on status colors

The four states use two functional colors that sit outside the six core brand
hues, on purpose:

- **Waiting for You** uses a warm amber. It is the only state that needs the
  customer to act, so it must break out of the all-blue field and grab the eye.
- **Resolved** uses a success green, which reads universally as "done."

The other two states (Waiting for Support, In Progress) stay in-brand on cobalt
and sky. If we want strict six-color fidelity, "Waiting for You" can move to aqua
with a stronger pulse treatment instead of amber. Easy swap, one token.

## Next step

Pick a direction (or a hybrid: for example, Board energy with the Signal
layout, or the Journey tracks inside the Signal shell). The winner gets ported
into `app/t/[token]/page.tsx` with `next/font`, real `AccountView` data, and the
existing fail-closed rules preserved.
