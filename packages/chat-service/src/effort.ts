/**
 * Effort-level primitives + the per-model effort-validity matrix.
 *
 * This module is the server-side single source of truth for which effort
 * levels each model accepts. Two consumers, one matrix:
 *   - chat-server.ts (apps/ui-web) builds the hello frame's
 *     `availableModels[].efforts` from `effortsForModel` (re-exported there).
 *   - chat-service enforces the SAME matrix defensively: createThread →
 *     buildSessionOptions clamps before the SDK options are built, and
 *     setThreadConfig clamps against the thread's reference model before any
 *     live `applyFlagSettings` call. A stale or hand-rolled client sending an
 *     invalid combo (e.g. haiku+max) is clamped/rejected here — the wire
 *     value is never trusted.
 */

/** All valid effort level strings in ascending strength order. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const

/** The wire type for an effort level. */
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/**
 * Type-guard: returns true iff `v` is one of the five valid effort strings.
 * Use this before persisting or forwarding a wire value to the SDK.
 */
export const isEffort = (v: unknown): v is EffortLevel =>
  typeof v === "string" && (EFFORT_LEVELS as ReadonlyArray<string>).includes(v)

/**
 * Effort-validity matrix — returns the subset of effort levels valid for the
 * given model id. An empty array means the model takes no effort parameter.
 *
 * Pattern rules (lowest-specificity first):
 *   - Haiku → no effort (too fast; effort param is a no-op).
 *   - Fable / Opus 4.7 / Opus 4.8 → all five levels (maximum reasoning
 *     models; the SDK documents xhigh for Opus 4.7+ and max for Opus 4.6+).
 *   - Sonnet 4.6 → low/medium/high/max (no xhigh).
 *   - Everything else → no effort (safest default for unknown models).
 */
export const effortsForModel = (id: string): ReadonlyArray<EffortLevel> => {
  const m = id.toLowerCase()
  if (/haiku/.test(m)) return []
  if (/fable|opus-4-(7|8)|opus-4\.?[78]/.test(m)) return EFFORT_LEVELS
  if (/sonnet-4-6|sonnet-4\.?6/.test(m)) return ["low", "medium", "high", "max"]
  return []
}

/**
 * Clamp an effort value to what the given model actually supports.
 * Returns the effort unchanged when it is valid for the model, drops it when
 * the model takes no effort param (e.g. Haiku), and falls back to the highest
 * supported level when the exact level is unsupported.
 *
 * `dropped: true` means the caller should omit the effort field entirely.
 * An undefined modelId passes the effort through — no matrix data means no
 * opinion; the SDK's own silent per-model downgrade is the final backstop.
 */
export const clampEffort = (
  modelId: string | undefined,
  effort: EffortLevel | undefined,
): { effort?: EffortLevel; dropped: boolean } => {
  if (effort === undefined) return { dropped: false }
  if (modelId === undefined) return { effort, dropped: false }
  const supported = effortsForModel(modelId)
  if (supported.length === 0) return { dropped: true }
  if ((supported as ReadonlyArray<string>).includes(effort)) {
    return { effort, dropped: false }
  }
  // Unsupported level: fall back to highest supported
  return { effort: supported[supported.length - 1]!, dropped: false }
}

// ─── Ultracode ────────────────────────────────────────────────────────────────
//
// "ultracode" is the Agent SDK's most-powerful mode: xhigh effort PLUS standing
// dynamic-workflow orchestration (the model spawns multi-agent Workflow scripts
// on its own for substantive tasks). In the SDK it is NOT an effort level — it
// is a separate boolean on `Settings` (sdk.d.ts: `ultracode?: boolean`), gated
// on a workflows-enabled session and an xhigh-capable model.
//
// Luna surfaces it as the strongest entry of the effort dropdown, but it stays
// OUT of EFFORT_LEVELS / effortsForModel / clampEffort above: those feed
// `Options.effort` and `applyFlagSettings({ effortLevel })`, which accept only
// the five real levels. Leaking "ultracode" there would send an illegal effort
// to the SDK — and clampEffort's "fall back to the strongest supported" rule
// could even select it. So it is a SEPARATE menu/wire token the server demuxes
// into `Settings`; it is never an EffortLevel.

/** The dropdown/wire token for ultracode. Deliberately NOT an EffortLevel. */
export const ULTRACODE = "ultracode" as const
export type UltracodeToken = typeof ULTRACODE

/** What a client may SELECT in the effort dropdown: a real effort, or ultracode. */
export type EffortOption = EffortLevel | UltracodeToken

