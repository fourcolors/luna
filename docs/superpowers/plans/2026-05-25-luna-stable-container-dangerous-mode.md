# Luna Stable Container And Dangerous Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the stable Luna runtime from the jax-box host user service into an Incus container, then add an explicit container-scoped auto-approval mode for Luna local shell sessions.

**Architecture:** Stable and dev both run as Incus system containers, with stable tracking `master` and dev tracking `dev`. The first dangerous-mode release keeps authority inside the stable container only; it does not mount the host Incus socket and does not give the stable container host-root control. If we later want Luna to manage host Incus instances directly, add a separate host-admin bridge with an explicit risk review.

**Tech Stack:** Incus system containers, Ubuntu 24.04 cloud image, systemd, Bun, Luna UI WebSocket server, `@luna/agent-cli` local shell bridge.

---

## Current State

- `luna-dev` already runs in Incus on jax-box and proxies host `5753/5754` to container `4753/4754`.
- Stable Luna currently runs as the host root user service `luna-chat-server.service` from `/root/luna/stable/repo`.
- Existing stable state is `/root/.luna`; existing dev state is `/root/.luna-dev`.
- `scripts/luna-container-create` already supports `--profile stable`, defaults stable to branch `master`, and mounts stable at `/root/luna` inside the container.
- `luna chat --local-shell` currently requires per-command terminal approval through `approveLocalCommand`; no auto-approve mode exists.

## Boundary Decision

First implementation gives Luna these powers:

- Full command execution inside the `luna-stable` container when a dangerous local shell session is attached.
- Read/write access to the mounted stable repo and stable state because `/root/luna/stable/repo` and `/root/.luna` are bind-mounted into the container.
- No direct host Incus control from inside the stable container.

First implementation intentionally avoids:

- Mounting `/var/lib/incus/unix.socket` into `luna-stable`.
- Copying a host-root SSH key into `luna-stable`.
- Running a headless local-shell daemon before the interactive dangerous session is proven.

That preserves the useful safety property: if Luna goes sideways, the default blast radius is the stable container and the mounted stable Luna files, not the whole jax-box host.

## File Structure

- Modify `scripts/luna-container-create`
  - Add Incus runtime markers to the state `.env`.
  - Add an opt-in flag that creates the dangerous local shell marker file for a container profile.
- Modify `apps/agent-cli/src/chat/args.ts`
  - Parse `--dangerously-auto-approve-local-shell`.
- Modify `apps/agent-cli/src/chat/config.ts`
  - Load profile/global dangerous auto-approve env settings.
  - Require container runtime marker, marker file, and `/root/luna` cwd before enabling auto approval.
- Modify `apps/agent-cli/src/chat/local-shell.ts`
  - Carry `approvalMode: "prompt" | "auto"` in local shell state.
- Modify `apps/agent-cli/src/chat/app.ts`
  - Auto-approve local shell requests only when config passes all dangerous-mode checks.
  - Advertise approval mode in the local shell capability frame.
- Modify `packages/ui-ws/src/protocol.ts`
  - Add optional `approvalMode` to `LocalShellCapabilityFrame`.
- Modify `packages/local-shell-tools/src/layer.ts`
  - Update prompt text so it no longer falsely says every command always requires manual approval.
- Modify `test/deploy-scripts.test.ts`
  - Cover container runtime marker and dangerous marker behavior.
- Modify `apps/agent-cli/test/chat-config.test.ts`
  - Cover flag/env parsing and safety gate failures.
- Modify `apps/agent-cli/test/chat-app.integration.test.ts`
  - Cover auto-approved execution without calling the prompt callback.
- Modify `packages/ui-ws/test/local-shell-bridge.test.ts`
  - Cover that `approvalMode` is preserved in capability state.
- Modify `docs/container-runtime.md`, `docs/install.md`, and `README.md`
  - Document stable container cutover, dangerous mode, rollback, and the host-control boundary.

## Task 1: Document Stable Container Cutover And Rollback

**Files:**
- Modify: `test/deploy-scripts.test.ts`
- Modify: `docs/container-runtime.md`
- Modify: `docs/install.md`
- Modify: `README.md`

