> **Status: shipped** — historical design record, brought onto master for the design trail; not current truth. This PR 0 fix (direct-exec systemd unit form in `scripts/luna-server-install`) landed on master, which is the source of truth.

# Server Installer PR 0 — systemd Unit-Form Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `scripts/luna-server-install` render the chat-server systemd unit in *direct-exec* form so the bun chat-server is the unit's MainPID and receives SIGTERM directly — fixing the graceful-shutdown / HNSW-sidecar-flush bug that the `--filter` wrapper form causes, and making the installer the durable source of truth (so a re-install stops reverting the manual `sed` edit currently live on jax-box).

**Architecture:** One-line `WorkingDirectory` change + one-line `ExecStart` change in the `render_service` heredoc, driven test-first by updating the three assertions in `test/deploy-scripts.test.ts` that pin the old (buggy) unit strings. Scope is strictly `render_service`; the package.json `server:chat` script and its doc-pinning test stay untouched.

**Tech Stack:** Bash (the installer script), vitest (`bun run test`), systemd unit semantics.

**Spec:** `docs/superpowers/specs/2026-05-29-portable-luna-server-installer-design.md` §7.1.

---

## Why this is correct (context for the implementer)

- Under systemd, `ExecStart=bun run --filter @luna/ui-web server:chat` makes the `bun --filter` wrapper the unit's **MainPID**. systemd delivers SIGTERM to that wrapper, not to the grandchild bun process that runs `scripts/chat-server.ts` and owns the SIGTERM handler (which flushes the HNSW sidecar + re-secures `.env`). So on `systemctl stop/restart` the handler never runs.
- `apps/ui-web/package.json`'s `server:chat` script is literally `bun run scripts/chat-server.ts`. Running that **directly** as `ExecStart`, with `WorkingDirectory` set to `apps/ui-web`, makes the chat-server bun process the MainPID → it gets SIGTERM → graceful shutdown works. Verified empirically on jax-box: `--filter` → sidecar never written across 4 restarts; direct-exec → sidecar written at `0600`.
- **Behavior-preserving precondition:** the two `process.cwd()` consumers are `apps/ui-web/scripts/sandbox-local-shell.ts` (preserved by setting `WorkingDirectory=…/apps/ui-web`) and `packages/chat-service/src/chat-service.ts:294` (`opts.cwd ?? process.env["LUNA_REPO_ROOT"] ?? process.cwd()`), which is safe because the rendered `.env` sets `LUNA_REPO_ROOT`. The existing test at `test/deploy-scripts.test.ts` already asserts `LUNA_REPO_ROOT=` is in the rendered output — that assertion is the acceptance check for the precondition; do not remove it.

## Scope boundary

