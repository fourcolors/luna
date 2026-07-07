# Egress Allowlist Policy

Pitch: https://github.com/fourcolors/luna/issues/244

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
- **`onDecision`** — called exactly once per egress evaluation (allow and deny alike) with a full `EgressDecision` audit record.

## Plugging into `composeInterceptors`

```ts
const policy = composeInterceptors([
  egressAllowlist({
    allowedHosts: ["github.com", "docs.anthropic.com"],
    subject: "main-thread",                          // default; omit for same effect
    onDecision: (d) => logger.info("egress-acl", d),
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

Each `EgressDecision` carries: `subject`, `tool`, `effectClass` (always `"egress"`), `target` (hostname, joined domains, or `null`), `decision` (`"allow"` | `"deny"`), and `rule` (machine-readable rule ID). Wire it to your structured logger or audit table for a complete egress trace across agent turns.

## Follow-up (v1)

Pre-approved MCP tools bypass `canUseTool` entirely — they reach the network without ever hitting this interceptor. Full coverage requires a `PreToolUse` hook at the SDK permission-model level, distinct from the `canUseTool` path. Tracking in the pitch: https://github.com/fourcolors/luna/issues/244