- [ ] **Step 1: Write the failing docs coverage test**

Add this test near the existing docs tests in `test/deploy-scripts.test.ts`:

```ts
  it("documents stable container cutover with candidate ports and rollback", () => {
    const read = (path: string) => readFileSync(join(repoRoot, path), "utf8")
    const docs = [
      read("README.md"),
      read("docs/install.md"),
      read("docs/container-runtime.md"),
    ].join("\n")

    expect(docs).toContain("luna-stable")
    expect(docs).toContain("--profile stable")
    expect(docs).toContain("--host-ws-port 6753")
    expect(docs).toContain("systemctl --user stop luna-chat-server.service")
    expect(docs).toContain("incus config device remove luna-stable ws6753")
    expect(docs).toContain("incus config device add luna-stable ws4753")
    expect(docs).toContain("rollback")
  })
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
bun run test test/deploy-scripts.test.ts -t "documents stable container cutover"
```

Expected: fail because the docs do not yet contain the full stable cutover runbook.

- [ ] **Step 3: Add the stable cutover runbook**

Add a `## Stable Container Cutover` section to `docs/container-runtime.md` with these commands:

```bash
# 1. Build candidate stable container on temporary host ports.
scripts/luna-container-create \
  --profile stable \
  --name luna-stable \
  --repo git@github.com:fourcolors/luna.git \
  --branch master \
  --repo-path /root/luna/stable/repo \
  --state-path /root/.luna \
  --host jax-box \
  --host-ws-port 6753 \
  --host-control-port 6754 \
  --skip-clone

# 2. Verify candidate without touching the host stable service.
curl -fsS http://127.0.0.1:6753/healthz
luna chat --url ws://jax-box.local:6753/ui

# 3. Cut over the stable ports during a short maintenance window.
systemctl --user stop luna-chat-server.service
systemctl --user disable luna-chat-server.service
incus config device remove luna-stable ws6753
incus config device remove luna-stable control6754
incus config device add luna-stable ws4753 proxy listen=tcp:0.0.0.0:4753 connect=tcp:127.0.0.1:4753 bind=host
incus config device add luna-stable control4754 proxy listen=tcp:0.0.0.0:4754 connect=tcp:127.0.0.1:4754 bind=host
incus restart luna-stable

# 4. Verify stable after cutover.
curl -fsS http://127.0.0.1:4753/healthz
curl -fsS http://jax-box.local:4753/healthz
```

Add the rollback block:

```bash
incus config device remove luna-stable ws4753
incus config device remove luna-stable control4754
incus stop luna-stable
systemctl --user enable luna-chat-server.service
systemctl --user restart luna-chat-server.service
curl -fsS http://127.0.0.1:4753/healthz
```

- [ ] **Step 4: Add install guide pointers**

In `docs/install.md`, add the stable container example:

```bash
scripts/luna-container-create \
  --profile stable \
  --name luna-stable \
  --repo git@github.com:fourcolors/luna.git \
  --branch master \
  --repo-path /root/luna/stable/repo \
  --state-path /root/.luna \
  --host jax-box \
  --host-ws-port 6753 \
  --host-control-port 6754 \
  --skip-clone
```

In `README.md`, add a short pointer to `docs/container-runtime.md` for stable/dev container operations.

- [ ] **Step 5: Run the docs test**

Run:

```bash
bun run test test/deploy-scripts.test.ts -t "documents stable container cutover"
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add test/deploy-scripts.test.ts docs/container-runtime.md docs/install.md README.md
git commit -m "docs: add stable container cutover runbook"
```

## Task 2: Add Container Runtime And Dangerous Marker Support

**Files:**
- Modify: `scripts/luna-container-create`
- Modify: `test/deploy-scripts.test.ts`

- [ ] **Step 1: Write failing script tests**

Add these tests to `test/deploy-scripts.test.ts`:

