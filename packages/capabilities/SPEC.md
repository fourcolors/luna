# @luna/capabilities — Behavioral Spec (ping-pong)

One versioned, framework-free envelope for everything a harness (Luna, Hermes, OpenClaw)
exposes to a UI — slash commands, skills, and future kinds. Built cycle-by-cycle:
spec → failing test (RED) → implement (GREEN) → independent audit. Evidence (test output)
required before any cycle is called done.

The maintainability non-negotiables this package must embody:
1. **Schema is the single source of truth, validated at the boundary** — "parse, don't trust".
2. **Forward-compatible by contract** — unknown kinds/fields never throw.
3. **No silent gaps** — invalid data is surfaced (returned for logging), never silently dropped.

---

## Cycle 1 — Capability descriptor & catalog, validated at the boundary

`CapabilityDescriptor` is the normalized, versioned shape for one thing a harness exposes:

| field | type | notes |
|---|---|---|
| `kind` | `string` | which renderer handles it: `"command" \| "skill" \| "tool" \| …`. **Open set.** |
| `id` | `string` | stable within `(backend, kind)`; survives catalog refreshes |
| `title` | `string` | human label |
| `description?` | `string` | |
| `argHint?` | `string` | command-shaped |
| `enabled?` | `boolean` | skill-shaped (toggle state) |
| `executor` | `"client" \| "server"` | run locally, or dispatch back to the backend |
| `schemaVersion` | `number` | per-kind shape version; integer `>= 1` |
| `detail?` | `Record<string, unknown>` | kind-specific extras, opaque pass-through |

`CapabilityCatalog` is what a provider advertises:

| field | type | notes |
|---|---|---|
| `generation` | `number` | bump ⇒ clients re-fetch (mirrors `ServerDescriptor.generation`) |
| `agreedSchema` | `number` | negotiated schema version (mirrors `negotiation.agreed`) |
| `capabilities` | `CapabilityDescriptor[]` | |

### Validators (parse, don't trust)

```ts
type Decoded<T> = { ok: true; value: T } | { ok: false; error: string }
type RejectedCapability = { index: number; error: string }
type DecodedCatalog =
  | { ok: true; value: CapabilityCatalog; rejected: RejectedCapability[] }
  | { ok: false; error: string }

decodeCapabilityDescriptor(input: unknown): Decoded<CapabilityDescriptor>
decodeCapabilityCatalog(input: unknown): DecodedCatalog
```

### Scenarios — descriptor

- **well-formed descriptor decodes.** Given `{kind:"command",id:"clear",title:"Clear",executor:"client",schemaVersion:1}`, when decoded, then `ok` is true and `value` equals the normalized descriptor.
- **unknown kind is accepted (forward-compatible).** Given a descriptor with `kind:"workflow"`, when decoded, then `ok` is true — `kind` is an open set; an unknown kind is data, not an error.
- **unknown extra fields are stripped, not rejected.** Given a well-formed descriptor plus `futureField:"x"`, when decoded, then `ok` is true and `value` does **not** contain `futureField`.
- **missing required field fails loudly.** Given a descriptor missing `id`, when decoded, then `ok` is false and `error` names `id`.
- **invalid executor fails loudly.** Given `executor:"banana"`, when decoded, then `ok` is false and `error` mentions `executor`.
- **schemaVersion must be a positive integer.** Given `schemaVersion:0`, `1.5`, or a non-number, when decoded, then `ok` is false and `error` mentions `schemaVersion`.
- **wrong-typed title fails loudly.** Given `title:42`, then `ok` is false and `error` mentions `title`.
- **optional fields stay optional.** Given a descriptor with no `description/argHint/enabled/detail`, when decoded, then `ok` is true and those keys are absent from `value` (not coerced to `undefined`/`null`).
- **detail passes through opaque.** Given `detail:{nested:{a:1},list:[1,2]}`, when decoded, then `ok` is true and `value.detail` deep-equals the input.
- **non-object input fails loudly.** Given `null`, `"str"`, or `42`, then `ok` is false.

