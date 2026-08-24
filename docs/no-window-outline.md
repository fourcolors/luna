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
- ✅ The `.resize-*` grips are exempt because they are transient affordances,
  not a persistent window edge. (The old `.dragging` / `.entering` /
  `.snapping::after` drag affordances were removed along with magnetic
  snapping - macOS owns drags natively now - so do not re-add them.)

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

## Related: the card gutter (`--card-inset`) and who owns the frame

The sibling failure mode is an *invisible* border rather than a drawn one. The
card insets itself by `--card-inset` so the halo has somewhere to cast. On a
**borderless** window (Linux/Windows, `decorations(false)`) that is correct — the
CSS card is the entire chrome. On **macOS** the window is natively decorated
(`decorations(true)` + `TitleBarStyle::Overlay`) *and* transparent, so that
gutter is see-through window: it renders as a band of desktop around every panel
and screen, and it eats clicks near the edge.

So the geometry is keyed off `html[data-native-frame]` (stamped pre-paint by
`vendor/moon-appearance.js`):

| | borderless | native frame (macOS) |
|---|---|---|
| `--card-inset` | `22px` | `0` |
| card corner | skin `--dk-radius` | `10px` (the macOS window corner) |
| depth cue | CSS `--dk-win-shadow` halo | AppKit's own window shadow |

Two rules follow from this and must not be broken:

- **Never re-add a CSS halo on a native frame.** With a zero inset there is no
  transparent margin to cast into, so it can only shear square at the window
  bounds — which is this document's artifact again, by another route.
- **The card corner must be `<=` the OS window corner.** A larger radius leaves
  transparent wedges in the four corners.

`TRAFFIC_LIGHT_INSET_X/Y` in `src-tauri/src/windows.rs` are window coordinates
that must line up with the CSS header, so they track `--card-inset` and move with
it. `apps/ui-moon-tauri/test/moon-native-frame.test.ts` asserts that arithmetic
rather than the literals.

## If you genuinely need a visible card edge

Use a **blurred, low-spread** shadow tuned into `--dk-win-shadow` per skin — never
a `0 0 0 Npx` spread ring. If a design truly requires a hairline edge, raise it
explicitly with the maintainer first; the default and every shipped skin must
have no outline.
