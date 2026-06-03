import { describe, expect, it } from "vitest"
import {
  doctorChatArgs,
  healthzUrlFor,
  type ProbeOutcomes,
  redactUrl,
  renderVerdicts,
} from "../src/commands/doctor.js"

const ctx = { profileName: "stable", url: "ws://127.0.0.1:4753/ui" }

const reportFor = (outcomes: ProbeOutcomes) => renderVerdicts(outcomes, ctx)

describe("luna doctor — renderVerdicts (pure)", () => {
  it("all-green (L4 ok) → exit 0 and a PASS summary, all layers shown", () => {
    const r = reportFor({
      reach: { kind: "ok" },
      token: { kind: "ok" },
      mode: { kind: "chat", protocolVersion: 2 },
      chat: { kind: "ok" },
    })
    expect(r.exitCode).toBe(0)
    const text = r.lines.join("\n")
    expect(text).toContain("[ OK ] L1 REACH")
    expect(text).toContain("[ OK ] L2 TOKEN")
    expect(text).toContain("[ OK ] L3 MODE   chat ready (protocol v2)")
    expect(text).toContain("[ OK ] L4 CHAT")
    expect(text).toContain("[ OK ] PASS")
  })

  it("L1 refused → exit 1, deeper layers skipped (not run)", () => {
    const r = reportFor({ reach: { kind: "refused" } })
    expect(r.exitCode).toBe(1)
    const text = r.lines.join("\n")
    expect(text).toContain("[FAIL] L1 REACH")
    expect(text).toContain("server DOWN")
    expect(text).toContain("[ -- ] L2 TOKEN  skipped")
    expect(text).toContain("[ -- ] L3 MODE   skipped")
    expect(text).toContain("[ -- ] L4 CHAT   skipped")
    expect(text).toContain("[FAIL] FAIL at L1 REACH")
  })

  it("L1 unreachable → Tailscale/host remedy", () => {
    const r = reportFor({ reach: { kind: "unreachable", detail: "timeout after 3000ms" } })
    expect(r.exitCode).toBe(1)
    expect(r.lines.join("\n")).toContain("Tailscale")
  })

  it("L1 ok but bad /healthz status → wrong-URL remedy", () => {
    const r = reportFor({ reach: { kind: "bad-status", status: 502 }, token: undefined })
    expect(r.exitCode).toBe(1)
    expect(r.lines.join("\n")).toContain("/healthz returned 502")
  })

  it("L2 missing token → configure remedy referencing the profile env var", () => {
    const r = reportFor({ reach: { kind: "ok" }, token: { kind: "missing" } })
    expect(r.exitCode).toBe(1)
    const text = r.lines.join("\n")
    expect(text).toContain("[ OK ] L1 REACH")
    expect(text).toContain("[FAIL] L2 TOKEN")
    expect(text).toContain("LUNA_STABLE_UI_WS_TOKEN")
    expect(text).toContain("[ -- ] L3 MODE   skipped")
  })

  it("L2 rejected (the rotated-token failure) → re-pair remedy, distinct from L1", () => {
    const r = reportFor({
      reach: { kind: "ok" },
      token: { kind: "rejected", detail: "Connection ended" },
    })
    expect(r.exitCode).toBe(1)
    const text = r.lines.join("\n")
    expect(text).toContain("[ OK ] L1 REACH")
    expect(text).toContain("token REJECTED")
    expect(text).toContain("re-pair")
    expect(text).toContain("[FAIL] FAIL at L2 TOKEN")
  })

  it("L2 timeout → handshake-hung remedy", () => {
    const r = reportFor({ reach: { kind: "ok" }, token: { kind: "timeout" } })
    expect(r.exitCode).toBe(1)
    expect(r.lines.join("\n")).toContain("upgrade hung")
  })

  it("L3 setup-mode → Claude login remedy, L1/L2 still green", () => {
    const r = reportFor({
      reach: { kind: "ok" },
      token: { kind: "ok" },
      mode: { kind: "setup", protocolVersion: 2 },
      chat: { kind: "skipped" },
    })
    expect(r.exitCode).toBe(1)
    const text = r.lines.join("\n")
    expect(text).toContain("[ OK ] L1 REACH")
    expect(text).toContain("[ OK ] L2 TOKEN")
    expect(text).toContain("SETUP MODE")
    expect(text).toContain("claude setup-token")
    expect(text).toContain("[FAIL] FAIL at L3 MODE")
  })

  it("L3 no-hello → idle-OAuth/wedged remedy (distinct from token reject)", () => {
    const r = reportFor({
      reach: { kind: "ok" },
      token: { kind: "ok" },
      mode: { kind: "no-hello" },
      chat: { kind: "skipped" },
    })
    expect(r.exitCode).toBe(1)
    expect(r.lines.join("\n")).toContain("server not responding")
  })

  it("chat-ready with unknown protocol version omits the version suffix", () => {
    const r = reportFor({
      reach: { kind: "ok" },
      token: { kind: "ok" },
      mode: { kind: "chat", protocolVersion: null },
      chat: { kind: "ok" },
    })
    expect(r.exitCode).toBe(0)
    expect(r.lines.join("\n")).toContain("chat ready")
    expect(r.lines.join("\n")).not.toContain("protocol v")
  })

  it("first failing layer drives the summary even when a later layer also fails", () => {
    // L2 missing means L3 is never run; but assert ordering precedence directly.
    const r = reportFor({
      reach: { kind: "ok" },
      token: { kind: "rejected", detail: "x" },
      mode: { kind: "no-hello" },
    })
    expect(r.lines.find((l) => l.startsWith("[FAIL] FAIL"))).toContain("L2 TOKEN")
  })

  // --- L4 CHAT outcome tests ---

  it("L4 ok → exit 0, probe success line present", () => {
    const r = reportFor({
      reach: { kind: "ok" },
      token: { kind: "ok" },
      mode: { kind: "chat", protocolVersion: 2 },
      chat: { kind: "ok" },
    })
    expect(r.exitCode).toBe(0)
    const text = r.lines.join("\n")
    expect(text).toContain("[ OK ] L4 CHAT")
    expect(text).toContain("assistant responded")
  })

  it("L4 auth-error → exit 1, setup-token remedy present", () => {
    const r = reportFor({
      reach: { kind: "ok" },
      token: { kind: "ok" },
      mode: { kind: "chat", protocolVersion: 2 },
      chat: { kind: "auth-error", detail: "adapter stream failed: OAuth token expired" },
    })
    expect(r.exitCode).toBe(1)
    const text = r.lines.join("\n")
    expect(text).toContain("[FAIL] L4 CHAT")
    expect(text).toContain("claude setup-token")
    expect(text).toContain("[FAIL] FAIL at L4 CHAT")
  })

  it("L4 other-error → exit 1, unexpected-failure line", () => {
    const r = reportFor({
      reach: { kind: "ok" },
      token: { kind: "ok" },
      mode: { kind: "chat", protocolVersion: 2 },
      chat: { kind: "other-error", detail: "idle: session idle timeout" },
    })
    expect(r.exitCode).toBe(1)
    const text = r.lines.join("\n")
    expect(text).toContain("[FAIL] L4 CHAT")
    expect(text).toContain("chat turn failed unexpectedly")
    expect(text).toContain("[FAIL] FAIL at L4 CHAT")
  })

  it("L4 timeout → SOFT WARN, exit 0 (slow turn != broken server; don't cry wolf)", () => {
    const r = reportFor({
      reach: { kind: "ok" },
      token: { kind: "ok" },
      mode: { kind: "chat", protocolVersion: 2 },
      chat: { kind: "timeout" },
    })
    // A slow first turn (cold start) must NOT be a hard failure — the server is
    // otherwise green (L1-L3 ok), so exit 0 with a WARN, not exit 1.
    expect(r.exitCode).toBe(0)
    const text = r.lines.join("\n")
    expect(text).toContain("[WARN] L4 CHAT")
    expect(text).toContain("re-run")
    expect(text).not.toContain("[FAIL] FAIL at L4 CHAT")
  })

  it("L4 skipped (mode != chat) → not a failure, exit driven by L3", () => {
    const r = reportFor({
      reach: { kind: "ok" },
      token: { kind: "ok" },
      mode: { kind: "setup", protocolVersion: 2 },
      chat: { kind: "skipped" },
    })
    // Exit is 1 because L3 failed, but L4 skipped line does not add a FAIL.
    expect(r.exitCode).toBe(1)
    const text = r.lines.join("\n")
    expect(text).toContain("[ -- ] L4 CHAT   skipped — server not in chat mode")
    // Failure is attributed to L3, not L4.
    expect(r.lines.find((l) => l.startsWith("[FAIL] FAIL"))).toContain("L3 MODE")
  })

  it("L4 undefined (L3 not run) → skipped line, no failure attribution", () => {
    const r = reportFor({
      reach: { kind: "ok" },
      token: { kind: "ok" },
      // no mode, no chat
    })
    const text = r.lines.join("\n")
    expect(text).toContain("[ -- ] L4 CHAT   skipped — connection not established")
  })
})

