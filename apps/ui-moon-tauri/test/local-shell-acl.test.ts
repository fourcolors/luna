/**
 * local-shell-acl.test.ts
 *
 * Behavior: the Tauri capability ACL must authorize `local_shell_exec` for
 * EVERY window a chat panel can occupy - the singleton `panel-chat` AND the
 * parallel-thread instances `panel-chat-<hash>` minted by panel_instance_label
 * (src-tauri/src/main.rs) when the title-bar "+" opens a chat panel WITH params
 * (frontend/chat.html ~L9193). Non-chat system panels must stay denied
 * (least privilege).
 *
 * Why this is the right surface: Tauri enforces command permissions per WINDOW
 * LABEL, before the command body runs. Granting `allow-local-shell-exec` only
 * to the exact `panel-chat` label means a parallel-thread panel (label
 * `panel-chat-<hash>`, which matches only the shell-LESS `panel-*` glob in
 * panels.json) is rejected with "Command local_shell_exec not allowed by ACL"
 * even when the operator enabled machine access. This suite is a pure config
 * invariant - it parses the committed capability JSON and replays Tauri's
 * window-label glob match, so it needs no running app. (Full runtime ACL
 * enforcement is integration-only.)
 */
import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"

const capDir = path.resolve(__dirname, "../src-tauri/capabilities")
const SHELL_PERMISSION = "allow-local-shell-exec"

type Capability = { windows?: string[]; permissions?: string[] }

function readCap(name: string): Capability {
  return JSON.parse(fs.readFileSync(path.join(capDir, name + ".json"), "utf8"))
}

/**
 * Tauri matches a window label against a capability's `windows` entries using
 * glob semantics where `*` matches any run of characters. `panel-chat` is an
 * exact match; `panel-*` and `panel-chat-*` are globs.
 */
function windowGlobMatches(pattern: string, label: string): boolean {
  const rx = new RegExp(
    "^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
  )
  return rx.test(label)
}

/**
 * Replays the runtime ACL: does ANY capability that grants the shell permission
 * have a `windows` entry matching this label? Mirrors panel_instance_label by
 * accepting concrete instance labels like `panel-chat-1f4e9c`.
 */
function aclGrantsShell(label: string): boolean {
  return ["default", "chat", "panels", "connectors", "widgets"].some((name) => {
    let cap: Capability
    try {
      cap = readCap(name)
    } catch {
      return false
    }
    if (!(cap.permissions || []).includes(SHELL_PERMISSION)) return false
    return (cap.windows || []).some((w) => windowGlobMatches(w, label))
  })
}

// A representative parallel-thread instance label: panel_label('chat') + '-' +
// a djb2 hex of the params. The exact hash is irrelevant - any `panel-chat-*`.
const INSTANCE_LABEL = "panel-chat-1f4e9c"

describe("Feature: local shell ACL covers every chat-panel window", () => {
  it("B1 [green guard] Given the singleton chat panel, When the ACL is evaluated, Then shell is granted to label panel-chat", () => {
    expect(aclGrantsShell("panel-chat")).toBe(true)
  })

  it("B2 [green guard] Given the main hub window, When the ACL is evaluated, Then shell is granted to label main", () => {
    expect(aclGrantsShell("main")).toBe(true)
  })

  it("B3 [RED->green] Given a parallel-thread chat panel (panel-chat-<hash>), When the ACL is evaluated, Then shell is granted to that instance label", () => {
    expect(aclGrantsShell(INSTANCE_LABEL)).toBe(true)
  })

  it("B4 [green guard / least privilege] Given a non-chat system panel, When the ACL is evaluated, Then shell is NOT granted", () => {
    // If a fix over-grants by adding shell to panels.json's panel-* glob, these flip to true and fail.
    expect(aclGrantsShell("panel-settings")).toBe(false)
    expect(aclGrantsShell("panel-now")).toBe(false)
    expect(aclGrantsShell("panel-actions")).toBe(false)
  })

  it("B5 [green guard] the chat capability is the one that carries shell for chat panels (config wiring)", () => {
    const chat = readCap("chat")
    expect(chat.permissions || []).toContain(SHELL_PERMISSION)
    // The glob matcher itself must be sound: panel-chat-* must not leak to siblings.
    expect(windowGlobMatches("panel-chat-*", INSTANCE_LABEL)).toBe(true)
    expect(windowGlobMatches("panel-chat-*", "panel-settings")).toBe(false)
    expect(windowGlobMatches("panel-chat", INSTANCE_LABEL)).toBe(false)
  })
})
