# Luna — Architecture

> _(formerly "experiment-agent"; renamed across the workspace 2026-04-26. Repo dir is `~/Projects/luna`, npm scope is `@luna/*`, user data lives at `~/.luna/`.)_

> A modular agent framework with full Claude Agent SDK feature parity, built on **Effect (TypeScript v3)**, extending the SDK with Teams (experimental→first-class), durable Workflows, a Training Center, plug-and-play Memory, Account Rotation, Screen Capture, and a Plugin-Play Gateway.

**Status**: Architecture frozen · Implementation in progress
**Created**: 2026-04-24 · **Advisor-reviewed**: 2026-04-24 (verdict: ⚠️ MODIFY — incorporated)

---

## Document Contract

This document has two kinds of content, treated differently:

```
FROZEN (changes require re-architecture)    │ REVISABLE (can evolve per phase)
────────────────────────────────────────────┼─────────────────────────────────────
§0 Substrate decisions                      │ §7 Per-module Service signatures
§1 Goals & principles                       │ §8 Testing strategy details
§2 Module list (what exists)                │ §9 UI design
§3 Concurrency & lifetime model             │ §10 Per-backend memory schemas
§4 Service topology (deps graph)            │ §11 Third-party gateway details
§5 Persistence schema (durable state)       │ §14 Training Labs internals
§6 Error taxonomy                           │
§12 SDK adapter contract                    │
§13 Parity acceptance (falsifiable)         │
§15 Milestones + checkpoint gates           │
```

Frozen sections are the contract between architecture and implementation. Revisable sections are guidance that executes amend as real backends / real usage shape them.

---

## §0. Substrate Decisions

Three decisions that drive everything downstream. Dated, with rationale.

### 0.1 Effect version — **v3 stable (pinned `^3.21`)** — verified 2026-04-24
- **Chosen**: Effect v3 stable.
- **Rejected**: Effect v4 beta.
- **Verified evidence (npm registry, 2026-04-24)**:
  ```
  Package                      │ v4 beta on npm?    │ Latest
  ─────────────────────────────┼────────────────────┼───────────────
  effect                       │ ✅ 4.0.0-beta.57   │ (57 betas/3wk)
  @effect/sql-sqlite-bun       │ ✅ 4.0.0-beta.57   │
  @effect/opentelemetry        │ ✅ 4.0.0-beta.57   │
  @effect/workflow             │ ❌ v3 only         │ 0.18.1
  @effect/cluster              │ ❌ v3 only         │ 0.58.2
  effect/Schema (bundled)      │ ✅ v3 ≥3.10 native │ n/a
  ```