```ts
  it("container dry-run writes an Incus runtime scope marker", () => {
    const temp = makeTempDir()
    const result = runScript("scripts/luna-container-create", [
      "--dry-run",
      "--profile",
      "stable",
      "--name",
      "luna-stable",
      "--repo-path",
      join(temp, "repo"),
      "--state-path",
      join(temp, "state"),
      "--token",
      "test-token-1234567890-secret",
    ])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("LUNA_RUNTIME_SCOPE=incus-container")
  })

  it("container dry-run can enable dangerous local shell marker explicitly", () => {
    const temp = makeTempDir()
    const result = runScript("scripts/luna-container-create", [
      "--dry-run",
      "--profile",
      "stable",
      "--name",
      "luna-stable",
      "--repo-path",
      join(temp, "repo"),
      "--state-path",
      join(temp, "state"),
      "--token",
      "test-token-1234567890-secret",
      "--enable-dangerous-local-shell",
    ])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("touch")
    expect(result.stdout).toContain("allow-dangerous-local-shell")
    expect(result.stdout).toContain("LUNA_STABLE_DANGEROUS_AUTO_APPROVE_LOCAL_SHELL=1")
  })
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
bun run test test/deploy-scripts.test.ts -t "runtime scope marker|dangerous local shell"
```

Expected: fail because the script has no dangerous marker flag and does not write `LUNA_RUNTIME_SCOPE`.

- [ ] **Step 3: Add the script flag**

In `scripts/luna-container-create`, add:

```bash
ENABLE_DANGEROUS_LOCAL_SHELL=false
```

Add usage text:

```text
  --enable-dangerous-local-shell
                               Write the marker and profile env that allow container-scoped local shell auto approval.
```

Add parser case:

```bash
    --enable-dangerous-local-shell) ENABLE_DANGEROUS_LOCAL_SHELL=true; shift ;;
```

- [ ] **Step 4: Write runtime and dangerous env markers**

After the existing `.env` writes in `scripts/luna-container-create`, add:

```bash
luna_upsert_env "$STATE_PATH/.env" "LUNA_RUNTIME_SCOPE" "incus-container"

if [[ "$ENABLE_DANGEROUS_LOCAL_SHELL" == true ]]; then
  luna_upsert_env "$STATE_PATH/.env" "LUNA_${PROFILE_ENV}_DANGEROUS_AUTO_APPROVE_LOCAL_SHELL" "1"
  luna_run touch "$STATE_PATH/allow-dangerous-local-shell"
  if [[ "$DRY_RUN" == false ]]; then
    chmod 0600 "$STATE_PATH/allow-dangerous-local-shell"
  fi
fi
```

- [ ] **Step 5: Run script tests**

Run:

```bash
bun run test test/deploy-scripts.test.ts
bash -n scripts/luna-container-create
```

Expected: all deployment script tests pass and shell syntax is valid.

- [ ] **Step 6: Commit**

```bash
git add scripts/luna-container-create test/deploy-scripts.test.ts
git commit -m "feat: add container dangerous shell markers"
```

## Task 3: Add Dangerous Auto-Approve Config Gates

**Files:**
- Modify: `apps/agent-cli/src/chat/args.ts`
- Modify: `apps/agent-cli/src/chat/config.ts`
- Modify: `apps/agent-cli/test/chat-config.test.ts`

- [ ] **Step 1: Write failing config tests**