### Scenarios — catalog (resilient + no silent gaps)

- **all-valid catalog decodes.** Given `{generation:1,agreedSchema:1,capabilities:[valid,valid]}`, then `ok` is true, `value.capabilities` has length 2, `rejected` is empty.
- **keeps the valid, surfaces the invalid.** Given `capabilities:[valid, {missing id}]`, then `ok` is true, `value.capabilities` has length 1 (the valid one), and `rejected` has length 1 with `index:1` and an `error` naming `id`. (One bad command must NOT nuke the whole menu — but it is never silently dropped.)
- **malformed envelope fails loudly.** Given `capabilities` is not an array, or `generation`/`agreedSchema` is missing/non-number, then `ok` is false with an `error`.
- **non-object catalog fails loudly.** Given `null` or `"x"`, then `ok` is false.
- **catalog size is bounded (DoS floor).** Given more than 256 capabilities, then `ok` is true, `value.capabilities` is capped at the first 256, and the overflow is surfaced as one `rejected` entry naming the cap — a compromised/buggy backend can't wedge the client with an unbounded decode + DOM rows, and the truncation is never silent.

### Invariants (the floors the validators enforce)

- `kind`, `id`, `title`: non-empty strings (`kind`/`id` must be non-empty; `title` must be a string). **Every string field is free of control characters** (newline, tab, NUL, DEL): `kind`/`id` because they key the merge `(kind,id)` collision map, and the display strings `title`/`description`/`argHint` because a control char (e.g. a newline) in a rendered field lets an untrusted backend forge a second menu row or visually spoof a command.
- `executor`: exactly `"client"` or `"server"`.
- `schemaVersion`, `agreedSchema`: integers `>= 1`.
- `generation`: integer `>= 0` (a monotonic counter that may legitimately start at 0). `NaN`/`Infinity` are rejected everywhere a number is required.

### Hardening (post-audit, Cycle 1)

- **decoded `detail` is a deep copy.** Given a descriptor with `detail`, when decoded, then `value.detail` deep-equals the input but is **not the same reference** — mutating the source after decode does not change `value.detail`, and vice versa. (A trust boundary must own its output; it never hands back a live reference to untrusted input.)
- **decoders are total — they never throw.** Given any input at all (including an object with a throwing/exotic getter), `decodeCapabilityDescriptor`/`decodeCapabilityCatalog` return a `Decoded` result; pathological input fails loudly (`ok:false`) rather than throwing.
- **prototype pollution never survives.** Decoding an object carrying a literal `__proto__` own key (e.g. from `JSON.parse`) neither pollutes `Object.prototype` nor copies the key into the output (only whitelisted fields are copied).
- **type coercion is rejected, not silently accepted.** `enabled: 0`, `enabled: "true"`, `title: true`, etc. fail loudly.
- **per-field size bounds (anti-DoS).** Untrusted strings are length-capped so a backend can't wedge the client with megabyte-scale fields (allocation + giant DOM text nodes): `kind`/`id` ≤ 256 chars, the display strings `title`/`description`/`argHint` ≤ 4096 chars, and serialized `detail` ≤ 16384 bytes (an un-stringifiable `detail` is treated as over-limit). Over-limit fields fail loudly. The bounds are generous relative to any legitimate command label.

---

## Cycle 2 — Renderer registry & capability merge

### Renderer registry (framework-free, instance-based)

A frontend binds its own renderer type `R` (Moon DOM builder, Solid component, TUI cell);
the package never inspects `R`. No module-global state — importing the package has no side effects.

```ts
createCapabilityRegistry<R>(): CapabilityRegistry<R>

interface CapabilityRegistry<R> {
  register(kind: CapabilityKind, renderer: R, opts?: { overwrite?: boolean }): RegisterResult
  get(kind: CapabilityKind): R | undefined
  has(kind: CapabilityKind): boolean
  kinds(): CapabilityKind[]
}
type RegisterResult = { ok: true; replaced: boolean } | { ok: false; error: string }
```

