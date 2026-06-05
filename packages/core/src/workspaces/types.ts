/**
 * WorkspaceRegistryService — types.
 *
 * A workspace is a folder containing a `.workspace/` subdirectory with
 * `workspace.md` (self-description) and `workspace.db` (its scoped brain).
 * The registry tracks which workspaces Luna knows about. See SYSTEM.md
 * §Workspaces for the full discipline.
 *
 * The registry holds metadata only — slug, path, cached summary, status.
 * The workspace's own state lives in its `workspace.db`; the registry just
 * makes the workspace discoverable.
 */
import type { Effect } from "effect"
import { Data } from "effect"

/**
 * Lifecycle status for a workspace row.
 *
 * - `active`   — currently in use; appears in default listings.
 * - `paused`   — temporarily idle (still discoverable, not surfaced).
 * - `archived` — historical; hidden from default listings.
 *
 * Open string union — callers may extend with project-specific values,
 * but the SQLite store stores the raw text without enum constraint.
 */
export type WorkspaceStatus = "active" | "paused" | "archived" | string

/**
 * A registered workspace.
 *
 * `slug` is the stable identifier (e.g. `"luna"`, `"risk-research"`).
 * `path` is the absolute folder containing the `.workspace/` subdir.
 * `summary` is a cached one-paragraph description, normally refreshed
 * from `workspace.md`'s opening lines.
 * `createdAt` / `updatedAt` are epoch-ms.
 */
export interface Workspace {
  readonly slug: string
  readonly path: string
  readonly summary: string | null
  readonly status: WorkspaceStatus
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * Tagged error for the workspaces registry. `op` identifies the failing
 * operation; `message` is human-readable.
 */
export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  readonly op:
    | "register"
    | "get"
    | "list"
    | "touch"
    | "update-summary"
    | "set-status"
    | "delete"
    | "boot"
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Input to `register`. `summary` and `status` are optional; status
 * defaults to `"active"`.
 */
export interface RegisterInput {
  readonly slug: string
  readonly path: string
  readonly summary?: string | null
  readonly status?: WorkspaceStatus
}

/**
 * Filter for `list`. Omit `status` to return every row (any status).
 * Pass a single status to filter to one bucket.
 */
export interface ListFilter {
  readonly status?: WorkspaceStatus
}

/**
 * Workspace registry API.
 *
 * - `register` — insert a new workspace OR update an existing one with
 *   the same slug (upsert; preserves `createdAt`, refreshes other fields).
 * - `get` — single row by slug, or null.
 * - `list` — newest-updated first; optional status filter.
 * - `touch` — refresh `updatedAt` (returns updated row, or null if
 *   slug missing).
 * - `updateSummary` — refresh cached summary + `updatedAt`.
 * - `setStatus` — change lifecycle status + `updatedAt`.
 * - `delete` — hard-delete a row (test/cleanup; archive via setStatus
 *   is the normal soft-delete).
 */
export interface WorkspaceRegistryApi {
  readonly register: (
    input: RegisterInput,
  ) => Effect.Effect<Workspace, WorkspaceError>

  readonly get: (
    slug: string,
  ) => Effect.Effect<Workspace | null, WorkspaceError>

  readonly list: (
    filter?: ListFilter,
  ) => Effect.Effect<ReadonlyArray<Workspace>, WorkspaceError>

  readonly touch: (
    slug: string,
  ) => Effect.Effect<Workspace | null, WorkspaceError>

  readonly updateSummary: (
    slug: string,
    summary: string | null,
  ) => Effect.Effect<Workspace | null, WorkspaceError>

  readonly setStatus: (
    slug: string,
    status: WorkspaceStatus,
  ) => Effect.Effect<Workspace | null, WorkspaceError>

  readonly delete: (slug: string) => Effect.Effect<number, WorkspaceError>
}
