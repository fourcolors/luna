/**
 * The capability envelope: the normalized, versioned shape every backend's
 * capabilities (commands, skills, future kinds) are decoded into, and the
 * boundary validators that enforce "parse, don't trust".
 *
 * Zero dependencies — hand-rolled narrowing rather than a schema library — so
 * this module stays browser-IIFE-friendly and faithful to the package's
 * zero-dep promise. See SPEC.md for the behavioral contract.
 */

/** Which renderer handles a capability. Open set: unknown kinds are data, not errors. */
export type CapabilityKind = "command" | "skill" | "tool" | (string & {})

/** Where a capability runs: locally in the client, or dispatched back to the backend. */
export type CapabilityExecutor = "client" | "server"

/** One thing a harness exposes to a UI, normalized and versioned. */
export interface CapabilityDescriptor {
  readonly kind: CapabilityKind
  /** Stable within (backend, kind); must survive catalog refreshes. */
  readonly id: string
  readonly title: string
  readonly description?: string
  /** Command-shaped argument hint, e.g. "[scope]". */
  readonly argHint?: string
  /** Skill-shaped toggle state. */
  readonly enabled?: boolean
  readonly executor: CapabilityExecutor
  /** Per-kind shape version; integer >= 1. */
  readonly schemaVersion: number
  /** Kind-specific extras the matching renderer understands. Opaque pass-through. */
  readonly detail?: Record<string, unknown>
}

/** What a provider advertises. */
export interface CapabilityCatalog {
  /** Bump ⇒ clients re-fetch. Mirrors ServerDescriptor.generation. */
  readonly generation: number
  /** Negotiated schema version. Mirrors ServerDescriptor.negotiation.agreed. */
  readonly agreedSchema: number
  readonly capabilities: readonly CapabilityDescriptor[]
}

export type Decoded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

export interface RejectedCapability {
  readonly index: number
  readonly error: string
}

/**
 * Catalog decode is resilient: a structurally-valid envelope always decodes,
 * keeping the valid capabilities and surfacing the invalid ones in `rejected`
 * (never silently dropped). Only a malformed envelope itself fails outright.
 */
export type DecodedCatalog =
  | { readonly ok: true; readonly value: CapabilityCatalog; readonly rejected: readonly RejectedCapability[] }
  | { readonly ok: false; readonly error: string }

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// Identifiers (kind, id) must be free of control characters: they key the merge
// (kind,id) collision map via a NUL separator, so a control char inside one could
// forge a collision. Checked by code point to keep the source pure ASCII.
const hasControlChar = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

/**
 * Deep-copy opaque data so a decoded value never aliases the untrusted input.
 * structuredClone where available (browsers, Bun, Node >= 17), JSON round-trip
 * otherwise. Either may throw on non-cloneable values; callers wrap in try/catch
 * so such input fails loudly rather than escaping the trust boundary.
 */
const cloneData = <T>(v: T): T => {
  const sc = (globalThis as { structuredClone?: <U>(x: U) => U }).structuredClone
  return sc ? sc(v) : (JSON.parse(JSON.stringify(v)) as T)
}

/** Decode + validate a single capability descriptor at the trust boundary. Total: never throws. */
export function decodeCapabilityDescriptor(input: unknown): Decoded<CapabilityDescriptor> {
  if (!isRecord(input)) return fail("descriptor must be an object")
  try {
    return decodeDescriptorChecked(input)
  } catch (e) {
    return fail(`descriptor could not be read: ${errMsg(e)}`)
  }
}

function decodeDescriptorChecked(o: Record<string, unknown>): Decoded<CapabilityDescriptor> {
  if (typeof o.kind !== "string" || o.kind.length === 0) return fail("kind must be a non-empty string")
  if (typeof o.id !== "string" || o.id.length === 0) return fail("id must be a non-empty string")
  if (hasControlChar(o.kind)) return fail("kind must not contain control characters")
  if (hasControlChar(o.id)) return fail("id must not contain control characters")
  if (typeof o.title !== "string") return fail("title must be a string")
  // Control chars (e.g. newlines) in display strings let an untrusted backend forge
  // a second menu row / visually spoof a command — reject, matching kind/id discipline.
  if (hasControlChar(o.title)) return fail("title must not contain control characters")
  if (o.executor !== "client" && o.executor !== "server") return fail('executor must be "client" or "server"')
  if (typeof o.schemaVersion !== "number" || !Number.isInteger(o.schemaVersion) || o.schemaVersion < 1) {
    return fail("schemaVersion must be an integer >= 1")
  }

  // Only known keys are copied — unknown extras are stripped, not rejected (forward-compatible).
  const out: Mutable<CapabilityDescriptor> = {
    kind: o.kind,
    id: o.id,
    title: o.title,
    executor: o.executor,
    schemaVersion: o.schemaVersion,
  }

  // Optional fields: validated only when present; absent stays absent (no undefined/null coercion).
  if (o.description !== undefined) {
    if (typeof o.description !== "string") return fail("description must be a string")
    if (hasControlChar(o.description)) return fail("description must not contain control characters")
    out.description = o.description
  }
  if (o.argHint !== undefined) {
    if (typeof o.argHint !== "string") return fail("argHint must be a string")
    if (hasControlChar(o.argHint)) return fail("argHint must not contain control characters")
    out.argHint = o.argHint
  }
  if (o.enabled !== undefined) {
    if (typeof o.enabled !== "boolean") return fail("enabled must be a boolean")
    out.enabled = o.enabled
  }
  if (o.detail !== undefined) {
    if (!isRecord(o.detail)) return fail("detail must be an object")
    out.detail = cloneData(o.detail) // own the output: never alias untrusted input
  }

  return { ok: true, value: out }
}

/** Decode + validate a capability catalog. Resilient to individual bad entries. Total: never throws. */
export function decodeCapabilityCatalog(input: unknown): DecodedCatalog {
  if (!isRecord(input)) return fail("catalog must be an object")
  try {
    return decodeCatalogChecked(input)
  } catch (e) {
    return fail(`catalog could not be read: ${errMsg(e)}`)
  }
}

function decodeCatalogChecked(o: Record<string, unknown>): DecodedCatalog {
  if (typeof o.generation !== "number" || !Number.isInteger(o.generation) || o.generation < 0) {
    return fail("generation must be a non-negative integer")
  }
  if (typeof o.agreedSchema !== "number" || !Number.isInteger(o.agreedSchema) || o.agreedSchema < 1) {
    return fail("agreedSchema must be an integer >= 1")
  }
  if (!Array.isArray(o.capabilities)) return fail("capabilities must be an array")

  const capabilities: CapabilityDescriptor[] = []
  const rejected: RejectedCapability[] = []
  // Bound the catalog so a compromised/buggy backend can't wedge the client with a huge
  // array (DoS via unbounded decode + DOM rows). Overflow is surfaced, never silent.
  const MAX_CAPABILITIES = 256
  o.capabilities.forEach((c, index) => {
    if (index >= MAX_CAPABILITIES) {
      if (index === MAX_CAPABILITIES) {
        rejected.push({ index, error: `catalog exceeds ${MAX_CAPABILITIES} capabilities; extras dropped` })
      }
      return
    }
    const d = decodeCapabilityDescriptor(c)
    if (d.ok) capabilities.push(d.value)
    else rejected.push({ index, error: d.error })
  })

  return {
    ok: true,
    value: { generation: o.generation, agreedSchema: o.agreedSchema, capabilities },
    rejected,
  }
}
