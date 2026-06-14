/**
 * Unit tests for buildSmartBarItems / git resolution.
 *
 * These tests cover the item-assembly logic in isolation by injecting a
 * GitRunner stub — no real git process is spawned.
 *
 * Scenarios:
 *   - clean repo:    git.status item emitted with value="clean", tone="good"
 *   - dirty repo:    git.status item emitted with value="dirty", tone="warn"
 *   - git error:     all three git items (worktree/branch/status) are omitted
 *   - non-repo:      same as git error (toplevel=null, branch=null, status=null)
 *   - detached HEAD: branch item omitted (branch === "HEAD")
 *   - model set:     model item emitted
 *   - model absent:  model item absent
 */
import { describe, expect, it } from "vitest"
import { buildSmartBarItems } from "../src/server.js"
import type { GitRunner } from "../src/server.js"

// ── helpers ──────────────────────────────────────────────────────────────────

const baseCtx = {
  threadId: "thr_test",
  model: undefined,
  accountLabel: undefined,
  workspaceSlug: undefined,
  localShellBridge: null,
} as const

/** Build a full GitRunner stub from partial overrides. */
const makeGitRunner = (overrides: Partial<GitRunner>): GitRunner => ({
  toplevel: () => "/home/user/my-repo",
  branch: () => "main",
  status: () => "",              // default: clean
  ...overrides,
})

const cleanRunner = makeGitRunner({ status: () => "" })
const dirtyRunner = makeGitRunner({ status: () => "M packages/foo/bar.ts\n?? untracked.txt" })
const errorRunner: GitRunner = {
  toplevel: () => null,
  branch: () => null,
  status: () => null,
}
const detachedRunner = makeGitRunner({ branch: () => "HEAD" })

// ── tests ─────────────────────────────────────────────────────────────────────

describe("buildSmartBarItems — git.status chip", () => {
  it("clean repo: emits git.status with value='clean' and tone='good'", () => {
    const items = buildSmartBarItems(baseCtx, cleanRunner)
    const statusItem = items.find((i) => i.id === "git.status")
    expect(statusItem).toBeDefined()
    expect(statusItem?.value).toBe("clean")
    expect(statusItem?.tone).toBe("good")
  })

  it("dirty repo: emits git.status with value='dirty' and tone='warn'", () => {
    const items = buildSmartBarItems(baseCtx, dirtyRunner)
    const statusItem = items.find((i) => i.id === "git.status")
    expect(statusItem).toBeDefined()
    expect(statusItem?.value).toBe("dirty")
    expect(statusItem?.tone).toBe("warn")
  })

  it("git error / non-repo: omits all three git items", () => {
    const items = buildSmartBarItems(baseCtx, errorRunner)
    const ids = items.map((i) => i.id)
    expect(ids).not.toContain("git.worktree")
    expect(ids).not.toContain("git.branch")
    expect(ids).not.toContain("git.status")
  })
})

describe("buildSmartBarItems — git.worktree chip", () => {
  it("emits git.worktree with the basename of toplevel", () => {
    const items = buildSmartBarItems(baseCtx, cleanRunner)
    const worktreeItem = items.find((i) => i.id === "git.worktree")
    expect(worktreeItem).toBeDefined()
    expect(worktreeItem?.value).toBe("my-repo")
  })

  it("omits git.worktree when toplevel is null", () => {
    const runner = makeGitRunner({ toplevel: () => null })
    const items = buildSmartBarItems(baseCtx, runner)
    expect(items.find((i) => i.id === "git.worktree")).toBeUndefined()
  })
})

describe("buildSmartBarItems — git.branch chip", () => {
  it("emits git.branch for a normal branch name", () => {
    const items = buildSmartBarItems(baseCtx, cleanRunner)
    const branchItem = items.find((i) => i.id === "git.branch")
    expect(branchItem).toBeDefined()
    expect(branchItem?.value).toBe("main")
  })

  it("omits git.branch when branch is 'HEAD' (detached HEAD)", () => {
    const items = buildSmartBarItems(baseCtx, detachedRunner)
    expect(items.find((i) => i.id === "git.branch")).toBeUndefined()
  })

  it("still emits git.status when detached (toplevel is non-null)", () => {
    const items = buildSmartBarItems(baseCtx, detachedRunner)
    const statusItem = items.find((i) => i.id === "git.status")
    expect(statusItem).toBeDefined()
    expect(statusItem?.value).toBe("clean")
  })
})

describe("buildSmartBarItems — model chip", () => {
  it("emits model item when model is set", () => {
    const ctx = { ...baseCtx, model: "claude-opus-4-5" }
    const items = buildSmartBarItems(ctx, cleanRunner)
    const modelItem = items.find((i) => i.id === "model")
    expect(modelItem).toBeDefined()
    expect(modelItem?.value).toBe("claude-opus-4-5")
  })

  it("omits model item when model is undefined", () => {
    const items = buildSmartBarItems(baseCtx, cleanRunner)
    expect(items.find((i) => i.id === "model")).toBeUndefined()
  })
})

describe("buildSmartBarItems — graceful degrade on git error", () => {
  it("non-git-repo: emits model/workspace/account items but no git items", () => {
    const ctx = {
      ...baseCtx,
      model: "claude-sonnet-4-6",
      workspaceSlug: "my-workspace",
      accountLabel: "primary",
    }
    const items = buildSmartBarItems(ctx, errorRunner)
    const ids = items.map((i) => i.id)
    // No git items
    expect(ids).not.toContain("git.worktree")
    expect(ids).not.toContain("git.branch")
    expect(ids).not.toContain("git.status")
    // Non-git items still present
    expect(ids).toContain("model")
    expect(ids).toContain("workspace")
    expect(ids).toContain("account")
  })
})