Add these tests to `apps/agent-cli/test/chat-config.test.ts`. Also add these imports at the top of the file:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
```

```ts
  it("parses the dangerous auto-approve flag", () => {
    const args = parseChatArgs(["chat", "--dangerously-auto-approve-local-shell"])
    expect(args.unknown).toEqual([])
    expect(args.dangerouslyAutoApproveLocalShell).toBe(true)
  })

  it("rejects dangerous auto approval outside the Incus container scope", () => {
    const cfg = loadChatConfig({
      args: parseChatArgs(["chat", "--dangerously-auto-approve-local-shell"]),
      env: {
        LUNA_UI_WS_TOKEN: "env-token-123456",
      },
      dotenv: {},
      homeDir: "/tmp/home",
      cwd: "/Users/fourcolors/Projects/1_active/luna",
    })

    expect(cfg.dangerouslyAutoApproveLocalShell).toBe(false)
    expect(cfg.validationErrors).toContain(
      "dangerous local shell auto approval requires LUNA_RUNTIME_SCOPE=incus-container",
    )
    expect(cfg.validationErrors).toContain(
      "dangerous local shell auto approval requires cwd under /root/luna",
    )
  })

  it("accepts dangerous auto approval with runtime marker, marker file, and container cwd", () => {
    const home = mkdtempSync(join(tmpdir(), "luna-dangerous-home-"))
    try {
      mkdirSync(join(home, ".luna"), { recursive: true })
      writeFileSync(join(home, ".luna", "allow-dangerous-local-shell"), "")
      const cfg = loadChatConfig({
        args: parseChatArgs(["chat", "--local-shell"]),
        env: {
          LUNA_STABLE_DANGEROUS_AUTO_APPROVE_LOCAL_SHELL: "1",
          LUNA_UI_WS_TOKEN: "env-token-123456",
        },
        dotenv: {
          LUNA_RUNTIME_SCOPE: "incus-container",
        },
        homeDir: home,
        cwd: "/root/luna",
      })

      expect(cfg.dangerouslyAutoApproveLocalShell).toBe(true)
      expect(cfg.validationErrors).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
```

- [ ] **Step 2: Run failing config tests**

Run:

```bash
bun run --filter '@luna/agent-cli' test apps/agent-cli/test/chat-config.test.ts
```

Expected: fail because the flag and config field are not implemented.

- [ ] **Step 3: Add the parsed flag**

In `apps/agent-cli/src/chat/args.ts`, add `dangerouslyAutoApproveLocalShell?: boolean` to `ChatArgs` and the mutable `out` object. Add parser case:

```ts
      case "--dangerously-auto-approve-local-shell":
        out.dangerouslyAutoApproveLocalShell = true
        break
```

- [ ] **Step 4: Add config gates**

In `apps/agent-cli/src/chat/config.ts`, add `dangerouslyAutoApproveLocalShell: boolean` to `ChatConfig`. Add helpers near the other parsing helpers:

```ts
const isTruthy = (value: string | undefined): boolean =>
  value === "1" || value === "true" || value === "yes" || value === "on"

const isUnderRootLuna = (cwd: string): boolean =>
  cwd === "/root/luna" || cwd.startsWith("/root/luna/")
```

After `profiled` is available, load the dangerous setting:

```ts
  const dangerousAutoSetting = selectSetting([
    { name: "--dangerously-auto-approve-local-shell", value: input.args.dangerouslyAutoApproveLocalShell === true ? "1" : undefined },
    { name: profiled("DANGEROUS_AUTO_APPROVE_LOCAL_SHELL"), value: input.env[profiled("DANGEROUS_AUTO_APPROVE_LOCAL_SHELL")] },
    { name: profiled("DANGEROUS_AUTO_APPROVE_LOCAL_SHELL"), value: input.dotenv[profiled("DANGEROUS_AUTO_APPROVE_LOCAL_SHELL")] },
    { name: "LUNA_DANGEROUS_AUTO_APPROVE_LOCAL_SHELL", value: input.env["LUNA_DANGEROUS_AUTO_APPROVE_LOCAL_SHELL"] },
    { name: "LUNA_DANGEROUS_AUTO_APPROVE_LOCAL_SHELL", value: input.dotenv["LUNA_DANGEROUS_AUTO_APPROVE_LOCAL_SHELL"] },
  ])
  const dangerousRequested = dangerousAutoSetting !== undefined && isTruthy(dangerousAutoSetting.value)
  const runtimeScope = selectSetting([
    { name: "LUNA_RUNTIME_SCOPE", value: input.env["LUNA_RUNTIME_SCOPE"] },
    { name: "LUNA_RUNTIME_SCOPE", value: input.dotenv["LUNA_RUNTIME_SCOPE"] },
  ])?.value
  const dangerousMarkerPath = join(input.homeDir, ".luna", "allow-dangerous-local-shell")
  let dangerouslyAutoApproveLocalShell = false
  if (dangerousRequested) {
    if (runtimeScope !== "incus-container") {
      errors.push("dangerous local shell auto approval requires LUNA_RUNTIME_SCOPE=incus-container")
    }
    if (!existsSync(dangerousMarkerPath)) {
      errors.push("dangerous local shell auto approval requires ~/.luna/allow-dangerous-local-shell")
    }
    if (!isUnderRootLuna(input.cwd)) {
      errors.push("dangerous local shell auto approval requires cwd under /root/luna")
    }
    dangerouslyAutoApproveLocalShell =
      runtimeScope === "incus-container" &&
      existsSync(dangerousMarkerPath) &&
      isUnderRootLuna(input.cwd)
  }
```

Return `dangerouslyAutoApproveLocalShell` from `loadChatConfig`, and add it to `redactedConfigSummary`:

```ts
    `localShellApproval=${cfg.dangerouslyAutoApproveLocalShell ? "auto" : "prompt"}`,
```

- [ ] **Step 5: Run config tests**

Run:

```bash
bun run --filter '@luna/agent-cli' test apps/agent-cli/test/chat-config.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-cli/src/chat/args.ts apps/agent-cli/src/chat/config.ts apps/agent-cli/test/chat-config.test.ts
git commit -m "feat(cli): gate dangerous local shell approval"
```

## Task 4: Execute Auto-Approved Local Shell Requests

**Files:**
- Modify: `apps/agent-cli/src/chat/local-shell.ts`
- Modify: `apps/agent-cli/src/chat/app.ts`
- Modify: `apps/agent-cli/test/chat-app.integration.test.ts`

- [ ] **Step 1: Write failing integration test**

Add `mkdirSync` and `writeFileSync` to the existing `node:fs` import in `apps/agent-cli/test/chat-app.integration.test.ts`, then add this test near the existing local shell tests:

```ts
  it("auto-approves local shell requests only when dangerous mode is configured", async () => {
    const home = isolatedHomeDir()
    mkdirSync(join(home, ".luna"), { recursive: true })
    writeFileSync(join(home, ".luna", "allow-dangerous-local-shell"), "")

    server = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => server?.once("listening", resolve))
    const address = server.address() as AddressInfo
    const approveLocalCommand = vi.fn(async () => false)
    const received: ClientFrame[] = []
    let resolveResult!: (frame: ClientFrame) => void
    const resultFrame = new Promise<ClientFrame>((resolve) => {
      resolveResult = resolve
    })

    server.on("connection", (socket) => {
      socket.send(JSON.stringify(helloFrame))
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as ClientFrame
        received.push(frame)
        if (frame.type === "new-thread") {
          socket.send(JSON.stringify({ type: "thread-created", thread: thread("thr_danger") } satisfies ServerFrame))
        }
        if (frame.type === "local-shell-capability" && frame.enabled) {
          expect(frame.approvalMode).toBe("auto")
          socket.send(JSON.stringify({
            type: "local-shell-request",
            requestId: "req-danger",
            threadId: "thr_danger",
            command: "printf dangerous-ok",
          } satisfies ServerFrame))
        }
        if (frame.type === "local-shell-result") resolveResult(frame)
      })
    })

    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()

    const done = runLunaCli(["chat", "--local-shell", "--url", `ws://127.0.0.1:${address.port}/ui`], {
      stdin,
      stdout,
      stderr,
      env: {
        LUNA_UI_WS_TOKEN: "test-token",
        LUNA_RUNTIME_SCOPE: "incus-container",
        LUNA_DANGEROUS_AUTO_APPROVE_LOCAL_SHELL: "1",
      },
      homeDir: home,
      cwd: "/root/luna",
      approveLocalCommand,
    })

    const result = await waitFor(resultFrame)
    expect(result).toMatchObject({
      type: "local-shell-result",
      requestId: "req-danger",
      approved: true,
      stdout: "dangerous-ok",
      timedOut: false,
    })
    expect(approveLocalCommand).not.toHaveBeenCalled()
    expect(received).toContainEqual({
      type: "local-shell-capability",
      threadId: "thr_danger",
      enabled: true,
      approvalMode: "auto",
      clientId: expect.any(String),
      platform: process.platform,
      cwd: "/root/luna",
    })

    stdin.write("/quit\n")
    stdin.end()
    await expect(waitFor(done, 500)).resolves.toEqual({ exitCode: 0 })
  })
