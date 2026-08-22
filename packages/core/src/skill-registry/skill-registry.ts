/**
 * SkillRegistry — the managed catalog of skills Luna can know.
 *
 * DESIGN.md §4 places this in the Persistence layer alongside other
 * lightweight Refs (MCPRegistry, HookRegistry). Extended from the Phase 7
 * minimal store ({name, segment}) into the manifest model from the
 * Connectors/Skills/Widgets PRD:
 *
 *   - A skill is a SkillManifest: authored metadata (id, name, description,
 *     whenToUse, category, tags, source) + the prompt `body`.
 *   - Per-skill enabled/disabled state lives here (hydrated from the
 *     skill_preferences store at boot via `initialDisabled`; written through
 *     via `onToggle` — the registry itself stays SQLite-free so core purity
 *     and unit tests stay trivial).
 *   - Two disclosure modes (PRD §11): "inline" injects full bodies of
 *     enabled skills; "index" injects one line per enabled skill and defers
 *     bodies to the `skill_load` MCP tool.
 *
 * Synchronous snapshot: ThreadToolsProvider.decorate() is SYNCHRONOUS
 * (chat-service contract — it returns a value, cannot yield). The beliefs
 * section solves this with a holder + background refresh fiber; the
 * registry can do strictly better because it is the single writer of its
 * own state: `promptSnapshotSync()` reads a plain string cache that every
 * mutation rebuilds before it completes. The snapshot is therefore never
 * stale — a toggle is reflected in the very next thread.
 *
 * Core stays SDK-free at runtime (§4): this module imports nothing from
 * `@anthropic-ai/claude-agent-sdk`.
 */
import { Context, Effect, Layer, Ref } from "effect"
import { ValidationError } from "../errors.js"

export type SkillCategory =
  | "workflow"
  | "knowledge"
  | "writing"
  | "data"
  | "ops"
  | "other"

export type SkillSource = "builtin" | "user" | "installed"

/** PRD §11 — how enabled skills reach the system prompt. */
export type SkillDisclosure = "inline" | "index"

/**
 * A skill MANIFEST — authored metadata + payload.
 *
 *   - `description` powers settings search and the index line.
 *   - `whenToUse` is the disclosure hint surfaced to the agent.
 *   - `category` + `source` power settings filters.
 *   - `body` is the full prompt segment, disclosed per the registry's
 *     disclosure mode (inline now; via skill_load in index mode).
 */
export interface SkillManifest {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly whenToUse: string
  readonly category: SkillCategory
  readonly tags: ReadonlyArray<string>
  readonly source: SkillSource
  readonly body: string
}

/** A manifest plus its live enabled state — the settings-catalog row. */
export interface SkillCatalogEntry extends SkillManifest {
  readonly enabled: boolean
}

export interface SkillRegistryApi {
  /**
   * Register `manifest` under `manifest.id`. Fails with ValidationError if
   * the id is already registered (silent overwrite would mask two layers
   * claiming the same skill) or if required fields are blank.
   */
  readonly register: (
    manifest: SkillManifest,
  ) => Effect.Effect<void, ValidationError>

  /** Unregister. Returns true if removed, false if no such id. */
  readonly unregister: (id: string) => Effect.Effect<boolean>

  /**
   * Snapshot of every registered skill with its enabled state, in
   * registration order. Metadata-only consumers (the skill-catalog WS
   * frame) MUST strip `body` before the wire — bodies never go to clients.
   */
  readonly catalog: () => Effect.Effect<ReadonlyArray<SkillCatalogEntry>>

  /**
   * Toggle a skill. Unknown id → ValidationError. The optional `onToggle`
   * write-through (skill_preferences upsert) runs BEFORE the in-memory
   * flip, so a persistence defect leaves memory and disk consistent.
   */
  readonly setEnabled: (
    id: string,
    enabled: boolean,
  ) => Effect.Effect<void, ValidationError>

  /**
   * Full body of an ENABLED skill — the skill_load tool's read path.
   * Unknown id or disabled skill → ValidationError (disabled means the
   * operator said no; the tool must not leak the body anyway).
   */
  readonly body: (id: string) => Effect.Effect<string, ValidationError>

  /**
   * Bodies of ENABLED skills in registration order — feeds
   * `composeBasePrompt({ skillSegments })` for callers composing their own
   * prompt rather than using the rendered snapshot.
   */
  readonly listSegments: () => Effect.Effect<ReadonlyArray<string>>

  /**
   * Rendered "## Skills" prompt block for the registry's disclosure mode,
   * or "" when no skill is enabled. Synchronous and never stale (rebuilt
   * inside every mutation) — safe to call from decorate().
   */
  readonly promptSnapshotSync: () => string
}

