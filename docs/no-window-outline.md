# Rule: the Moon card window has NO outline — ever

**The card window (`.widget-shell`) must never show a crisp edge ring, border, or
outline tracing its rounded rectangle.** Only the soft, *blurred* drop-shadow halo
(`--dk-win-shadow`) is allowed. A crisp `box-shadow: 0 0 0 Npx`, a `border`, or an
`outline` on `.widget-shell` (or its `::before`) renders as a hard line around the
whole window — the "outline" / "focus border" that is explicitly unwanted.

This kept regressing because the outline has **several independent sources**, and
fixes that addressed one (e.g. WebKit's mouse-focus ring) left the others. The
real culprit was a **skin/chrome edge ring**, not a focus ring.

## What may NOT appear on `.widget-shell` / `.widget-shell::before`

- ❌ `box-shadow: 0 0 0 Npx <color>` — a spread-only shadow is a crisp ring.
- ❌ `border: <anything but none/0>`
- ❌ `outline: <anything but none/0>`

## What IS allowed

- ✅ A **blurred** halo only, via `box-shadow: var(--dk-win-shadow)` on
  `.widget-shell` — i.e. shadows with a blur radius and offset, no `0 0 0 Npx`
  spread ring.
- ✅ Transient drag/snap affordances are exempt because they are not the
  persistent window edge: `.widget-shell.snapping::after` (the predictive snap
  ring), `.widget-shell.dragging`, `.widget-shell.entering`, and the
  `.resize-*` grips.

## Sources that were removed (do not re-add)

| Source | File | What it was |
|---|---|---|
| classic/aqua skin ring | `vendor/moon-skins.css` | `box-shadow: 0 0 0 1.5px var(--dk-win-border)` |
| ink chrome ring | `vendor/moon-theme.css` | `box-shadow: 0 0 0 1.5px …ink 55%…` on `[data-chrome='ink'] ::before` |
| ink + dark ring | `vendor/moon-theme.css` | same ring on `[data-chrome='ink'][data-theme='dark'] ::before` |

`--dk-win-border` is now unused — **do not re-wire it into a ring.**

## Enforcement

`apps/ui-moon-tauri/test/no-window-outline.test.ts` scans `moon-theme.css` and
`moon-skins.css` and fails CI if any `.widget-shell` rule declares a crisp
`0 0 0 Npx` box-shadow ring, a `border`, or an `outline`. If that test fails, you
re-introduced the window outline — remove the offending declaration; do not
weaken the test.

## If you genuinely need a visible card edge

Use a **blurred, low-spread** shadow tuned into `--dk-win-shadow` per skin — never
a `0 0 0 Npx` spread ring. If a design truly requires a hairline edge, raise it
explicitly with the maintainer first; the default and every shipped skin must
have no outline.
