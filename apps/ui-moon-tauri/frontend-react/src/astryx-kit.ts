// astryx-kit.ts - single re-export surface for @astryxdesign/core primitives
// used inside Moon's React surface. Mirrors apps/ui-web/src/studio/astryx-kit.tsx
// (same convention, same rationale): import Astryx components from here, not
// from "@astryxdesign/core/*" or the top-level barrel directly, so the
// subpath-import convention that keeps a non-tree-shaking consumer from
// pulling in every Astryx component stays enforced from one place.
//
// Empty today (the scaffold phase mounts no visible Astryx component inside
// Moon yet - see boot.tsx). Add re-exports here as panels convert in the next
// phase, following ui-web's per-component subpath pattern, e.g.:
//   export { Button } from "@astryxdesign/core/Button"
export {}