export interface SkillRegistryOptions {
  /** PRD §11 disclosure mode. Default "inline" (the documented fallback
   *  until skill_load ships); chat-server flips to "index" with S4. */
  readonly disclosure?: SkillDisclosure
  /** Manifests registered at layer build (built-in seeds). A duplicate or
   *  invalid seed fails the layer — loud boot beats silent skill loss. */
  readonly seeds?: ReadonlyArray<SkillManifest>
  /** Skill ids hydrated as disabled (from the skill_preferences store).
   *  Unknown ids are ignored — a stale row must not fail boot. */
  readonly initialDisabled?: ReadonlyArray<string>
  /** Write-through hook invoked on every setEnabled BEFORE the in-memory
   *  flip. Infallible by signature; persistence failures are defects. */
  readonly onToggle?: (id: string, enabled: boolean) => Effect.Effect<void>
}

interface SkillState {
  readonly manifest: SkillManifest
  readonly enabled: boolean
}

const blank = (s: string): boolean => s.trim().length === 0

const invalid = (
  manifest: SkillManifest,
): ValidationError | null => {
  const required: ReadonlyArray<readonly [string, string]> = [
    ["id", manifest.id],
    ["name", manifest.name],
    ["description", manifest.description],
    ["whenToUse", manifest.whenToUse],
    ["body", manifest.body],
  ]
  for (const [field, value] of required) {
    if (blank(value)) {
      return new ValidationError({
        module: "SkillRegistry",
        field,
        message: `skill manifest has blank required field "${field}"`,
      })
    }
  }
  return null
}

/**
 * Render the prompt block for the enabled subset. Exported for tests —
 * rendering is the load-bearing guarantee ("a disabled skill's text never
 * enters context") so it gets direct coverage.
 */
export const renderSkillsPrompt = (
  entries: ReadonlyArray<SkillCatalogEntry>,
  mode: SkillDisclosure,
): string => {
  const enabled = entries.filter((e) => e.enabled)
  if (enabled.length === 0) return ""
  if (mode === "index") {
    return [
      "## Skills",
      "You have the following skills. When a task matches a skill's purpose, load its full instructions with the `mcp__skill_tools__skill_load` tool (pass the skill id) before proceeding. Do not guess at a skill's contents.",
      ...enabled.map(
        (e) => `- ${e.id} — ${e.description} Use when: ${e.whenToUse}`,
      ),
    ].join("\n")
  }
  return [
    "## Skills",
    ...enabled.map(
      (e) =>
        `### Skill: ${e.name} (${e.id})\nUse when: ${e.whenToUse}\n\n${e.body}`,
    ),
  ].join("\n\n")
}

const toCatalog = (
  m: ReadonlyMap<string, SkillState>,
): ReadonlyArray<SkillCatalogEntry> => {
  const out: SkillCatalogEntry[] = []
  for (const [, s] of m) out.push({ ...s.manifest, enabled: s.enabled })
  return out
}

