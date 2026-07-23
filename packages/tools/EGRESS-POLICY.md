# Egress Allowlist Policy

Pitch: https://github.com/fourcolors/luna/issues/244
v1 wiring: https://github.com/fourcolors/luna/issues/247

## The problem

Luna agents hold three capabilities that combine into an exfiltration channel:

1. **Local filesystem read** — `Read`, `Grep`, `Glob` can pull any file the server process can open.
2. **Unrailed web egress** — `WebFetch` and `WebSearch` can reach any host.
3. **Untrusted content** — prompt injection or malicious file content can redirect agent behaviour.

The existing safety rails in `interception.ts` explicitly note they do not cover web egress. `egressAllowlist` closes that gap.

## What `egressAllowlist` does

`egressAllowlist` is a `ToolInterceptor` that enforces a host allowlist on egress-class tools:

- **Non-egress tools** — returns `"pass"` immediately; `onDecision` is not called.
- **Subagent / background-job** — denies all egress unconditionally (rule: `subject-no-egress`).
- **WebFetch** — parses `input.url`, extracts the hostname, allows only if the hostname matches an `allowedHosts` entry (exact or suffix: `"github.com"` permits `"api.github.com"`). Malformed or missing URLs are denied (fail-closed, rule: `egress-no-target`).
- **WebSearch** — requires `input.allowed_domains` to be a non-empty string array where every entry passes the same suffix check. Absent or partially-allowlisted arrays are denied.
- **Network MCP tools** — names matching `mcp__…__(web_fetch|http_request|fetch_url|…)` are classified as egress; the host is taken from common input keys (`url`, `uri`, `host`, `endpoint`, …).
- **`onDecision`** — called exactly once per egress evaluation (allow and deny alike) with a full `EgressDecision` audit record.

## Live wiring (chat-server, #247)

Production installs the policy at boot:

1. **`canUseTool` chain** — `egressAllowlist` is first in `composeInterceptors` (before secret-path / dangerous-command rails and `mcpToolGate`).
2. **`PreToolUse` hook** — `makeEgressPreToolUseHook` runs on every tool call, including auto-approved `mcp__*` tools that skip `canUseTool`.
3. **Config** — `LUNA_EGRESS_ALLOWED_HOSTS` (comma-separated host suffixes). Unset/empty → research-friendly defaults (`DEFAULT_EGRESS_ALLOWED_HOSTS`). `"*"` → allow all hosts (explicit opt-out).
4. **Audit** — each decision is written as a one-line `[luna/tool-acl]` record on stdout (journald / events pipeline).

### Subject note

The live gate currently installs with `subject: "main-thread"`. The interceptor still enforces subagent / background-job deny-all when a non-main subject is passed; call-context subject plumbing (per-subagent / per-job) is a follow-up once the adapter exposes subject on the permission callback.

## Plugging into `composeInterceptors`

```ts
const policy = composeInterceptors([
  egressAllowlist({
    allowedHosts: parseEgressAllowedHosts(process.env.LUNA_EGRESS_ALLOWED_HOSTS),
    subject: "main-thread",
    onDecision: (d) => console.log("egress-acl", d),
  }),
  denySecretPaths(),
])
```

Place `egressAllowlist` early — `composeInterceptors` uses first-wins semantics.

## Subject defaults

| `subject`          | Egress |
|--------------------|--------|
| `"main-thread"`    | Checked against `allowedHosts` |
| `"subagent"`       | Always denied |
| `"background-job"` | Always denied |

Omitting `subject` defaults to `"main-thread"`.

## `onDecision` audit record

Each `EgressDecision` carries: `subject`, `tool`, `effectClass` (always `"egress"`), `target` (hostname, joined domains, or `null`), `decision` (`"allow"` | `"deny"`), and `rule` (machine-readable rule ID).

## What to survey after deploy

1. Boot log shows `[luna/tool-acl] egress allow-list active (N host suffix(es))`.
2. In a live thread, `WebFetch` to an allow-listed host succeeds; to an off-list host is denied with a tool-acl message.
3. `WebSearch` without `allowed_domains` (or with an off-list domain) is denied.
4. A network MCP tool (e.g. `mcp__…__web_fetch`) is denied off-list via PreToolUse even if pre-approved.
5. Journal / stdout contains `[luna/tool-acl] allow|deny …` lines for those calls.