```

- [ ] **Step 2: Run failing integration test**

Run:

```bash
bun run --filter '@luna/agent-cli' test apps/agent-cli/test/chat-app.integration.test.ts -t "auto-approves local shell"
```

Expected: fail because `approvalMode` and auto approval are not implemented.

- [ ] **Step 3: Add approval mode to local shell state**

In `apps/agent-cli/src/chat/local-shell.ts`, add:

```ts
export type LocalShellApprovalMode = "prompt" | "auto"
```

Add `approvalMode: LocalShellApprovalMode` to `LocalShellState` and `MakeLocalShellStateOptions`. Update `makeLocalShellState`:

```ts
export const makeLocalShellState = (
  options: MakeLocalShellStateOptions,
): LocalShellState => ({
  enabled: options.enabled,
  cwd: options.cwd,
  approvalMode: options.approvalMode,
  clientId: `cli_${randomUUID().replaceAll("-", "")}`,
  platform: process.platform,
})
```

- [ ] **Step 4: Use auto approval when configured**

In `apps/agent-cli/src/chat/app.ts`, update local shell state construction:

```ts
  let localShell = makeLocalShellState({
    enabled: cfg.localShellInitial,
    cwd: cfg.cwd,
    approvalMode: cfg.dangerouslyAutoApproveLocalShell ? "auto" : "prompt",
  })