const make = (
  options: SkillRegistryOptions = {},
): Effect.Effect<SkillRegistryApi, ValidationError> =>
  Effect.gen(function* () {
    const mode: SkillDisclosure = options.disclosure ?? "inline"
    // LIVE disabled-set, not a boot snapshot: setEnabled keeps it current so
    // a skill that is unregistered and re-registered later in the process
    // (the user-skills hot-load resyncs on file edits) re-enters with its
    // CURRENT toggled state, not its boot-time state. Keeps memory and the
    // skill_preferences store agreeing without a restart.
    const disabledSeed = new Set(options.initialDisabled ?? [])

    const initial = new Map<string, SkillState>()
    for (const seed of options.seeds ?? []) {
      const bad = invalid(seed)
      if (bad !== null) return yield* Effect.fail(bad)
      if (initial.has(seed.id)) {
        return yield* Effect.fail(
          new ValidationError({
            module: "SkillRegistry",
            field: "id",
            message: `duplicate seed skill id "${seed.id}"`,
          }),
        )
      }
      initial.set(seed.id, {
        manifest: seed,
        enabled: !disabledSeed.has(seed.id),
      })
    }

    const ref = yield* Ref.make<ReadonlyMap<string, SkillState>>(initial)

    // The never-stale sync mirror. JS is single-threaded: rebuilding right
    // after each Ref mutation (within the same Effect) cannot tear.
    let snapshot = renderSkillsPrompt(toCatalog(initial), mode)
    const rebuild = (m: ReadonlyMap<string, SkillState>): void => {
      snapshot = renderSkillsPrompt(toCatalog(m), mode)
    }

    const register: SkillRegistryApi["register"] = (manifest) =>
      Effect.gen(function* () {
        const bad = invalid(manifest)
        if (bad !== null) return yield* Effect.fail(bad)
        const cur = yield* Ref.get(ref)
        if (cur.has(manifest.id)) {
          return yield* Effect.fail(
            new ValidationError({
              module: "SkillRegistry",
              field: "id",
              message: `skill "${manifest.id}" already registered`,
            }),
          )
        }
        const next = new Map(cur)
        next.set(manifest.id, {
          manifest,
          enabled: !disabledSeed.has(manifest.id),
        })
        yield* Ref.set(ref, next)
        rebuild(next)
      })

    const unregister: SkillRegistryApi["unregister"] = (id) =>
      Ref.modify(ref, (m): readonly [boolean, ReadonlyMap<string, SkillState>] => {
        if (!m.has(id)) return [false, m] as const
        const next = new Map(m)
        next.delete(id)
        return [true, next] as const
      }).pipe(
        Effect.tap((removed) =>
          removed
            ? Ref.get(ref).pipe(Effect.map(rebuild))
            : Effect.void,
        ),
      )

    const catalog: SkillRegistryApi["catalog"] = () =>
      Ref.get(ref).pipe(Effect.map(toCatalog))

    const setEnabled: SkillRegistryApi["setEnabled"] = (id, enabled) =>
      Effect.gen(function* () {
        const cur = yield* Ref.get(ref)
        const state = cur.get(id)
        if (state === undefined) {
          return yield* Effect.fail(
            new ValidationError({
              module: "SkillRegistry",
              field: "id",
              message: `cannot toggle unknown skill "${id}"`,
            }),
          )
        }
        if (state.enabled === enabled) return // idempotent no-op, skip write-through
        // Persist FIRST: if the write-through dies, memory never flipped
        // and a restart reads a consistent picture.
        if (options.onToggle !== undefined) {
          yield* options.onToggle(id, enabled)
        }
        // Keep the live disabled-set current (see its declaration comment).
        if (enabled) disabledSeed.delete(id)
        else disabledSeed.add(id)
        const next = new Map(cur)
        next.set(id, { manifest: state.manifest, enabled })
        yield* Ref.set(ref, next)
        rebuild(next)
      })

    const body: SkillRegistryApi["body"] = (id) =>
      Effect.gen(function* () {
        const cur = yield* Ref.get(ref)
        const state = cur.get(id)
        if (state === undefined) {
          return yield* Effect.fail(
            new ValidationError({
              module: "SkillRegistry",
              field: "id",
              message: `unknown skill "${id}"`,
            }),
          )
        }
        if (!state.enabled) {
          return yield* Effect.fail(
            new ValidationError({
              module: "SkillRegistry",
              field: "id",
              message: `skill "${id}" is disabled`,
            }),
          )
        }
        return state.manifest.body
      })

    const listSegments: SkillRegistryApi["listSegments"] = () =>
      Ref.get(ref).pipe(
        Effect.map((m) => {
          const out: string[] = []
          for (const [, s] of m) if (s.enabled) out.push(s.manifest.body)
          return out
        }),
      )

    return {
      register,
      unregister,
      catalog,
      setEnabled,
      body,
      listSegments,
      promptSnapshotSync: () => snapshot,
    } satisfies SkillRegistryApi
  })

export class SkillRegistry extends Context.Service<SkillRegistry, SkillRegistryApi>()("luna/SkillRegistry") {
  /** Configurable layer — seeds, disclosure mode, hydration, write-through. */
  static readonly layer = (
    options: SkillRegistryOptions = {},
  ): Layer.Layer<SkillRegistry, ValidationError> =>
    Layer.effect(SkillRegistry, make(options))

  /** Empty in-memory registry, inline disclosure — the test default. */
  static readonly Default: Layer.Layer<SkillRegistry, ValidationError> =
    SkillRegistry.layer()
}

/**
 * Convenience: register within a caller's Scope. The registration is
 * automatically reversed when the Scope closes. Honors §3.4 #4
 * (interruption propagates top-down via Scope finalizers).
 */
export const registerScoped = (
  manifest: SkillManifest,
): Effect.Effect<
  void,
  ValidationError,
  SkillRegistry | import("effect/Scope").Scope
> =>
  Effect.gen(function* () {
    const reg = yield* SkillRegistry
    yield* reg.register(manifest)
    yield* Effect.addFinalizer(() =>
      reg.unregister(manifest.id).pipe(Effect.catch(() => Effect.void)),
    )
  })
