/**
 * The client-side capability registry: maps a CapabilityKind to a frontend-specific
 * renderer/handler. The package never inspects the renderer type `R` — Moon binds a
 * DOM builder, ui-web a Solid component, agent-cli a TUI cell — so this stays
 * framework-free. Instance-based (no module-global state) so importing the package
 * has no side effects and two hosts never share a renderer map.
 */

import type { CapabilityKind } from "./descriptor.js"

export interface RegisterOptions {
  /** Default true: re-registering a kind replaces it. False: keep the original and report a conflict. */
  readonly overwrite?: boolean
}

export type RegisterResult =
  | { readonly ok: true; readonly replaced: boolean }
  | { readonly ok: false; readonly error: string }

export interface CapabilityRegistry<R> {
  /** Bind a renderer to a kind. Last-write-wins by default (HMR-friendly). */
  register(kind: CapabilityKind, renderer: R, opts?: RegisterOptions): RegisterResult
  /** Unknown/unregistered kind ⇒ undefined. Never throws (forward-compatible). */
  get(kind: CapabilityKind): R | undefined
  has(kind: CapabilityKind): boolean
  /** Registered kinds, sorted ascending for deterministic enumeration. */
  kinds(): CapabilityKind[]
}

export function createCapabilityRegistry<R>(): CapabilityRegistry<R> {
  // Map (not a plain object) so a kind of "__proto__"/"constructor" is plain data, never pollution.
  const map = new Map<string, R>()
  return {
    register(kind, renderer, opts) {
      const overwrite = opts?.overwrite ?? true
      const existed = map.has(kind)
      if (existed && !overwrite) {
        return { ok: false, error: `a renderer is already registered for kind "${kind}"` }
      }
      map.set(kind, renderer)
      return { ok: true, replaced: existed }
    },
    get(kind) {
      return map.get(kind)
    },
    has(kind) {
      return map.has(kind)
    },
    kinds() {
      return [...map.keys()].sort()
    },
  }
}
