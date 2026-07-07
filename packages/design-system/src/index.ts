/**
 * @luna/design-system — framework-agnostic design tokens + appearance helper.
 *
 * The CSS token/primitive cascade ships separately (import "@luna/design-system/css").
 * This entry re-exports the appearance helper (palette/theme/chrome/grain/font
 * stamping + cross-tab sync), which is pure DOM/localStorage and shared with
 * Moon's vendor/moon-appearance.js by convention (same keys + defaults).
 */
export * from "./appearance"