Scenarios:
- **register then get** returns the renderer; `has` is true.
- **unknown kind lookup** → `get` returns `undefined`, `has` returns false, never throws (forward-compat).
- **`kinds()`** returns the registered kinds sorted ascending.
- **re-register (default)** replaces the renderer; `result.replaced` is true.
- **re-register `{overwrite:false}`** keeps the original; `result.ok` is false; `get` still returns the original.
- **dangerous kind** `"__proto__"`/`"constructor"` is stored/retrieved via `Map` with no prototype pollution.
- **instance isolation** — two registries never share state.

### mergeCapabilities (pure, total)

Combine capabilities from multiple sources into the single list a panel's menu shows.
Kind-agnostic: the slash menu / skills panel filter the result by kind afterward.

```ts
mergeCapabilities(sources: CapabilitySource[]): MergedCapabilities

interface CapabilitySource { source: string; precedence: number; capabilities: CapabilityDescriptor[] }
interface MergedCapability { source: string; capability: CapabilityDescriptor }
interface DroppedCapability { source: string; capability: CapabilityDescriptor; key: string; winningSource: string }
interface MergedCapabilities { merged: MergedCapability[]; dropped: DroppedCapability[] }
```

- **Collision key = `(kind, id)`**, NUL-separated (`` `${kind} ${id}` ``). `id` is the stability anchor and the token a command user types; `kind` is in the key because `id` is only unique within a kind.
- **Precedence:** the highest-`precedence` source wins a key; UI-owned is given the top precedence so it wins over any backend. Equal precedence → `source` string ascending; an exact duplicate (same source) → first-seen wins.
- **No silent gaps:** every loser is surfaced in `dropped` with the `winningSource`.
- Each `merged` item carries its `source` (for chips) and **wraps the original descriptor by reference** (identity preserved — decode already owns `detail`).
- **Output sorted** by `kind` then `id` (raw code-unit compare, locale-independent → identical across browser-IIFE and Node hosts). `dropped` sorted by `kind`, `id`, `source`.
- **`precedence` must be finite**; a non-finite value (`NaN`/`±Infinity`) ranks lowest so ordering stays deterministic and total.
- The returned `merged`/`dropped` arrays are **frozen** (runtime defense-in-depth).

Scenarios:
- empty `sources` → `{merged:[],dropped:[]}`; a source with empty `capabilities` contributes nothing.
- single source, no collisions → all in `merged` (sorted), `dropped` empty.
- UI vs backend collision on `(kind,id)` → UI wins; backend in `dropped` with `winningSource:"ui"`.
- **same id across two different kinds** → no collision, both survive.
- equal-precedence two-backend collision → deterministic `source`-ascending winner; loser dropped.
- within-source duplicate `(kind,id)` → the second is surfaced in `dropped` (its `winningSource` is its own source).
- three-way collision (UI + two backends) → one winner, two dropped, both `winningSource:"ui"`.
- an `id` containing `":"`/`"/"` never causes a false collision (NUL key).
- `merged[i].capability === inputDescriptor` (wrap, not copy).
- deterministic — same input yields identical `merged`/`dropped` order across runs; inputs are never mutated; never throws.

---

## Cycle 3 — CapabilityProvider port, conformance suite, reference provider

### The port (`src/provider.ts`)

The single version-aware seam each transport adapter implements; it normalizes
backend-native data into the decoded envelope and routes execution back.

```ts
interface CapabilityProvider {
  list(): Promise<CatalogSnapshot>
  subscribe(onChange: (snapshot: CatalogSnapshot) => void): Unsubscribe
  execute(request: ExecuteRequest): Promise<ExecuteResult>
}
type CatalogSnapshot =
  | { ok: true; catalog: CapabilityCatalog; rejected: RejectedEntry[] }
  | { ok: false; error: string }
type ExecuteResult =
  | { ok: true; value: ExecuteOutcome }
  | { ok: false; error: string; reason: "unknown" | "unsupported" | "backend-error" | "unavailable" }
interface ExecuteRequest { kind: string; id: string; args?: string }
```