```

Update `sendLocalShellCapability` to include:

```ts
    approvalMode: localShell.approvalMode,
```

Update `executeLocalCommand` call:

```ts
        approve: cfg.dangerouslyAutoApproveLocalShell
          ? async () => true
          : io.approveLocalCommand ?? (async () => false),
```

- [ ] **Step 5: Run local shell tests**

Run:

```bash
bun run --filter '@luna/agent-cli' test apps/agent-cli/test/chat-app.integration.test.ts apps/agent-cli/test/local-shell.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-cli/src/chat/local-shell.ts apps/agent-cli/src/chat/app.ts apps/agent-cli/test/chat-app.integration.test.ts
git commit -m "feat(cli): support dangerous auto-approved local shell"
```

## Task 5: Preserve Approval Mode Through The Server Bridge

**Files:**
- Modify: `packages/ui-ws/src/protocol.ts`
- Modify: `packages/ui-ws/test/local-shell-bridge.test.ts`
- Modify: `packages/local-shell-tools/src/layer.ts`

- [ ] **Step 1: Write failing bridge test**

Add this assertion to an existing enabled-capability test in `packages/ui-ws/test/local-shell-bridge.test.ts`:

```ts
    const accepted = bridge.setCapability({
      type: "local-shell-capability",
      threadId: "thread-1",
      enabled: true,
      clientId: "client-1",
      platform: "linux",
      cwd: "/root/luna",
      approvalMode: "auto",
    }, send)

    expect(accepted.accepted).toBe(true)
    expect(bridge.getCapability("thread-1")?.approvalMode).toBe("auto")
```

- [ ] **Step 2: Run failing bridge test**

Run:

```bash
bun run test packages/ui-ws/test/local-shell-bridge.test.ts
```

Expected: fail at typecheck or test compile because `approvalMode` is not in the protocol type.

- [ ] **Step 3: Add protocol field**

In `packages/ui-ws/src/protocol.ts`, update `LocalShellCapabilityFrame`:

```ts
  readonly approvalMode?: "prompt" | "auto"
```

Keep it optional so older clients remain compatible.

- [ ] **Step 4: Update model prompt text**

In `packages/local-shell-tools/src/layer.ts`, replace the sentence about mandatory approval:

```ts
  "Commands normally require explicit user approval in that terminal before they run. " +
  "A trusted container session may advertise auto approval; in that mode commands run " +
  "inside the attached container without a per-command prompt. " +