- **Rationale**: Two flagship packages we require (`@effect/workflow`, `@effect/cluster`) are not yet v4-published. Schema is bundled into `effect` itself as `effect/Schema` in v3 — no separate package needed. Mixing v4 core with v3 ecosystem is unsupported. 57 betas in ~3 weeks indicates active API churn incompatible with a days-long build. Staying on v3 stable until those packages publish v4 betas.
- **v4 migration**: remains scheduled at M5.
- **Consequence**: Uses `Effect.Service<Self>()(...)` pattern, `Context.Tag`, Schema v3 variadic signatures. When all three blocking packages publish v4 betas, migration is scheduled with automated codemods per the [Effect v4 migration guide](https://github.com/Effect-TS/effect-smol/blob/main/MIGRATION.md).

### 0.2 Account Rotation — **Per-query model rotation via SDK env overlay** — verified 2026-04-24
- **Chosen**: Dual-mode `AccountBroker`:
  - `acquireSession()` — rotates the Anthropic OAuth subscription token per `query()` call via SDK's `options.env.CLAUDE_CODE_OAUTH_TOKEN`. Per-query granularity, no subprocess respawn needed.
  - `acquireTool(name)` — rotates credentials for MCP servers + custom tools we own. Per-invocation, transparent wrap.
- **Observed behaviour**: the Claude Agent SDK respects `options.env` overlays per-query; the subprocess honors the injected token without restart. Our earlier concern ("subprocess owns HTTP, can't rotate without respawn") was wrong in practice.
- **Consequence**: `AccountBroker` is truly transparent. Rotation strategies (round-robin, LRU, least-used-with-429-awareness) specified in §9.3. Sticky-pin on session resume (`boundAccountId`) preserves prompt-cache warmth.
- **Token type**: OAuth subscription tokens (1-year TTL, from `claude setup-token`), not API keys. Pool stored at `~/.luna/accounts.db` (SQLite per §5.1) via `SecretProvider`, never as plaintext env vars.

### 0.3 "One-shot" reinterpretation — **Frozen architecture + revisable implementation + named checkpoints**
- **Chosen**: One architecture doc freezes decisions in §0–§6, §12, §13, §15. Implementation specifics (§7–§11, §14) revise as real code informs them. Two explicit **architecture re-evaluate checkpoints** at M1 and M3.
- **Rejected**: Single blind push, no checkpoints.
- **Rationale**: Advisor correctly flagged that doc rots faster than code on a moving substrate. Checkpoints at M1 (adapter holds?) and M3 (concurrency holds?) catch mis-designs before they propagate.
- **Consequence**: §15 milestones include explicit "🔍 Architecture Checkpoint" gates that block progression.

---

## §1. Goals & Principles

- **Modular from day one** — every capability is a swappable module wired at the edges via Effect `Layer`s.
- **Effect-first** — all async, concurrency, error handling, DI, and scheduling flow through `Effect<A, E, R>`. No raw Promises in module boundaries.
- **Observable by construction** — every module emits structured events; traces span module boundaries via `@effect/opentelemetry`.
- **Testable in isolation** — each module exposes a pure Service interface; test doubles via Layer swaps.
- **SDK-compatible, not SDK-replacement** — wraps the Anthropic Claude Agent SDK; never forks it.
- **Verify before acting** — every external claim in this doc has a citation; every design choice has a named rationale.

---

## §2. Module List (frozen inventory)

Two planes: **Feature Modules** (capabilities) and **Runtime Systems** (cross-cutting infrastructure).

### 2.1 Feature Modules
```
#     │ Module                 │ One-line purpose
──────┼────────────────────────┼────────────────────────────────────────────────
2.1.1 │ MCP Tool List          │ Registry of MCP servers; per-tool scoping/auth
2.1.2 │ Jobs & Schedule        │ Cron + one-shot + file-watch triggers; durable
2.1.3 │ Option Configurations  │ Per-agent/session option packs (model/effort/…)
2.1.4 │ Override Tools         │ Intercept/wrap tool calls (mock, redact, policy)
2.1.5 │ Base Prompt            │ Composable system prompt fragments
2.1.6 │ Agents (subagents)     │ Full AgentDefinition parity; parallel spawn
2.1.7 │ Teams                  │ Out-of-process peer workers; long-lived lead
2.1.8 │ Trigger Agents         │ Event-driven agents bound to Streams
2.1.9 │ Skills + Scripts       │ Markdown skills + sandboxed scripts
2.1.10│ Labs / Dojo            │ Training Center: scientist loop over artifacts
2.1.11│ Training Harness       │ Execution substrate for Labs + ad-hoc evals
2.1.12│ Gateway                │ Discord/Telegram/CLI/HTTP + Plugin Play
2.1.13│ Screen Capture         │ Visual context pipeline with redaction
```

### 2.2 Runtime Systems
```
#     │ System                 │ One-line purpose
──────┼────────────────────────┼────────────────────────────────────────────────
2.2.1 │ Memory                 │ Plug-and-play backends (sqlite/file/vector/…)
2.2.2 │ Hooks                  │ All 19 SDK hook events + matchers + decisions
2.2.3 │ Configuration          │ Typed config via effect/Schema, layered sources
2.2.4 │ Sandbox                │ Isolated execution for untrusted scripts/skills
2.2.5 │ Workflows              │ @effect/workflow + @effect/cluster wrapper
2.2.6 │ UI                     │ Tauri+SolidJS; consumes observability stream
2.2.7 │ Observability          │ Structured events + OTEL traces
2.2.8 │ Telemetry              │ Metrics/logs to DuckDB + OTLP
2.2.9 │ Network Security       │ Mediated HTTP, egress allowlists, TLS pinning
2.2.10│ Account Rotation       │ Credential pool + policy (narrowed per §0.2)
2.2.11│ Secrets                │ SecretProvider (1Password, env, file)
2.2.12│ Cost Accounting        │ $-per-session/team/workflow; Labs budget gov
2.2.13│ Schema Evolution       │ Versioned migrations for durable state
```

#### 2.2.11 Secrets — token resolution chain (Phase 25d)

The `secret_ref` column on `accounts` (§5.1) is a string pointer the
SecretProvider chain resolves at session-acquire time. Phase 25d locks
the grammar; earlier "iterate every OP token until one resolves"
phrasing from 25c is **superseded** by explicit per-ref account
routing.

**Ref grammar:**

```
op://<vault>/<item>/[section/]<field>
  Canonical 1Password syntax (verified against developer.1password.com).
  Valid ONLY when exactly ONE OP service-account is registered with
  the routed wrapper. With ≥2 OP accounts, op:// is rejected with a
  ConfigError directing the operator to use luna-op://<label>/...
  With 0 OP accounts, op:// is also rejected.

luna-op://<account-label>/<vault>/<item>/[section/]<field>
  Luna-specific explicit-routing form. <account-label> matches a
  registered OP service-account by its keychain label. Resolution is
  bound to that single account — NO fall-through to other accounts.
  Unknown label → ConfigError naming the unknown label and listing the
  registered set.

env:<VARNAME>
  Reads from process env. Single colon, no slashes (RFC-style URI
  scheme without authority). NB: `env://VAR` is REJECTED by the CLI
  validator — it would never resolve at runtime.

file:<absolute-path>  |  file:///<absolute-path>
  Reads from local file. Same semantics as Phase 9.
```

**Account-label format (mandatory for `luna-op://`):**

```
^[a-z][a-z0-9-]{0,30}$
Reserved labels (rejected): env, file, op
```

No URL-decoding is performed on any path segment. Splitting is on
literal `/`.

**Routing dispatcher (`RoutedOpSecretProvider`):**

Wraps N single-account `OnePasswordSecretProvider` layers, each
registered by `accountLabel`. On `luna-op://`, dispatches to the
matching layer ONLY. On `op://`, allowed iff exactly one OP layer is
registered (otherwise the dispatcher returns a guidance ConfigError).
The dispatcher rewrites `luna-op://<label>/<rest>` to `op://<rest>`
before handing it to the inner backend, which remains a pure
1Password reader. Refs that begin with neither prefix surface as a
"miss" ConfigError so `secretProviderFirstOf` can fall through.

**Error wrapping:**

Failures from a `luna-op://<label>/...` resolution are wrapped via
`Effect.mapError` to prepend `"(account=<label>) "` to the message.
Tokens never appear in any error message.

**Boot-time dangling refs:**

A helper `validateAccountsTableLabels(refs, registeredLabels)` returns
the list of refs pointing at unknown labels. The composition site
(chat-server) calls it after broker hydration and logs a WARN
line when the count is >0. Dangling refs are NOT a hard-fail — an
operator may add accounts later without rebooting.

---

## §3. Concurrency & Lifetime Model (frozen)

> The advisor flagged that Teams, Workflows, and iterable-prompt all claim session-lifetime ownership. This section resolves that contradiction with one authoritative rule set.

### 3.1 Authoritative owner: `Layer.scoped` at the Session boundary

Every session opens a `Scope` that owns:
- The SDK's async-iterable input stream (kept open until Scope closes).
- All **attached** Fibers: teammate supervisors, trigger listeners, screen-capture loops, hook executors.
- Any **attached** workflow handles.

When the Scope closes (explicit `Session.close()` or Scope expiry), every owned resource is finalized in reverse order.

### 3.2 Detached resources (outlive sessions) — durable state only

A Fiber or Workflow may outlive the session that created it **only if** it is explicitly **detached** via `Runtime.runFork` at the root runtime (not the session's runtime). Detached resources:
- Cannot hold references to the session's Scope.
- Communicate back via **durable state only** — `SessionStore`, `TaskList`, `WorkflowState` — never via Effect references.
- Must persist their own state for recovery on process restart.

### 3.3 The three claimants — resolved
```
Claimant            │ Default scope              │ Detached variant
────────────────────┼────────────────────────────┼──────────────────────────
Iterable prompt     │ Session Scope              │ n/a (always session-scoped)
Teammate supervisor │ Session Scope (lead's)     │ Detach if "daemon team"
                    │                            │ — communicates via TaskList
Workflow handle     │ Session Scope (short runs) │ Detach for long runs
                    │                            │ — communicates via
                    │                            │ WorkflowState durable store
```

### 3.4 Hard rules (executor MUST follow)
1. **No cross-Scope Fiber references.** Code in Scope A never holds a `Fiber.Runtime` from Scope B. Violations = unhandled interruption + deadlocks.
2. **All cross-session communication = durable state.** `SessionStore.write` → other session polls/subscribes.
3. **Supervisor Fibers are named.** Every long-lived Fiber is registered with a string name + owning Scope ID for observability.
4. **Interruption propagates top-down.** Closing a Scope interrupts children; children finalize before parent returns.
5. **Timeouts required on external I/O.** All SDK calls wrapped in `Effect.timeout`. No indefinite hangs.

### 3.5 Reference implementation sketch
```ts
export const openSession = (opts: SessionOptions) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const mailbox = yield* Queue.unbounded<SDKUserMessage>()
    const input = Stream.fromQueue(mailbox)
    const output = yield* sdkAdapter.query(input, opts)

    // All attached Fibers are forked into `scope`, not the ambient runtime.
    yield* Effect.forkIn(scope)(teammateSupervisor(opts.team))
    yield* Effect.forkIn(scope)(hookExecutor(opts.hooks))

    return {
      send: (m: SDKUserMessage) => Queue.offer(mailbox, m),
      replies: output,
      close: Scope.close(scope, Exit.void),
    }
  }).pipe(Effect.scoped)
```

---

## §4. Service Topology (frozen — dependency graph)

Every module is an Effect `Service`. This is the authoritative dependency order (compose in this direction; reverse = cycle).

```
┌──────────────────────────────────────────────────────────────────────┐
│                         BOOT LAYER (no deps)                         │
│  ConfigService · Logger · Tracer · Metrics · Clock                   │
└──────────────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│                       FOUNDATION LAYER                               │
│  SqlClient (@effect/sql) · SecretProvider · NetSecClient · Schema    │
└──────────────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│                       PERSISTENCE LAYER                              │
│  SessionStore · MemoryRouter · WorkflowState · TaskList              │
│  HookRegistry · SkillRegistry · MCPRegistry · AccountBroker          │
└──────────────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│                       SDK ADAPTER LAYER                              │
│  SDKAdapter (wraps @anthropic-ai/claude-agent-sdk)                   │
│  Stream↔AsyncIterable bridge · PermissionEvaluator                   │
└──────────────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│                       RUNTIME LAYER                                  │
│  SessionService · AgentRuntime · TeamBroker · WorkflowRuntime        │
│  ScheduleService · TriggerService · SandboxRuntime · ScreenCapture   │
└──────────────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│                       FEATURE LAYER                                  │
│  LabsService · TrainingHarness · GatewayService · UIService          │
│  CostAccountingService                                               │
└──────────────────────────────────────────────────────────────────────┘
```

**Rules:**
- A service may only depend on services in its layer or below.
- Cross-layer upward dependencies = cycles; use events/queues instead.
- Each layer is a single composable `Layer` (e.g., `PersistenceLayer = Layer.mergeAll(…)`).
- Test doubles swap at any layer boundary.

---

## §5. Persistence Schema (frozen — SQLite baseline)

All durable state lives in SQLite by default (`@effect/sql-sqlite-bun`). Postgres adapter later. Schemas evolve via §6.x migrations.

### 5.1 Core tables
```sql
-- Sessions (matches SDK session model + our additions)
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  parent_id     TEXT,                        -- fork source
  title         TEXT,
  tags          TEXT,                        -- JSON array
  created_at    INTEGER NOT NULL,            -- epoch ms
  ended_at      INTEGER,
  model         TEXT NOT NULL,
  options_json  TEXT NOT NULL,               -- full Options snapshot
  status        TEXT NOT NULL                -- active|idle|closed|errored
);

-- Every inbound+outbound message (our own record, not trusting SDK transcript)
CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  parent_id     TEXT,                        -- parent_tool_use_id when applicable
  kind          TEXT NOT NULL,               -- user|assistant|system|result|partial
  role          TEXT,
  content_json  TEXT NOT NULL,               -- blocks array
  ts            INTEGER NOT NULL,
  seq           INTEGER NOT NULL             -- monotonic within session
);
CREATE INDEX idx_messages_session_seq ON messages(session_id, seq);

-- Teams: config + membership (file-locked in SDK; mirrored here for resumption)
CREATE TABLE teams (
  name            TEXT PRIMARY KEY,
  lead_session_id TEXT NOT NULL REFERENCES sessions(id),
  created_at      INTEGER NOT NULL,
  dissolved_at    INTEGER,
  config_json     TEXT NOT NULL
);
CREATE TABLE teammates (
  team_name       TEXT NOT NULL REFERENCES teams(name),
  name            TEXT NOT NULL,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  status          TEXT NOT NULL,             -- active|idle|stopped|errored
  started_at      INTEGER NOT NULL,
  PRIMARY KEY (team_name, name)
);

-- Tasks (team-scoped; file-locked in SDK, authoritative here)
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  team_name     TEXT NOT NULL REFERENCES teams(name),
  subject       TEXT NOT NULL,
  description   TEXT,
  assignee      TEXT,                        -- teammate name
  status        TEXT NOT NULL,               -- created|claimed|in_progress|completed|blocked
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  depends_on    TEXT                         -- JSON array of task ids
);

-- Workflows (@effect/workflow state mirror for observability + recovery)
CREATE TABLE workflows (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,               -- workflow name
  session_id    TEXT,                        -- null if detached
  state         TEXT NOT NULL,               -- pending|running|suspended|completed|errored|compensated
  checkpoint    TEXT NOT NULL,               -- serialized state
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE workflow_events (               -- ordered event log for replay
  workflow_id   TEXT NOT NULL REFERENCES workflows(id),
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, seq)
);

-- Memory (one of many backends; this is the default sqlite backend)
CREATE TABLE memory_keyed (
  k             TEXT PRIMARY KEY,
  v             TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  tags          TEXT                         -- JSON
);
CREATE TABLE memory_vectors (                -- when vector backend enabled
  id            TEXT PRIMARY KEY,
  embedding     BLOB NOT NULL,
  text          TEXT NOT NULL,
  meta_json     TEXT,
  ts            INTEGER NOT NULL
);

-- Jobs & Schedule  (IMPLEMENTED Phase 12a — packages/core/src/jobs/jobs-store.ts;
--                   SchedulerToolsLayer boot-reload re-registers every row
--                   so cron schedules survive chat-server restarts)
CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,               -- cron|oneshot|file-watch  (cron only in v1)
  spec          TEXT NOT NULL,
  next_run      INTEGER,
  last_run      INTEGER,
  last_status   TEXT,
  payload_json  TEXT NOT NULL
  -- Shipped impl adds `created_at` + `updated_at` (additive per §10.3).
);

-- Account Rotation
CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  kind          TEXT NOT NULL,               -- anthropic|mcp-*|tool-*
  secret_ref    TEXT NOT NULL,               -- pointer to SecretProvider
  health        TEXT NOT NULL,               -- healthy|rate_limited|budget_exhausted|errored
  cooldown_ms   INTEGER,
  usage_json    TEXT NOT NULL                -- tokens/$ tracking
);

-- Cost Accounting (rolled up from observability events)
CREATE TABLE cost_events (
  id            TEXT PRIMARY KEY,
  session_id    TEXT,
  team_name     TEXT,
  workflow_id   TEXT,
  account_id    TEXT REFERENCES accounts(id),
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  cache_read    INTEGER NOT NULL DEFAULT 0,
  cache_write   INTEGER NOT NULL DEFAULT 0,
  usd           REAL NOT NULL DEFAULT 0,
  ts            INTEGER NOT NULL
);

-- Schema versioning (§6.x migrations)
CREATE TABLE schema_versions (
  component     TEXT NOT NULL,
  version       INTEGER NOT NULL,
  applied_at    INTEGER NOT NULL,
  PRIMARY KEY (component, version)
);
```

### 5.2 Migration policy
- Every schema change = a new migration file `packages/core/migrations/<component>-<version>.sql`.
- `@effect/sql` runs pending migrations at boot, gated by `schema_versions`.
- Breaking changes get a paired upgrade script + observability event.

---

### 5.3 Scheduler V2 — global ticker + DB-as-queue + worker registry (Phase 12b, revisable)

Background: §5.1 reserves a `jobs` table and ships a working durable cron
registry (`packages/scheduler-tools` boot-reload), but the trigger model is
**one fiber per cron** (TriggerAgent's `sleep until Cron.next(expr)` loop).
The `next_run` / `last_run` / `last_status` columns from §5.1 are declared
but never written. There is no per-fire history. New persisted crons fire
with `Effect.succeed("${label} tick")` — a no-op — because `schedule_create`
has no way to express "what should this job DO."

Phase 12b replaces the fiber-per-cron model with an **Oban-style global
ticker that polls the `jobs` table once per minute, claims due rows, and
dispatches them to a worker registry keyed by job kind.** Two first-class
job kinds ship in V1:

- **`prompt`** — spawn `query()` with a system+user prompt + tools; capture
  the final assistant text; deliver to a configurable sink (`obs_note`,
  chat thread, file, etc.). Use-case: "every morning give me a daily brief."

- **`workflow`** — run an explicit Effect sequence of typed steps (`shell` /
  `gh` / `prompt` / …) with per-step durable status. Use-case: full release
  pipeline (dev → master → tag → restart both servers).

Both are implementations of the same `Worker = (payload) => Effect.Effect<R,E,A>`
contract; the kind discriminant only selects which worker the registry hands
the payload to.

#### 5.3.1 Schema (additive per §5.2)

```sql
-- Extend §5.1 jobs (purely additive; existing rows continue to work).
ALTER TABLE jobs ADD COLUMN schedule         TEXT;            -- cron expr; NULL for oneshot
ALTER TABLE jobs ADD COLUMN enabled          INTEGER NOT NULL DEFAULT 1;
ALTER TABLE jobs ADD COLUMN next_run_at      INTEGER;          -- replaces opportunistic `next_run`
-- The §5.1 `spec` column is RETAINED for backward compat; new code reads `schedule` first,
-- falls back to `spec` for unmigrated rows.

-- Per-fire ledger (new).
CREATE TABLE job_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       TEXT    NOT NULL REFERENCES jobs(id),
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  status       TEXT    NOT NULL,    -- 'queued' | 'running' | 'success' | 'failed' | 'cancelled'
  attempt      INTEGER NOT NULL DEFAULT 1,
  output_text  TEXT,
  error        TEXT,
  steps_json   TEXT                  -- per-step status for kind='workflow'
);
CREATE INDEX job_runs_job_started_idx ON job_runs(job_id, started_at DESC);
CREATE INDEX job_runs_status_started_idx ON job_runs(status, started_at DESC);
```

Migration is gated by a new `schema_versions` row `('jobs', 2)`. Old rows
keep working: a row with `schedule IS NULL AND spec IS NOT NULL` is treated
as legacy and migrated to `schedule = spec` on first tick.

#### 5.3.2 JobTicker — semantics

A single supervised fiber, scoped to the chat-server's Layer scope:

```
Effect.repeat(
  drainDueJobs(),
  Schedule.fixed(Duration.seconds(60)),
)
```

`drainDueJobs()`:

1. Compute `now`.
2. `SELECT id, kind, payload_json, schedule, last_run_at FROM jobs
    WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)`
3. For each row, recompute `next_run_at = Cron.next(schedule, lastRunAt ?? now)`.
4. **Atomic claim** (single UPDATE; SQLite gives us the row-level lock via
   the transaction):
   ```sql
   UPDATE jobs SET last_run_at = ?, last_status = 'running',
                   next_run_at = ?
                WHERE id = ?
                  AND (last_run_at IS NULL OR last_run_at < ?)  -- watchdog: drop stragglers older than this tick boundary
   ```
   If the UPDATE reports 0 rows changed, another ticker already claimed it
   (shouldn't happen single-process today; we'll harden when we add
   distributed coordination in Phase 13).
5. INSERT a `job_runs` row with `status='running'`.
6. Submit a `JobSpec` to the existing `JobScheduler` (we KEEP the
   supervised pool — it's the right primitive for bounded worker
   parallelism). The spec's `run` is the result of
   `WorkerRegistry.dispatch(kind, payload)`.
7. On `Exit`, UPDATE the matching `job_runs` row with `finished_at`,
   `status`, `output_text`/`error`, and `steps_json`.

The drain is bounded per tick by `JobScheduler` capacity (default 32); excess
due rows roll into the next tick. A job that runs longer than 60 s does not
block subsequent ticks — only its OWN re-fire (the row's `next_run_at` won't
be `≤ now` while the previous attempt is still in flight, since the claim
already advanced it).

#### 5.3.3 WorkerRegistry contract

```ts
export interface Worker<R = never> {
  readonly kind: string                    // 'prompt' | 'workflow' | …
  readonly run: (payload: unknown, ctx: WorkerContext) => Effect.Effect<WorkerResult, WorkerError, R>
}

export interface WorkerContext {
  readonly jobId: string
  readonly runId: number
  readonly attempt: number
  readonly deadline: Date                  // 60s wall-clock budget by default
}

export interface WorkerResult {
  readonly outputText: string | null
  readonly stepsJson?: string              // workflow only
}
```

Workers register at boot time via Layer composition:

```ts
const workersL = Layer.mergeAll(
  PromptWorker.Layer({ sdkClientL, deliveryStoresL }),
  WorkflowWorker.Layer({ stepRunnersL }),
  // future: ShellWorker, HttpWorker, BeliefSweepWorker, …
)
```

`WorkerRegistry.dispatch(kind, payload)` looks up the registered worker;
unknown kinds fail with `WorkerError({ tag: 'unknown_kind', kind })` which
propagates to the `job_runs` row.

#### 5.3.4 Payload shapes (V1)

```jsonc
// kind='prompt'
{
  "system_prompt": "You are Luna's morning brief generator. …",
  "user_prompt":   "Generate today's brief.",
  "model":         "claude-sonnet-4-5",
  "allowed_tools": ["mcp__memory__memory_search", "mcp__observability__obs_notes_recent"],
  "deliver_to": {
    "kind": "obs_note",         // 'obs_note' | 'chat_thread' | 'file' | …
    "kind_tag": "daily_brief"
  }
}

// kind='workflow'
{
  "steps": [
    { "kind": "shell",  "cmd": "git fetch origin && git rev-parse origin/dev" },
    { "kind": "gh",     "op":  "pr-list",  "args": { "state": "open", "label": "auto-promote" } },
    { "kind": "prompt", "system": "You are the release gatekeeper. …",
                        "user":   "Verify the dev branch is safe to promote." },
    { "kind": "shell",  "cmd": "git push origin dev:master" },
    { "kind": "shell",  "cmd": "systemctl restart luna-chat-server" }
  ],
  "halt_on_failure": true
}
```

#### 5.3.5 Cutover plan

V2 ships behind `LUNA_SCHEDULER_V2_ENABLED=1` so it can run **side by side**
with the existing TriggerAgent.

**Worker kinds.** Dream and wake are NOT migrated onto the generic `prompt` /
`workflow` workers — those are typed `Worker<never>` and close over only
`SDKClient` + `AgentNotesService`, which cannot carry the dream cycle
(`DreamStore | DreamReasoner | SessionStore | MemoryRouter | Clock`, + an
optional `CalibrationStore`) or the per-workspace wake cycle (`WakeReasoner |
WakeLogStore | AgentNotesService`). So each gets its OWN worker kind:

- **`dream`** (`DREAM_WORKER_KIND`, `packages/core/src/dream/dream-worker.ts`)
  — runs one `runDream(now)` cycle; ignores its payload (the window comes from
  the watermark). ONE nightly row.
- **`wake`** (`WAKE_WORKER_KIND`, `packages/core/src/wake/wake-worker.ts`) —
  runs one `runWake(now, opts)` cycle; its payload MUST carry
  `{ workspaceSlug, workspacePath }` (parsed up front), so there is ONE row PER
  wake-enabled workspace.

Both kinds are registered into the boot `WorkerRegistry` alongside `prompt` +
`workflow` (`buildWorkerRegistryLayer` in `chat-server.ts`), so a JobTicker
draining the `jobs` table dispatches `kind='dream'` / `kind='wake'` rows to
them.

The order of operations:

| Step | Effect |
|---|---|
| 1 | Schema migration ships in a release; `jobs` rows get new columns; `job_runs` empty. |
| 2 | `LUNA_SCHEDULER_V2_ENABLED=1` flips on JobTicker (which now registers the `dream` + `wake` worker kinds too); old TriggerAgent still up. |
| 3 | Run `dream-wake-install.ts` to seed ONE `kind='dream'` row + ONE `kind='wake'` row per wake-enabled workspace (idempotent, `enabled=1`, UTC `next_run_at`). The dream row reuses dream's existing nightly schedule (`0 3 * * *`); each wake row reuses the wake schedule (`*/30 * * * *`). No generic `prompt`/`workflow` row is involved. |
| 4 | The SAME `LUNA_SCHEDULER_V2_ENABLED=1` flag gates BOTH `buildDreamCronLayer` and `buildWakeCronLayer` to register NOTHING (each returns an empty Layer), so dream + wake run EXCLUSIVELY through their V2 job rows — the boot graph holds EITHER the legacy crons OR the V2 ticker for dream/wake, never both. Reversible: flip the flag off and the legacy crons re-register. |
| 5 | Verify on dev: V2 `dream` + `wake` rows present in `jobs`; legacy cron layers register nothing; `job_runs` rows close `success` and the dream watermark / wake_log advance. |
| 6 | After ≥24 h clean on dev, remove TriggerAgent + the old per-cron Layers (`buildDreamCronLayer` / `buildWakeCronLayer`) and the flag gate entirely. |

§5.1 jobs columns from V1 (`spec`, `next_run`, `last_run`, `last_status`)
are kept indefinitely as deprecated synonyms; new code never writes them.

#### 5.3.6 Non-goals (V1)

- Retries with backoff. `attempt` column exists; retry loop is Phase 13.
- Cross-fire uniqueness / debounce — Phase 13.
- Sub-minute cron resolution — out of scope; ticker is 60 s.
- Distributed coordination — single-process; Phase 14 if needed.
- Workflow DAG (branches/joins) — V1 workflows are linear step lists; DAG
  is Phase 13+.

#### 5.3.7 Observability

Every tick logs:
- `[luna/sched] tick claimed=N submitted=N skipped=N` at INFO.
- `[luna/sched] run id=… kind=… status=…` at INFO per `job_runs` close.
- `[luna/sched] worker.error kind=… cause=…` at ERROR.

`obs_session_explain` / `obs_sessions_search` continue to work since each
`prompt`-kind job spawns a SDK session whose events flow through the
existing analytics pipeline.

---

## §6. Error Taxonomy (frozen)

Every module defines its error channel as a tagged union of data errors extending `Data.TaggedError`. Errors compose up via `E` in `Effect<A, E, R>`.

### 6.1 Root error categories
```
Category            │ Recovery policy                          │ Observability
────────────────────┼──────────────────────────────────────────┼───────────────
TransientError      │ Retry w/ exponential backoff             │ Warn
RateLimitError      │ Account rotation (§9) or backoff         │ Warn
PermissionError     │ Propagate to caller; never silent        │ Info
ValidationError     │ Propagate; never retry                   │ Error
ConfigError         │ Fail boot; never downgrade               │ Fatal
IntegrityError      │ Halt affected resource; alert            │ Fatal
SDKError            │ Categorize → Transient/Rate/Permission   │ Varies
```

### 6.2 Reference errors per module
```ts
// Sessions
class SessionClosedError extends Data.TaggedError("SessionClosedError")<{
  sessionId: string
}> {}
class SessionTimeoutError extends Data.TaggedError("SessionTimeoutError")<{
  sessionId: string; afterMs: number
}> {}

// Teams
class TeammateOrphanedError extends Data.TaggedError("TeammateOrphanedError")<{
  teamName: string; teammate: string; reason: "lead_exited" | "scope_closed"
}> {}
class TaskCompletionLagError extends Data.TaggedError("TaskCompletionLagError")<{
  taskId: string; stuckMs: number
}> {}

// Workflows
class WorkflowCompensationError extends Data.TaggedError("WorkflowCompensationError")<{
  workflowId: string; stepId: string; cause: unknown
}> {}

// Accounts
class AllAccountsExhaustedError extends Data.TaggedError("AllAccountsExhaustedError")<{
  kind: string
}> {}

// Memory
class MemoryBackendError extends Data.TaggedError("MemoryBackendError")<{
  backend: string; op: "read" | "write" | "delete" | "migrate"; cause: unknown
}> {}
```

### 6.3 Error boundary rule
- **Leaf services** may raise their tagged errors.
- **Composing services** either handle, translate (`Effect.mapError`), or propagate — never swallow silently.
- **Root entrypoints** log + emit observability + return structured error to caller.

---

## §7. Per-Module Service Signatures (revisable)

Implementation sketch per module — these signatures will evolve as real code informs them. Frozen items are **what the module does**; signatures are **how** (revisable per phase).

### 7.1 SessionService
```ts
class SessionService extends Effect.Service<SessionService>()(
  "luna/SessionService",
  {
    effect: Effect.gen(function* () {
      const store = yield* SessionStore
      const adapter = yield* SDKAdapter
      return {
        open: (opts: SessionOptions) => /* returns scoped session */,
        resume: (id: string) => /* replays from SessionStore */,
        fork: (id: string, opts?: Partial<SessionOptions>) => /* branch */,
        list: (q?: SessionQuery) => /* Stream<SessionSummary> */,
        close: (id: string) => /* Scope close */,
      }
    }),
  }
) {}
```

### 7.2 TeamBroker
```ts
class TeamBroker extends Effect.Service<TeamBroker>()(
  "luna/TeamBroker",
  {
    effect: Effect.gen(function* () {
      const tasks = yield* TaskList
      const sessions = yield* SessionService
      return {
        create: (spec: TeamSpec) => /* scoped team in caller's Scope */,
        send: (team: string, to: string, msg: unknown) => /* writes to TaskList mailbox */,
        broadcast: (team: string, msg: unknown) => /* iterate teammates */,
        awaitIdle: (team: string, teammate: string) => /* watches status */,
        dissolve: (team: string) => /* cancels teammates, writes dissolved_at */,
      }
    }),
  }
) {}
```

### 7.3 WorkflowRuntime
```ts
// Wraps @effect/workflow; no public DSL until 2+ real workflows exist.
class WorkflowRuntime extends Effect.Service<WorkflowRuntime>()(
  "luna/WorkflowRuntime",
  {
    effect: Effect.gen(function* () {
      const state = yield* WorkflowState
      return {
        start: <I, O, E>(wf: WorkflowDef<I, O, E>, input: I) => /* id */,
        suspend: (id: string, reason: string) => /* persisted */,
        resume: (id: string, signal?: unknown) => /* replay */,
        list: (q?: WorkflowQuery) => /* Stream */,
      }
    }),
  }
) {}
```

### 7.4 MemoryRouter (interface extracted from two reference backends, per advisor)
```ts
// DO NOT FREEZE THIS SIGNATURE. Extract after memory-sqlite + memory-file both work.
// Placeholder:
class MemoryRouter extends Effect.Service<MemoryRouter>()(
  "luna/MemoryRouter",
  {
    effect: Effect.gen(function* () {
      // Shape TBD — comes out of Phase 5 (ship sqlite + file, then extract).
      return { /* …placeholder… */ }
    }),
  }
) {}
```

### 7.5 AccountBroker (narrowed scope — §0.2)
```ts
class AccountBroker extends Effect.Service<AccountBroker>()(
  "luna/AccountBroker",
  {
    effect: Effect.gen(function* () {
      const secrets = yield* SecretProvider
      return {
        // Fine-grained: transparent wrap for tools/MCP we own
        acquireTool: (toolName: string) =>
          /* Scoped<Credential> — released on scope exit */,

        // Coarse-grained: model credential for a new subprocess spawn
        acquireSession: (opts: { model: string; budgetUsd?: number }) =>
          /* Scoped<Credential> — rotation only at session boundaries */,

        report: (usage: UsageReport) => /* updates health + cost */,
      }
    }),
  }
) {}
```

### 7.6–7.N
Remaining signatures (ScreenCapture, GatewayService, LabsService, TrainingHarness, HookRegistry, MCPRegistry, SkillRegistry, TriggerService, SandboxRuntime, UIService, ObservabilityService, TelemetryService, NetSecClient, CostAccountingService) follow the same pattern: Service + Layer per §4 topology; tagged errors per §6; Scope-attached per §3. Full stubs generated in Phase 1 scaffolding with `// TODO: implement` bodies, compiling end-to-end.

---

## §8. Testing Strategy (revisable)

Four test tiers. Every phase must produce tests at tiers 1–2; tier 3 where applicable; tier 4 at checkpoints.

```
Tier │ Name             │ Scope                     │ Framework       │ Gate
─────┼──────────────────┼───────────────────────────┼─────────────────┼─────────
1    │ Unit             │ Pure functions, one svc   │ vitest          │ PR
2    │ Simulation       │ Multi-tick state machines │ vitest + mocks  │ PR
3    │ Integration      │ Layer composition         │ vitest + SQLite │ CI
4    │ E2E Parity       │ Full SDK adapter          │ vitest + real   │ Checkpoint
     │                  │                           │ SDK subprocess  │
```

### 8.1 Parity harness (Tier 4)
- Ported subset of SDK examples run against our adapter.
- Same input, fixed seed → compare message traces.
- "Byte-equivalent" = structural equality on `{kind, role, content}` per message, ignoring timestamps and UUIDs.

### 8.2 Simulation pattern (Tier 2)
Uses a `simulateTick()` pattern. Every stateful module (Accounts health, Task lifecycle, Workflow state, Session status) gets N-tick simulations asserting invariants at intermediate steps + final state.

### 8.3 Layer-swap test doubles (Tier 3)
Every Service has a `Default` Layer (real) and a `Test` Layer (in-memory/fake). Integration tests compose: `Layer.mergeAll(realA, testB, realC)` to isolate one component under realistic dependencies.

---

## §9. UI System (revisable)

Consumes §16 observability stream. **Tauri + SolidJS** (a Tauri shell over the Solid `@luna/ui-web` bundle remains a revisable design option). Non-goal for M1–M3; targeted at M4+. Web client (`apps/ui-web`) is live; the native desktop surface today is the floating **Luna Moon** widget (`apps/ui-moon-tauri`).

---

## §10. Memory Backend Details (revisable)

The memory subsystem is namespace-routed: a `MemoryRouter` accepts arbitrary
namespace strings on every `MemoryRecord` and dispatches reads/writes to a
backend selected by the first matching rule. This section documents the
**recommended namespace taxonomy** that app composers should follow, the
**default backend mapping** per prefix, and the **schema-drift policy** that
relates the shipped backend tables to the §5.1 reserved skeleton.

### 10.1 Reserved namespace prefixes

These prefixes are conventions, not contract. The router accepts any string;
the prefixes below are the recommended shape for app composition so that
default backends, retention policies, and tooling can converge on shared
expectations.

```
Prefix            │ Lifetime               │ Default backend         │ Vector?
──────────────────┼────────────────────────┼─────────────────────────┼────────
session:<id>:*    │ Ephemeral; dies with   │ InMemoryBackend         │ no
                  │ the owning Session     │                         │
                  │ Scope (§3.1)           │                         │
working:<id>:*    │ Durable working set;   │ SqliteBackend           │ no
                  │ outlives session;      │ (per-session db path or │
                  │ caller-managed eviction│  shared db + ns filter) │
knowledge:*       │ Durable; long-lived    │ SqliteVectorBackend     │ yes
                  │ knowledge corpus       │                         │
*                 │ Catch-all default;     │ Caller's choice         │ caller
                  │ MUST be specified per  │ (often InMemoryBackend  │
                  │ `makeRouter` contract  │  for tests, SqliteBackend│
                  │                        │  for prod)              │
```

**Lifetime/retention guidance** (no enforcement code; this is composition policy):

- `session:<sessionId>:*` — records die with the session Scope. The default
  `InMemoryBackend` Layer is itself process-scoped; a real session-scoped
  Layer is composed by the Session machinery (§3.1) and finalized when the
  session closes. Callers MAY pin to a durable backend if they need
  postmortem inspection — that's a deliberate choice, not the default.
- `working:<sessionId>:*` — durable across restarts; intended for working
  memory (scratchpads, draft notes, in-progress task state) that the agent
  may want to resume. Default `SqliteBackend` retention is unlimited;
  callers SHOULD prune by `since` filter (`MemoryQuery.since`) on a cadence
  appropriate to their domain.
- `knowledge:*` — durable, vector-searchable. Default `SqliteVectorBackend`
  embeds via `EmbedderService` only when `rec.content.text` is a string
  (per `packages/memory/src/backends/sqlite-vector.ts:5-9`); records without
  text are keyed-only. No automatic expiry; this is the corpus.
- `*` — must be specified explicitly per `makeRouter`'s precondition
  (`packages/memory/src/router.ts:74-76`). Construction throws otherwise.

### 10.2 Embedder requirement

Only `SqliteVectorBackend` requires `EmbedderService` in its Layer
(`packages/core/src/embedder/embedder.ts`). The other backends (`InMemoryBackend`,
`FileBackend`, `SqliteBackend`) have no embedder dependency and can be
composed without it. `MemoryLayer` itself does NOT take an embedder argument
— vector backends compose `EmbedderService` upstream, then are passed to
`MemoryLayer` as already-resolved `MemoryBackend` values. This keeps
namespace routing decoupled from any specific I/O capability.

### 10.3 Schema drift from §5.1

§5.1 reserves two memory tables in the Persistence Schema baseline:
`memory_keyed(k, v, ts, tags)` and `memory_vectors(id, embedding, text,
meta_json, ts)`. The shipped backends in `packages/memory/src/backends/`
**extend** these schemas to make `MemoryRecord` round-trip losslessly through
the export/import envelope:

- `sqlite.ts:11-22` — `memory_keyed` carries the full record columns
  (`id`, `namespace`, `kind`, `content_json`, `schema_version`,
  `created_at`, `updated_at`, `tags_json`) plus per-column indexes. The
  original §5.1 `(k, v, ts, tags)` skeleton was too flat to support
  `MemoryQuery` filters.
- `sqlite-vector.ts:19-27` — `memory_vectors` adds `namespace`, `dimension`,
  drops `meta_json` (no current consumer), and a `FOREIGN KEY ... ON DELETE
  CASCADE` to `memory_keyed`.

These extensions are governed by §5.2 migration policy: every schema change
is a numbered migration, gated by `schema_versions`, with the §5.1 column
intent preserved. The shipped tables are the authoritative shape for any
backend implementing the `MemoryBackend` interface (`packages/memory/src/backend.ts`).
Future schema changes follow §5.2 — no byte-edits to §5.1 are required for
the current drift.

### 10.4 Routing contract recap

- `makeRouter(rules)` requires `rules.length >= 1` and at least one rule with
  `pattern: "*"` (the default). Construction throws synchronously otherwise.
- `MemoryLayer({ rules })` wraps `makeRouter` in a `Layer.sync` that provides
  the `MemoryRouterTag` Effect Tag. The throw surfaces at Layer build time,
  not at `MemoryLayer({...})` call time.
- Pattern matching is first-match-wins, in registration order. Patterns
  support exact match, `prefix:*` suffix wildcard, and the bare `"*"`
  catch-all. No regex; no nested wildcards.
- Reads by `id` fan through all backends in registration order until one
  returns non-null. This tolerates id collisions across backends but does
  not detect them — backend authors should namespace their ids.
- `query({namespace})` dispatches by pattern; `query({})` (no namespace) fans
  out across every backend via `Stream.mergeAll` and merges results.

### 10.5 Forward-pointers

- **Phase 26 — hybrid search.** `MemoryRouter.search` already accepts
  `mode: "vec" | "hybrid"`. `"hybrid"` currently fails with a
  not-implemented `MemoryBackendError` from `SqliteVectorBackend`; Phase 26
  adds BM25/FTS5 ranking and merges with cosine.
- **Phase 27 — vector scale-up (shipped).** `SqliteVectorBackend` now loads
  the [Vectorlite](https://github.com/1yefuwang1/vectorlite) SQLite extension
  at Layer build (process-wide one-shot via `Database.setCustomSQLite` to
  Homebrew's libsqlite3, since Apple stock libsqlite is built with
  `SQLITE_OMIT_LOAD_EXTENSION`). When loaded, vec ranking goes through a
  `memory_vectors_hnsw` virtual table (HNSW index) kept in sync with
  `memory_vectors` via AFTER triggers. Note: this is **not** `sqlite-vec`
  (which is brute-force only and would still be O(N)); Vectorlite is the
  HNSW-indexed SQLite extension. When the extension cannot load (non-bun
  runtime, missing brew sqlite, missing prebuilt), the backend warns once
  and falls back to the original naive `SELECT * → JS cosine → topK` ranker
  — graceful degradation per §6.1, never an error. Measured p95 on
  arm64-darwin with the stub embedder (64-dim): ~0.4–0.9ms across
  N ∈ {100, 500, 1k, 5k}, vs the naive path's ~372ms p95 at N=1k. The
  hybrid leg's vec component now uses the HNSW path; the BM25 (FTS5) leg
  is unchanged.
- **Phase 27d — HNSW backfill on reopen (shipped, PR #3).** Vectorlite
  v-tables created without `index_file_path` are memory-only AND per-
  connection. The previous `if (!hnswExisted)` backfill gate keyed on
  schema presence in `sqlite_master`, which stays true after first
  creation — so post-restart boots silently skipped the backfill and
  vec search returned 0 hits for every record predating the connection.
  Fix: `backfillHnswIfEmpty` self-probes the v-table with any stored
  embedding (k=1) and INSERTs all `memory_vectors` rows when the probe
  returns empty. Called from both `SqliteVectorBackend.make` and
  `sqlite-vector-maintenance.openDb`. `MemoryVectorHnswStatus.indexedCount`
  exposes the real graph population so `luna memory status` can
  distinguish schema-present-but-empty from healthy.
- **Phase 27e — persistent HNSW via sidecar (shipped).** Backfill is
  correct but pays O(N · log N · M) per connection open. With vectorlite's
  `index_file_path` argument the graph serializes to a sidecar file on
  `db.close()` and reloads on next open — backfill becomes a no-op on a
  healthy persisted index. Sidecar lives at `${dbPath}.hnsw.bin`, mode
  `0o600`. Migration path: a legacy memory-only v-table on disk is
  detected by inspecting its `sqlite_master.sql` for an embedded path
  literal; mismatches trigger DROP+recreate, and `backfillHnswIfEmpty`
  rebuilds from `memory_vectors`. Corruption recovery: vectorlite defers
  index-file deserialization to the first `knn_search`, so the backend
  probes after CREATE; if the probe throws, the sidecar is discarded,
  the v-table is recreated, and the canonical `memory_vectors` table
  drives the rebuild. In-memory and `:memory:` DBs continue to use the
  legacy memory-only v-table (sidecar path = `null`) and rely on the
  per-open backfill — they cost nothing extra and the persistence
  contract doesn't apply to ephemeral storage.
- **Per-backend tuning knobs** (TTL, eviction policy, encryption-at-rest)
  remain backend-private until a real caller demands a uniform surface.

---

## §11. Gateway Adapter Details (revisable)

Per-platform auth, rate limits, message shapes. Discord/Telegram/CLI/HTTP first; plugins after.

---

## §12. SDK Adapter Contract (frozen)

> The adapter is the most load-bearing piece. It bridges Promise/AsyncIterable (SDK) ↔ Effect/Stream. If this contract is wrong, every module breaks.

### 12.1 Core operations
```ts
interface SDKAdapter {
  // Primary entry: iterable-in, stream-out
  query(
    input: Stream.Stream<SDKUserMessage>,
    options: SessionOptions,
  ): Effect.Effect<Stream.Stream<SDKMessage>, SDKError, Scope.Scope>

  // Session management
  resumeSession(id: string): Effect.Effect<Stream.Stream<SDKMessage>, SDKError, Scope.Scope>
  forkSession(id: string, opts?: Partial<SessionOptions>): Effect.Effect<string, SDKError>

  // Hook registration
  registerHook<E extends HookEvent>(
    event: E,
    matcher: string | RegExp | undefined,
    handler: HookHandler<E>,
  ): Effect.Effect<void, never, Scope.Scope>

  // Permission callback
  setPermissionCallback(
    cb: (req: PermissionRequest) => Effect.Effect<PermissionDecision, never>,
  ): Effect.Effect<void>
}
```

### 12.2 Invariants
1. **Iterable lifetime ≡ Scope lifetime.** The input iterable closes iff Scope closes.
2. **Every SDK message is mirrored to our SessionStore** before returning to caller — we never trust the SDK's transcript view alone.
3. **All SDK hook events are exposed** via re-export of `HOOK_EVENTS` from `@anthropic-ai/claude-agent-sdk`. The hook surface is `typeof HOOK_EVENTS[number]` — count is an SDK property, not an architectural decision. Whatever ships upstream, we expose.
4. **Permission evaluation order matches SDK exactly**: `Hooks → Deny rules → Permission mode → Allow rules → canUseTool`.
5. **Timeouts on every SDK call.** Default 30s; configurable. Plus an **idle timeout** (default 120s, configurable via `SessionOptions.idleTimeoutMs`) that aborts the query if no message has been yielded for the idle window — a hard-won mitigation for SDK subprocess hangs.
6. **Persisted messages use a versioned envelope.** `StoredMessage.payload` is typed `unknown` and carries a `schemaVersion` field. The SDK's `SDKMessage` union is re-exported by the adapter package only; core never imports SDK types at runtime. Readers validate with `effect/Schema` at read time, decoupling at-rest data from SDK shape drift.
7. **The adapter owns reserved `Options` keys.** When merging caller-supplied `sdkOptions` into the outgoing SDK `Options`, the adapter ALWAYS overwrites `hooks`, `canUseTool`, `abortController`, `resume`, `forkSession` with adapter-owned values. If any of these keys are present in caller input, the adapter logs a warning and drops them. Tested.
8. **The `Query` handle is retained.** `query()` returns a `Query` object that is both an async iterable AND a handle with control methods (`interrupt`, `supplyToolPermissionResponse`, etc.). The adapter stores the handle in a session-scoped `Ref` so callbacks (notably `canUseTool` "ask" flows) can reach it.

### 12.3 Known risks (see §12.4 mitigations)
- Iterable closes too early → hooks silently break (SDK issue #9705).
- Subprocess hang with no error (SDK bug).
- Transcript view may drop queued messages (SDK issue #67).
- Windows `streamInput` crash (SDK v0.2.77+).
- `Stream.fromAsyncIterable(queryObj)` drops the Query control handle.
- Caller-supplied `sdkOptions.hooks` silently overrides adapter-registered hooks if merge is naive.
- Persisted `SDKMessage` re-export couples at-rest data to SDK shape drift.

### 12.4 Mitigations
- Scope-attached iterable ownership (§3.1) prevents early close.
- `Effect.timeout` wrapper on every query prevents infinite hang.
- Idle-timeout Fiber racing the query stream (reset on each yielded message) catches silent subprocess hangs.
- Independent SessionStore mirror prevents transcript loss.
- Windows pinned to patched SDK version + fallback path.
- Adapter stores `Query` handle in session-scoped `Ref` (§12.2 invariant #8).
- Merge guard: adapter overwrites reserved keys with warning (§12.2 invariant #7).
- Versioned envelope at persistence boundary (§12.2 invariant #6).

---

## §13. Parity Acceptance (frozen — falsifiable)

Replaces the original §4.5.17. Each criterion is a runnable test.

### 13.1 Criteria
1. **Example parity**: every SDK example in our ported example corpus produces byte-equivalent message traces under our adapter for a fixed seed, with ≤1 documented import-path change.
2. **Hook event coverage**: every event in the SDK's `HOOK_EVENTS` constant fires at semantically equivalent points — verified by a hook-event-capture test that iterates `HOOK_EVENTS` at runtime (no hard-coded count).
3. **Permission evaluation order**: captured via instrumented harness; must match SDK exactly.
4. **Round-trip session export/import**: sessions round-trip lossless through JSON export/import — this is a feature, owned by M2.

### 13.2 Non-criteria (explicitly excluded)
- Bit-identical output (timestamps, UUIDs, ordering of concurrent events vary).
- Zero-import-change drop-in replacement (too strong; dropped).
- SDK full test-suite pass (SDK tests aren't public; we run our ported subset).

### 13.3 Parity test corpus location
`packages/core/test/parity/examples/*.spec.ts` — each example is a paired file `{input.ts, expected-trace.json}`.

---

## §14. Training Labs Internals (revisable — deferred to post-M3)

Per advisor: "vision, detailed spec deferred to post-M3." Placeholder structure only:
- Scenario bank (schema TBD)
- Rubric engine (contract TBD — comes from 2+ real rubrics)
- LLM-judge templates (TBD)
- Scientist loop (Workflow-backed; spec after Workflows module stable)
- Budget governor (uses AccountBroker + CostAccounting)

---

## §15. Milestones + Checkpoint Gates (frozen)

```
Milestone     │ Scope                                            │ Gate
──────────────┼──────────────────────────────────────────────────┼────────────────────
M0 Scaffold   │ Workspace, Effect pinned, core Service pattern   │ Tests green
              │ end-to-end on one trivial Service                │
M1 Adapter    │ SDK adapter + SessionService + MemoryRouter      │ 🔍 ARCH CHECKPOINT
              │ (sqlite+file) + 3 SDK examples passing parity    │   adapter holds?
M2 Agents     │ Subagents, hooks (all 19), permissions,          │ Parity suite green
              │ skills, MCP registry, option configs, prompts    │
M3 Concurrency│ Teams, Workflows, Triggers, Jobs, Sandbox,       │ 🔍 ARCH CHECKPOINT
              │ Screen Capture, Account Rotation                 │   Scope model holds?
M4 Feature    │ Labs, Training Harness, Gateway (Discord/Tg/CLI),│ Acceptance tests
              │ Plugin Play, Observability/Telemetry/UI, NetSec, │ green; cost
              │ Cost Accounting, Secrets                         │ accounting accurate
M5 v4 Prep    │ Effect v4 migration spike                        │ Codemod + tests
```

**Checkpoint gates are blocking.** At M1 and M3, we pause implementation, invoke the advisor, re-validate architecture, amend this doc if needed, then proceed.

---

## §16. Observability Contract (frozen)

Every module emits structured events via `@effect/opentelemetry` Tracer + a local JSONL sink. Events include:
- `SessionStart/End` — session id, model, options digest.
- `ToolCall` — name, input digest, duration, result status.
- `HookFire` — event, matcher, decision.
- `PermissionDecision` — tool, decision, rule path.
- `TeammateStart/Idle/Stop` — team, teammate, reason.
- `WorkflowTransition` — workflow id, from, to.
- `AccountSwitch` — from, to, reason.
- `CostAccrued` — session/team/workflow, tokens, USD.
- `Error` — tagged error + context.

Sinks:
- Local JSONL at `~/.luna/events.jsonl`.
- OTLP exporter (configurable).
- DuckDB refresher (telemetry parity).

---

## §17. Repo Layout (revisable)

```
luna/
├── DESIGN.md                              ← this document
├── package.json                           ← Bun workspace root
├── bun.lock
├── tsconfig.json
├── vitest.config.ts
├── packages/
│   ├── core/                              ← Boot, Foundation, Persistence layers
│   │   ├── src/
│   │   │   ├── config/
│   │   │   ├── schema/
│   │   │   ├── sql/
│   │   │   ├── secret/
│   │   │   ├── session-store/
│   │   │   ├── memory-router/             ← interface extracted in M1
│   │   │   ├── task-list/
│   │   │   ├── workflow-state/
│   │   │   ├── account-broker/
│   │   │   ├── hook-registry/
│   │   │   ├── mcp-registry/
│   │   │   ├── skill-registry/
│   │   │   ├── cost-accounting/
│   │   │   └── errors.ts
│   │   ├── migrations/
│   │   └── test/
│   ├── adapter-sdk/                       ← SDK adapter (§12) — the load-bearing piece
│   │   ├── src/
│   │   │   ├── query.ts
│   │   │   ├── stream-bridge.ts
│   │   │   ├── hook-bridge.ts
│   │   │   └── permission-bridge.ts
│   │   └── test/parity/
│   ├── runtime/                           ← Runtime layer
│   │   ├── session/
│   │   ├── agent/
│   │   ├── team/
│   │   ├── workflow/
│   │   ├── schedule/
│   │   ├── trigger/
│   │   ├── sandbox/
│   │   └── screen-capture/
│   ├── memory/
│   │   ├── sqlite/
│   │   ├── file/
│   │   └── vector/                        ← post-M3
│   ├── tools/                             ← built-in + custom tool builder
│   │   ├── builtins/
│   │   └── builder/
│   ├── gateway/
│   │   ├── discord/
│   │   ├── telegram/
│   │   ├── cli/
│   │   ├── http/
│   │   └── plugin-play/
│   ├── labs/                              ← M4
│   ├── training-harness/                  ← M4
│   ├── observability/
│   ├── telemetry/
│   ├── netsec/
│   └── ui/                                ← M4
├── apps/
│   ├── agent-cli/                         ← reference composition
│   └── agent-ui/                          ← Tauri (M4)
└── test/
    ├── parity/                            ← SDK example corpus
    └── integration/
```

---

## §18. Glossary (for cross-referencing)

```
Term                │ Meaning
────────────────────┼────────────────────────────────────────────────────────
Service             │ Effect.Service — DI unit with a default Layer
Layer               │ Effect composition unit; builds a Service
Scope               │ Lifetime unit; owns Fibers + resources
Fiber               │ Lightweight Effect thread
Stream              │ Lazy async sequence; Effect's equivalent of AsyncIterable
Effect<A, E, R>     │ Typed computation: success A, error E, requirements R
Adapter             │ §12 SDK bridge — Promise/AsyncIterable ↔ Effect/Stream
Session             │ One bidirectional agent conversation, owned by a Scope
Team                │ Lead session + N teammate sessions + shared TaskList
Workflow            │ Durable multi-step state machine (@effect/workflow)
Trigger Agent       │ Agent bound to an event Stream
```

---

## §19. References

- Effect: https://effect.website/
- Effect GitHub: https://github.com/Effect-TS/effect
- @effect/workflow: https://github.com/Effect-TS/effect/tree/main/packages/workflow
- @effect/cluster: https://github.com/Effect-TS/effect/tree/main/packages/cluster
- Claude Agent SDK: https://code.claude.com/docs/en/agent-sdk/
- SDK streaming input: https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- SDK hooks: https://code.claude.com/docs/en/hooks
- SDK subagents: https://code.claude.com/docs/en/agent-sdk/subagents
- SDK teams: https://code.claude.com/docs/en/agent-teams
- SDK issue #9705 (iterable closure): https://github.com/anthropics/claude-code/issues/9705
- SDK issue #67 (transcript visibility): https://github.com/anthropics/claude-agent-sdk-typescript/issues/67
- Team lifecycle trap: https://github.com/anthropics/claude-code-action/issues/1124