Contract:
- **Async-total:** no method rejects for an ordinary backend condition. Unreachable backend → `list`/`subscribe` emit `{ok:false}`; `execute` resolves `{ok:false, reason:"unavailable"}`. A rejected Promise = provider bug (the suite forbids it).
- **`list`/`subscribe` deal in the full decoded `CatalogSnapshot`** (generation included), not a bare descriptor list. Kind-filtering is a UI concern (merge + registry own it).
- **Decode runs inside the provider at ingest** — `list`/`subscribe` are contractually required to emit already-decoded catalogs; re-decoding a snapshot is idempotent.
- **`subscribe`** emits the current snapshot exactly once **asynchronously** (next microtask) so a self-unsubscribing handler is never re-entered and never races `list`; then again on every change. Multiple subscribers supported; `Unsubscribe` is idempotent and cancels any in-flight emit; one throwing subscriber doesn't break siblings.
- **`execute`** routes on `(kind,id)` against the **current** catalog: unknown → `{ok:false, reason:"unknown"}` with no routing recorded; known → routed (args verbatim, absent stays absent).

### Reference provider (`src/reference-provider.ts`, ships in the main barrel)

`createReferenceProvider({ initial?, onExecute? })` → `ReferenceProvider` with `setRawCatalog(unknown)` (decodes at the boundary, surfaces `rejected`), `setUnavailable(error)`, and `executions` (the routing oracle). Zero-dep, browser-safe; the conformance suite runs against it to prove suite ⇄ reference agreement.

### Frame provider (`src/frame-provider.ts`, ships in the main barrel)

`createFrameCapabilityProvider(transport, opts?)` → a `CapabilityProvider` backed by a request/response FRAME channel — the production port behind the reference one. It is generic over any `FrameTransport` that can `send(frame)` and `onFrame(handler)` (Moon WS, ui-web WS, …) so "add a backend" reuses this port instead of re-implementing it per frontend. It consumes server→client `capability-catalog` frames (decoded at the boundary into the snapshot, `rejected` surfaced) and `capability-execute-result` frames (keyed by `requestId`), and sends client→server `capability-execute` frames.

- `opts.context?()` — session context merged into every execute frame's `args` (e.g. the active `threadId`); re-read per execute so it's always current. The user's typed `ExecuteRequest.args` rides alongside under `args.text`.
- `opts.executeTimeoutMs?` — ms before a pending execute resolves `{ok:false, reason:"unavailable"}`; default `15000`, `0` disables.
- `opts.newRequestId?` — request-id generator; default is an internal counter (deterministic, no crypto dep).