/** Type-guard for the ultracode token. */
export const isUltracode = (v: unknown): v is UltracodeToken => v === ULTRACODE

/**
 * Type-guard for ANY value a client may pick in the effort dropdown — a real
 * effort level OR the ultracode token. Use this (not isEffort) at the
 * persistence + recovery boundaries (thread-session-map read/write, subscribe
 * rebuild) so an ultracode selection survives a restart instead of being
 * silently dropped by the strict five-level isEffort guard.
 */
export const isEffortOption = (v: unknown): v is EffortOption =>
  isEffort(v) || isUltracode(v)

/**
 * Whether `id` can run ultracode. Ultracode requires an xhigh-capable model
 * (the SDK rejects it otherwise), so this is defined against the SAME matrix as
 * everything else: ultracode-capable ⟺ the model supports xhigh. Today that is
 * Fable 5 / Opus 4.7 / Opus 4.8.
 */
export const modelSupportsUltracode = (id: string): boolean =>
  (effortsForModel(id) as ReadonlyArray<string>).includes("xhigh")

/**
 * The ordered effort-dropdown options the hello frame advertises for `id`: the
 * real effort levels, plus ULTRACODE appended for xhigh-capable models. Empty
 * when the model takes no effort param (e.g. Haiku).
 *
 * This is the MENU list (display + wire) — distinct from effortsForModel(), the
 * clamp/Options.effort matrix. Ultracode is appended LAST (the strongest
 * option) rather than prepended, so it never becomes a `<select>`'s default
 * value (which falls back to options[0] when no effort is persisted). The UI
 * may still style it as the headline pick.
 */
export const effortOptionsForModel = (id: string): ReadonlyArray<EffortOption> => {
  const base = effortsForModel(id)
  return modelSupportsUltracode(id) ? [...base, ULTRACODE] : base
}

/**
 * The subset of SDK `Settings` keys ultracode toggles. Declared structurally so
 * this pure module need not import the SDK — both consumers
 * (`buildSessionOptions` → `sdkOptions.settings`, `setThreadConfig` →
 * `handle.applyFlagSettings(...)`) accept a partial `Settings`, and every key
 * here is a valid `Settings` key, so it flows by structural typing.
 */
// A `type` alias (not an `interface`): the SDK's applyFlagSettings takes a
// mapped `Partial<Settings>` that carries a string index signature, and an
// interface is not assignable to an index-signatured target (it gets no
// implicit index signature) whereas an object-literal type alias is.
export type UltracodeSettings = {
  readonly enableWorkflows: boolean
  readonly ultracode: boolean
  /** ultracode implies xhigh; pin it for robustness if you choose. */
  readonly effortLevel?: "low" | "medium" | "high" | "xhigh"
  /** SDK default is true (typing "ultracode" in any prompt opts that turn in). */
  readonly workflowKeywordTriggerEnabled?: boolean
}

/**
 * Demux a dropdown "ultracode" pick into the Agent SDK `Settings` partial that
 * turns the mode on. This is the KEYSTONE of the feature: the single point
 * where "the dropdown says ultracode" becomes "the SDK behaves as ultracode".
 *
 * SDK contract (sdk.d.ts → interface Settings):
 *   • enableWorkflows               — gates the Workflows feature
 *   • ultracode                     — xhigh effort + standing orchestration
 *   • effortLevel ('low'..'xhigh')  — ultracode implies 'xhigh'
 *   • workflowKeywordTriggerEnabled — "ultracode" keyword opt-in (SDK default true)
 *
 * NOTE: enabling the mode is necessary but not sufficient — the session must
 * also expose the `Workflow` built-in tool (added in buildSessionOptions). The
 * tool set is fixed at query construction and cannot be added by
 * applyFlagSettings, so a mid-thread switch enables the mode live but full
 * orchestration tooling lands on the next thread rebuild.
 *
 * Decisions baked in (chosen 2026-06-13):
 *   • enableWorkflows + ultracode — REQUIRED; together they ARE the mode
 *     (ultracode no-ops without workflows enabled).
 *   • effortLevel — left implicit; ultracode already drives xhigh today.
 *   • workflowKeywordTriggerEnabled: false — the effort dropdown is the
 *     deliberate, ONLY entry point. Otherwise the SDK default (true) lets the
 *     literal word "ultracode" in any chat message spin up a workflow fleet on
 *     a thread the operator never opted into — an unwanted cost/blast-radius
 *     path, especially given Luna's un-railed web egress + file read.
 */
export const ultracodeFlagSettings = (): UltracodeSettings => ({
  enableWorkflows: true,
  ultracode: true,
  workflowKeywordTriggerEnabled: false,
})