```

- [ ] **Step 5: Run UI and local-shell tool tests**

Run:

```bash
bun run test packages/ui-ws/test/local-shell-bridge.test.ts packages/local-shell-tools/test/tools.test.ts packages/local-shell-tools/test/mcp-structure.test.ts
bun run typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 6: Commit**

```bash
git add packages/ui-ws/src/protocol.ts packages/ui-ws/test/local-shell-bridge.test.ts packages/local-shell-tools/src/layer.ts
git commit -m "feat: advertise local shell approval mode"
```

## Task 6: Cut Over Stable On jax-box

**Files:**
- Runtime operation only. No repo files should change during this task unless verification finds a documentation bug.

- [ ] **Step 1: Confirm current host state**

Run from the Mac:

```bash
ssh root@jax-box.local 'bash -lc "
set -euo pipefail
incus list
systemctl --user show luna-chat-server.service -p ActiveState -p ExecStart -p WorkingDirectory --no-pager
ss -ltnp \"( sport = :4753 or sport = :4754 or sport = :6753 or sport = :6754 )\"
git -C /root/luna/stable/repo status --short --branch
"'
```

Expected:

- Host stable service is active before cutover.
- Stable repo is clean on `master`.
- Ports `4753/4754` are owned by the host stable process.
- Ports `6753/6754` are free.

- [ ] **Step 2: Pull the latest dev/master code onto jax-box**

After the implementation branch is merged to `master`, run:

```bash
ssh root@jax-box.local 'bash -lc "
set -euo pipefail
git -C /root/luna/stable/repo fetch origin master
git -C /root/luna/stable/repo checkout master
git -C /root/luna/stable/repo pull --ff-only origin master
/root/.bun/bin/bun install --cwd /root/luna/stable/repo --frozen-lockfile
"'
```

Expected: fast-forward pull or already up to date; Bun install succeeds.

- [ ] **Step 3: Create the stable container candidate**

Run:

```bash
ssh root@jax-box.local 'bash -lc "
set -euo pipefail
cd /root/luna/stable/repo
scripts/luna-container-create \
  --profile stable \
  --name luna-stable \
  --repo git@github.com:fourcolors/luna.git \
  --branch master \
  --repo-path /root/luna/stable/repo \
  --state-path /root/.luna \
  --host jax-box \
  --host-ws-port 6753 \
  --host-control-port 6754 \
  --skip-clone \
  --enable-dangerous-local-shell
"'
```

Expected: container starts, cloud-init finishes, and `luna-chat-server.service` is active inside `luna-stable`.

- [ ] **Step 4: Verify candidate server and dangerous mode**

Run:

```bash
ssh root@jax-box.local 'curl -fsS http://127.0.0.1:6753/healthz'
ssh root@jax-box.local 'incus exec luna-stable -- test -f /root/.luna/allow-dangerous-local-shell'
ssh root@jax-box.local 'incus exec luna-stable -- grep -E "^(LUNA_RUNTIME_SCOPE|LUNA_STABLE_DANGEROUS_AUTO_APPROVE_LOCAL_SHELL)=" /root/.luna/.env'
```

Expected:

- Health endpoint returns success.
- Marker file exists.
- `.env` contains `LUNA_RUNTIME_SCOPE=incus-container` and `LUNA_STABLE_DANGEROUS_AUTO_APPROVE_LOCAL_SHELL=1`.

- [ ] **Step 5: Test an interactive dangerous session inside the container**

Run an interactive command from the Mac:

```bash
ssh -t root@jax-box.local 'incus exec luna-stable -- bash -lc "cd /root/luna && /root/.bun/bin/bun run --filter @luna/agent-cli luna -- chat --url ws://127.0.0.1:4753/ui --local-shell --dangerously-auto-approve-local-shell"'
```

In the chat, ask:

```text
Run pwd and whoami with the local shell.
```

Expected:

- Luna can run the command without a per-command approval prompt.
- Output shows `pwd` under `/root/luna` and `whoami` as `root`.

- [ ] **Step 6: Cut over stable ports**

Run:

```bash
ssh root@jax-box.local 'bash -lc "
set -euo pipefail
systemctl --user stop luna-chat-server.service
systemctl --user disable luna-chat-server.service
incus config device remove luna-stable ws6753
incus config device remove luna-stable control6754
incus config device add luna-stable ws4753 proxy listen=tcp:0.0.0.0:4753 connect=tcp:127.0.0.1:4753 bind=host
incus config device add luna-stable control4754 proxy listen=tcp:0.0.0.0:4754 connect=tcp:127.0.0.1:4754 bind=host
incus restart luna-stable
incus exec luna-stable -- systemctl is-active luna-chat-server.service
"'
```

Expected: service is active inside the container and host stable service stays disabled.

- [ ] **Step 7: Verify primary and fallback access**

Run:

```bash
curl -fsS http://jax-box:4753/healthz
curl -fsS http://jax-box.local:4753/healthz
luna chat --url ws://jax-box:4753/ui
luna chat --url ws://jax-box.local:4753/ui
```

Expected: both health checks pass and both chat URLs connect.

- [ ] **Step 8: Update local recovery command**

Edit `/Users/fourcolors/.luna/.env` so stable recovery restarts the container service:

```bash
LUNA_STABLE_START_MODE=ssh
LUNA_STABLE_START_COMMAND=incus exec luna-stable -- systemctl restart luna-chat-server.service
LUNA_STABLE_START_SSH=root@jax-box
LUNA_STABLE_FALLBACK_START_SSH=root@jax-box.local
```

Expected: `luna chat` can recover stable by restarting the service inside `luna-stable`.

- [ ] **Step 9: Record rollback command in the operational notes**

If cutover fails, run:

```bash
ssh root@jax-box.local 'bash -lc "
set -euo pipefail
incus config device remove luna-stable ws4753 || true
incus config device remove luna-stable control4754 || true
incus stop luna-stable || true
systemctl --user enable luna-chat-server.service
systemctl --user restart luna-chat-server.service
curl -fsS http://127.0.0.1:4753/healthz
"'
```

Expected: host stable service owns `4753/4754` again.

## Task 7: Full Verification And Merge

**Files:**
- No new files unless verification exposes an issue.

- [ ] **Step 1: Run local verification**

Run:

```bash
bun run typecheck
bun run --filter '@luna/agent-cli' test
bun run test test/deploy-scripts.test.ts packages/ui-ws/test/local-shell-bridge.test.ts packages/local-shell-tools/test/tools.test.ts packages/local-shell-tools/test/mcp-structure.test.ts
git diff --check
```

Expected: all pass.

- [ ] **Step 2: Push dev**

Run:

```bash
git status --short --branch
git push origin dev
```

Expected: dev branch is clean and pushed.

- [ ] **Step 3: Merge dev to master**

Run:

```bash
git checkout master
git pull --ff-only origin master
git merge --ff-only dev
git push origin master
git checkout dev
```

Expected: master fast-forwards to dev and both branches contain the stable-container/dangerous-mode work.

- [ ] **Step 4: Install live stable**

Run Task 6 after `master` is pushed.

Expected: stable Luna runs in `luna-stable`, dev remains in `luna-dev`, and `luna chat` connects to stable on `4753`.

## Future Host-Control Bridge

Do this only after stable-container dangerous mode is working:

- Add a host-side command bridge that runs selected Incus operations through SSH.
- Prefer a forced-command SSH key or a small host script over mounting the Incus socket into the container.
- Document that this grants host-level authority even if the command starts inside `luna-stable`.

Concrete first host bridge command set:

```text
incus list
incus start luna-dev
incus stop luna-dev
incus restart luna-dev
incus exec luna-dev -- systemctl restart luna-dev-chat-server.service
```

## Self-Review

- Spec coverage: stable moves into Incus; dangerous mode is explicit and container-scoped; Tailscale/LAN access stays through existing host proxies; rollback is included.
- Vagueness scan: every task has concrete files, commands, and expected results.
- Type consistency: `dangerouslyAutoApproveLocalShell` is used consistently in args/config/app tests; `approvalMode` is optional in the protocol and required in local shell state.