Routing follows the port contract: no catalog yet ⇒ `{ok:false, reason:"unavailable"}` (don't route); a `(kind,id)` the current catalog doesn't advertise ⇒ `{ok:false, reason:"unknown"}` with **no frame sent**; a transport `send` throw ⇒ `reason:"unavailable"`; a failed result ⇒ `reason:"backend-error"` carrying the backend message. Zero-dep, browser-safe; the conformance suite runs against it too.

### Conformance suite (`@luna/capabilities/testing`, firebreaked)

`describeProviderConformance(name, harness)` — the maintainability backbone ("add a backend = implement the port + pass this suite"). It imports vitest, so it is reachable **only** via the `./testing` subpath export, never from the main barrel (enforced by `test/no-vitest-in-barrel.test.ts`). The `ConformanceHarness` an adapter supplies: `makeProvider(seed)`, `executionsOf(provider)`, optional `refresh`, `makeUnavailable`, `dispose`. The suite asserts list validity + decode-at-boundary, subscribe async-emit / unsubscribe-stops / idempotency / multi-subscriber isolation, execute routing + unknown handling, totality (never rejects), and per-test instance isolation.

---

## Cycle 4 — the "command" kind (slash commands)

The generic, framework-free slash autocomplete + line-parse, lifted and generalized from
agent-cli (`apps/agent-cli/src/tui/slash.ts`) to operate on `CapabilityDescriptor` of
kind `"command"`. Behavior-locked to agent-cli's `slashState`/`slashComplete`.

**Lift boundary:** only the GENERIC layer moves here — parse / filter / complete. The
agent-cli-specific command TABLE and per-verb semantics (`parseSlashCommand`,
`SLASH_COMMANDS`, `/copy`/`/select`/`/local-shell` arg parsing, `HELP_TEXT`) stay in
agent-cli as its own `kind:"command"` capabilities. The package never knows a verb exists;
it owns the command-line *envelope*, the edge owns verb *meaning* (`ExecuteRequest.args`
is raw, parsed per-kind by the provider).

**Canonical prefix rule:** a command's `id` is stored WITHOUT a leading `/`. The `/` is a
presentation/transport detail of the typed input only — stripped on read, re-added exactly
once when emitting a completed input string. (This resolves the Phase-0 trap where
`slash-registry.ts` ids carried `/` but `tui/slash.ts` stripped it.)

```ts
parseCommandLine(input: string): { name: string; args: string } | null
filterCommands(input: string, commands: readonly CapabilityDescriptor[]): readonly CapabilityDescriptor[]
completeCommand(input: string, commands: readonly CapabilityDescriptor[]): string | null
```

- `parseCommandLine`: `"/copy 5"` → `{name:"copy", args:"5"}`; `"/"` → `{name:"",args:""}`; non-`/` or non-string → `null`. Multi-word args preserved verbatim; trailing whitespace trimmed.
- `filterCommands`: only `kind:"command"` descriptors whose `id` starts with the query (text after `/`); case-sensitive prefix (parity); a skill named like a command never appears; non-`/`/non-string → `[]`; frozen output; never throws.
- `completeCommand`: single match → `"/<id> "`; multiple → `"/<lcp>"` (only if longer than input, else `null`); no matches / not a command line → `null`; re-prepends exactly one `/`.

**Parity proof:** `test/command.test.ts` ports the cases from `apps/agent-cli/test/slash.test.ts` (filter/complete) + envelope-only cases from `chat/slash.test.ts` (parse), importing zero agent-cli code, plus new kind-exclusion cases that prove the generalization.

**First consumer - Moon slash menu:** the Moon frontend (`apps/ui-moon-tauri`) drives its
slash-command popover from `parseCommandLine` / `filterCommands` / `completeCommand`. The
static frontend can't import the workspace package, so `bun run bundle:capabilities` compiles
the zero-dep `src/index.ts` barrel into a committed browser IIFE
(`apps/ui-moon-tauri/frontend/vendor/capabilities.js`) that exposes `window.LunaCapabilities`;
the bundle build asserts the firebreak held (no `vitest`, no `node:` specifier reachable from
the barrel). Loading a vendored IIFE rather than importing the workspace dep sidesteps the
`bun install` quirk below.

The same menu also renders **backend-advertised commands**: when the server advertises the
`commands` capability (hello flag), the Moon frontend wraps its WS frame channel in
`createFrameCapabilityProvider`, decodes the inbound `capability-catalog` into its backend
catalog, and `mergeCapabilities([ui, backend])` so UI-owned (`executor:"client"`) and
server-executed (`executor:"server"`) commands share one popover — UI wins `(kind,id)`
collisions, and each backend row shows a `source` chip. Selecting a server command routes a
`capability-execute` frame back; selecting a client command runs the built-in handler. Every
hello clears the backend catalog first - a hello means a (re)connect or machine swap, so a
command-capable server re-populates it from the `capability-catalog` frame that follows, while
a server without the flag simply leaves it null. (Clearing only on the absent flag would let
server A's commands keep rendering after a swap to a different command-capable server B until
B's catalog arrives - or forever if it never does.)

**Deferred integration (separate slice):** re-pointing agent-cli to re-export these from
`@luna/capabilities` (add the `workspace:*` dep, convert `SLASH_COMMANDS` → bare-id
descriptors, delete the `App.tsx` `/`-strip). Deferred because agent-cli has no in-tree
re-export consumer yet and a fresh-worktree `bun install` has known quirks here; reuse is
proven by the parity test, not the import.
