# Relay — repo instructions for Claude Code

## Git workflow

Preview-branch review doesn't work in this setup. For any change: create a
branch, open a PR, and merge it directly to `main` once checks pass and
there's no conflict. Do not leave work parked on an unmerged branch expecting
a separate preview-review step. Vercel deploys `main` to production
automatically, so a merged PR is a production deploy.

## Brand & design system

FieldPulse brand tokens and UI conventions for the customer-facing tracker
(`app/t/[token]`) are documented in `docs/brand-guidelines.md` (rules) and
`app/brand.css` (tokens), with a rendered reference at `design/ui-kit.html`.
Follow these for any UI work rather than introducing new colors, fonts, or
status semantics ad hoc. Explored-but-not-all-shipped full-page directions
live in `design/option-a-board.html`, `design/option-b-signal.html` (the one
shipped), and `design/option-c-journey.html`.