- Do **not** edit `apps/ui-web/package.json`'s `server:chat` script (it legitimately stays `bun run scripts/chat-server.ts` for interactive/dev use).
- Do **not** edit README.md / DESIGN.md / CLAUDE.md / the chat-server.ts header comment.
- **`apps/ui-web/scripts/__tests__/rename-chat-server.test.ts` (correction):** this test has a `describe("scripts/luna-server-install")` block whose assertion `expect(read("scripts/luna-server-install")).toContain("server:chat")` pins the *old* unit form. Because PR 0 changes `luna-server-install` to invoke `scripts/chat-server.ts` directly, **that one assertion must be updated** (it's a test of the file we're changing — in scope). Its `package.json` / README / DESIGN.md assertions stay **untouched and green** (PR 0 doesn't change those). Net: update exactly one assertion in this file; if any *other* assertion in it goes red, you touched something out of scope.

## Files

- Modify: `scripts/luna-server-install` (the `render_service` heredoc, ~lines 134 and 136)
- Modify: `test/deploy-scripts.test.ts` (assertions at lines 326, 328, 464)

---

### Task 1: Update the regression assertions to expect the direct-exec form (RED)

**Files:**
- Modify: `test/deploy-scripts.test.ts:326,328,464`

- [ ] **Step 1: Tighten the WorkingDirectory assertion (line 326)**

`render_service` currently emits `WorkingDirectory=${REPO_DIR}`; the existing assertion uses `toContain`, so it would stay green even after the fix (substring match). Tighten it to pin the new `/apps/ui-web` suffix so the cwd contract is test-locked.

Change line 326 from:

```ts
    expect(result.stdout).toContain("WorkingDirectory=" + join(temp, "repo"))
```

to:

```ts
    expect(result.stdout).toContain("WorkingDirectory=" + join(temp, "repo", "apps", "ui-web"))
```

- [ ] **Step 2: Update the first ExecStart assertion (line 328)**

Change line 328 from:

```ts
    expect(result.stdout).toContain("ExecStart=/root/.bun/bin/bun run --filter @luna/ui-web server:chat")
```

to:

```ts
    expect(result.stdout).toContain("ExecStart=/root/.bun/bin/bun run scripts/chat-server.ts")
```

- [ ] **Step 3: Update the second ExecStart assertion (line 464)**

Line 464 is in a second test case and asserts the same string. Change it identically:

```ts
    expect(result.stdout).toContain("ExecStart=/root/.bun/bin/bun run scripts/chat-server.ts")
```

- [ ] **Step 4: Run the test and verify it FAILS**

Run:

```bash
bun run test test/deploy-scripts.test.ts
```

Expected: FAIL. The two ExecStart assertions (and the tightened WorkingDirectory assertion) fail because `render_service` still emits `WorkingDirectory=…/repo` and `ExecStart=… run --filter @luna/ui-web server:chat`. (vitest prints the expected `scripts/chat-server.ts` substring vs the actual `--filter …` line.)

---

### Task 2: Fix `render_service` to emit the direct-exec form (GREEN)

**Files:**
- Modify: `scripts/luna-server-install` (the `render_service` heredoc)

- [ ] **Step 1: Change `WorkingDirectory` and `ExecStart` in the heredoc**

In `scripts/luna-server-install`, inside `render_service()`, change these two lines:

```bash
WorkingDirectory=${REPO_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${bun_bin} run --filter @luna/ui-web server:chat
```

to:

```bash
WorkingDirectory=${REPO_DIR}/apps/ui-web
EnvironmentFile=${ENV_FILE}
ExecStart=${bun_bin} run scripts/chat-server.ts
```

(Leave the `EnvironmentFile`, `Restart=always`, `RestartSec=5`, `[Unit]`, and `[Install]` lines exactly as they are.)

- [ ] **Step 2: Syntax-check the script**

Run:

```bash
bash -n scripts/luna-server-install
```

Expected: no output, exit 0 (valid bash).

- [ ] **Step 3: Run the deploy-scripts tests and verify they PASS**

Run:

```bash
bun run test test/deploy-scripts.test.ts
```

Expected: PASS (all assertions green, including the tightened WorkingDirectory and both ExecStart assertions).

- [ ] **Step 4: Update the obsolete `luna-server-install` assertion in `rename-chat-server.test.ts`**

That test's `describe("scripts/luna-server-install")` block asserts the file routes through `server:chat`, which PR 0 removes. Update that **one** assertion to pin the new direct-exec form. Change:

```ts
    it("starts the chat server through the canonical server:chat script", () => {
      expect(read("scripts/luna-server-install")).toContain(
        "server:chat",
      );
    });
```

to:

```ts
    it("starts the chat server via direct script exec, not the server:chat filter wrapper", () => {
      expect(read("scripts/luna-server-install")).toContain(
        "run scripts/chat-server.ts",
      );
    });
```

Leave the sibling `not.toContain("dev:server:chat")` assertion and all package.json/README/DESIGN.md assertions in this file untouched.

- [ ] **Step 5: Run the rename test and verify it's fully green**

Run:

```bash
bun run test apps/ui-web/scripts/__tests__/rename-chat-server.test.ts
```

Expected: PASS (all assertions). If any assertion *other than* the one you just edited fails, you touched something out of scope — revert that.

- [ ] **Step 6: Commit**

```bash
git add scripts/luna-server-install test/deploy-scripts.test.ts apps/ui-web/scripts/__tests__/rename-chat-server.test.ts
git commit -m "fix(install): render direct-exec chat-server unit so SIGTERM reaches it

render_service emitted ExecStart=bun run --filter @luna/ui-web server:chat,
which makes the bun --filter wrapper the systemd MainPID; SIGTERM then hits
the wrapper, not the chat-server child that owns the graceful-shutdown
handler (HNSW sidecar flush). Switch to WorkingDirectory=\${REPO_DIR}/apps/ui-web
+ ExecStart=bun run scripts/chat-server.ts so the chat-server is MainPID and
receives SIGTERM directly. Behavior-preserving: LUNA_REPO_ROOT in the
EnvironmentFile keeps chat-service's SDK-query cwd off process.cwd().

Updates the two ExecStart assertions + tightens the WorkingDirectory assertion
in test/deploy-scripts.test.ts. Makes the installer the durable source of truth
for the unit (replaces the manual sed edit on jax-box)."
```

---

## After this lands (operational note, not a code task)

The live `luna-dev`/`luna-stable` containers currently carry a **manual `sed`** direct-exec unit. Once this is merged and the containers re-run `luna-server-install` (or pull the branch), the rendered unit will match the manual edit — so the fix becomes durable and a future re-install no longer reverts it. No behavior change on the live boxes (they're already direct-exec); this just makes the source render it.

## Self-review

- **Spec coverage:** implements spec §7.1 (PR 0) in full — the `render_service` change, the three assertion updates (328/464 hard-break, 326 tightened), the scope boundary (`rename-chat-server.test.ts` stays green), and the `LUNA_REPO_ROOT` precondition acceptance check (existing assertion, called out in Task 1 context).
- **Placeholders:** none — every step has the exact before/after code and exact commands.
- **Type/string consistency:** the new ExecStart string `ExecStart=/root/.bun/bin/bun run scripts/chat-server.ts` is identical in the assertion (Task 1 Steps 2–3) and produced by the heredoc (Task 2 Step 1, where `${bun_bin}` resolves to `/root/.bun/bin/bun` via the test's `LUNA_TEST_BUN_PATH`). `WorkingDirectory=${REPO_DIR}/apps/ui-web` matches the tightened assertion `join(temp,"repo","apps","ui-web")`.