describe("luna doctor — redactUrl (pure)", () => {
  it("strips query string containing a token param", () => {
    expect(redactUrl("ws://host:4753/ui?token=secret")).toBe("ws://host:4753/ui")
  })

  it("returns the url unchanged when there is no query string", () => {
    expect(redactUrl("ws://host:4753/ui")).toBe("ws://host:4753/ui")
  })

  it("strips any query string, not just token=", () => {
    expect(redactUrl("ws://host/ui?foo=1&bar=2")).toBe("ws://host/ui")
  })

  it("header line uses redacted url (no query string in output)", () => {
    const r = renderVerdicts(
      { reach: { kind: "ok" }, token: { kind: "ok" }, mode: { kind: "chat", protocolVersion: 1 }, chat: { kind: "ok" } },
      { profileName: "stable", url: "ws://host:4753/ui?token=topsecret" },
    )
    const header = r.lines[0]!
    expect(header).not.toContain("topsecret")
    expect(header).not.toContain("?")
    expect(header).toContain("ws://host:4753/ui")
  })
})

describe("luna doctor — healthzUrlFor (pure)", () => {
  it("maps ws→http and rewrites the path to /healthz, dropping query", () => {
    expect(healthzUrlFor("ws://127.0.0.1:4753/ui")).toBe("http://127.0.0.1:4753/healthz")
    expect(healthzUrlFor("ws://host:4753/ui?token=secret")).toBe("http://host:4753/healthz")
  })

  it("maps wss→https", () => {
    expect(healthzUrlFor("wss://luna.example:443/ui")).toBe("https://luna.example/healthz")
  })
})

describe("luna doctor — doctorChatArgs (pure)", () => {
  it("--dev maps to profile=dev", () => {
    expect(doctorChatArgs({ dev: true })).toMatchObject({ command: "chat", profile: "dev" })
  })

  it("explicit --profile wins when --dev is absent", () => {
    expect(doctorChatArgs({ profile: "stable" })).toMatchObject({ profile: "stable" })
  })

  it("--dev takes precedence over --profile (matches chat alias semantics)", () => {
    expect(doctorChatArgs({ dev: true, profile: "stable" })).toMatchObject({ profile: "dev" })
  })

  it("passes through url / fallback-url / token; omits absent keys", () => {
    expect(doctorChatArgs({ url: "ws://x/ui", "fallback-url": "ws://y/ui", token: "t" })).toEqual({
      command: "chat",
      unknown: [],
      url: "ws://x/ui",
      fallbackUrl: "ws://y/ui",
      token: "t",
    })
    expect(doctorChatArgs({})).toEqual({ command: "chat", unknown: [] })
  })
})
