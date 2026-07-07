# Spec — Connecting Luna to a Live Hermes Agent

**Status:** Draft (spec/investigation phase)
**Branch:** `hermes-connect` (off `master`)
**Author:** Jax, with advisor + investigation team
**Date:** 2026-07-07

> **Deployment variables** — replace with your values. `${HERMES_HOST}` = the Hermes
> container's reachable IP; `${LUNA_HOST}` = the Luna server's IP; `${COMPOSE_DIR}` =
> the agent stack's docker-compose directory; `${HERMES_SRC}` = the hermes-agent source
> checkout. Host/VM/container/subnet names shown as `<agent-host>`, `<agent-vm>`,
> `<hermes-container>`, `<incus-subnet>` are likewise deployment-specific.

---

## 1. Goal

Let Luna (via the Moon client) connect to a **live Hermes agent** and chat with it as a
first-class backend, streaming its responses into Luna's native chat UI — then, in a
later phase, inspect/administer/update that Hermes instance from Luna.

The connection layer for this (`ui-transport`, `protocol-descriptor`, `server-registry`,
`capabilities`) was built **speculatively** months ago against assumptions, with no live
Hermes to test against. We now have one. This spec turns those assumptions into confirmed
facts and defines the work to reach a working end-to-end chat.

---

## 2. The live target

Hermes = NousResearch **hermes-agent**, running as Docker container
`<hermes-container>` inside incus VM `<agent-vm>` on host `<agent-host>`.

- Built from `${HERMES_SRC}` via
  `${COMPOSE_DIR}/docker-compose.yml` (service `hermes`, `command: [gateway, run]`).
- **Reachable at `${HERMES_HOST}:8642`** (api_server) from `<luna-host>` (${LUNA_HOST}) over the
  incus network — network path already exists.
- Currently exposes **only** its dashboard (`/api/*`, uvicorn) on `${HERMES_HOST}:43160`. The
  chat surface (`api_server`, `/v1/*`, port 8642) is implemented but **not yet enabled**.

### Two surfaces — why we chose `/v1/*`

| | **OpenAI `/v1/*`** (api_server, :8642) | **Dashboard `/api/*`** (:43160) |
|---|---|---|
| Purpose | Programmatic agent interaction (chat) | Human control panel (config, sessions, update) |
| Runs the agent? | **Yes** — full `run_agent.AIAgent`, tools, sandbox | No — control plane |
| Contract | Public, versioned, OpenAI-standard | Private, unversioned, coupled to Hermes's SPA |
| Streaming | SSE (`chat/completions`, `runs/{id}/events`) | WS `/api/ws` (its own UI) |
| Luna adapter | Exists (`HermesHttpSseAdapter`) | None |

**Decision:** chat/interact over the stable `/v1/*` surface **now**; layer manage/inspect/
update over the dashboard `/api/*` **later** (Phase 2). Rationale: `/v1/*` runs the real
agent, streams natively into Luna's `ChatFrame` model, and is a durable public contract.
Coupling Luna to the private dashboard API would be a maintenance trap.

---

## 3. Reality check — what's actually built vs. what's needed

> **Correction to the initial read (advisor-flagged):** the Luna client is **not**
> "largely already built." It is built for **stateless, single-shot** chat. Session
> continuity, multi-turn history, and the transport-engine promotion are the real work.

### Already works
- TOML parsing of `http(s)://` routes (`bootstrap/client-config.ts`, Rust `client_config.rs`).
- `selectAdapter` routes `http(s)://` → `HermesHttpSseAdapter` (`factory.ts:30`).
- Adapter SSE parsing → `ChatFrame` deltas/done (correct, well-tested).
- Token plumbing: `tokenRef` (`env:`/`file:`/`op://`/`none`) via `TokenResolver`, fail-closed,
  never logged (`token-resolver.ts`, `bootstrap/client-config.ts`).
- `ServerKind` includes `"hermes"` (`protocol-descriptor`).
- A Hermes route will already **appear** in Moon's connection dropdown once in `client.toml`.

### The real blocker — transport engine
Moon's live chat path uses the legacy `WebSocketEngine` (Luna-WS only). The multi-backend
`PoolEngine` (which calls `selectAdapter`, and is the only path that can drive Hermes) is
**dark-flagged** (`USE_POOL_ENGINE`, default off) **and** is written against Luna-WS: it
calls `adapter.subscribeFrames()` / `subscribeConnection()` (`chat.html:5041,5048`), which
exist only on `LunaWsAdapter`. The Hermes adapter exposes `descriptorChanges` / `connection`
/ `openSession().messages` instead. **Promoting/branching PoolEngine to drive the Hermes
adapter is the largest single piece of work and the gate to users seeing Hermes chat at all.**

---

## 4. Gap analysis — adapter vs. confirmed live contract

Confirmed from Hermes source (see Appendix A for the full contract).

| # | Assumption / behavior today | Status | Fix |
|---|---|---|---|
| 1 | `version` read from `capabilities.version` (`hermes-http-sse.ts:70`; driver `hermes.ts:87`) | **WRONG** — `/v1/capabilities` has **no** `version` field → always `"unknown"` | Read version from `GET /health/detailed`; add a third probe in `attach()`; thread into `projectHermesDescriptor`. Same fix in update driver. |
| 2 | `/health` must return `{status:"ok"}` (`:72`) | **LIKELY WRONG** — `/health` is a "simple" check; rich status is `/health/detailed` | Treat any 2xx from `/health` as healthy; derive rich health from `/health/detailed`. |
| 3 | SSE: `data:` lines, `[DONE]`, `choices[0].delta.content`, `finish_reason` (`:496-572`) | **CORRECT** | None. |
| 4 | Thread ↔ Hermes session mapping | **WRONG (missing)** — adapter sends **no** `X-Hermes-*` headers; `threadId` defaults to `hermes-${Date.now()}` (changes per `openSession`); each turn posts only the current user message | **Core code change.** Send `X-Hermes-Session-Id: <stable per-thread id>` derived from Luna's persistent thread id. Confirm Hermes reconstructs history server-side per session (else also replay `messages`). Add a place for `X-Hermes-Session-Key`. |
| 5 | Request `model` hard-coded `"hermes"`, `opts.model` ignored (`:447,362`) | **CORRECT** — Hermes selects model server-side | None (but UI model selector is a no-op on this route — don't imply otherwise). |
| 6 | 401 on probes → `auth-failed` (`:261-286`) | **CORRECT** | None. |
| 7 | 401 mid-stream → generic `http-401` error frame (`:464`) | **PARTIAL** — doesn't parse OpenAI error body | Parse `{"error":{message,code}}` and surface it. |
| 8 | Rich `/v1/capabilities` fetched but only `version` was read | **UNUSED SIGNAL** | Map `auth.required`, `features.*`, `endpoints.*` into the descriptor. |
| 9 | Base URL = `endpoints[0]` verbatim; sample toml uses `.../8642/v1` (`:641`, `sample-client.toml:19`) | **WRONG (config bug)** — a `/v1` suffix yields `/v1/v1/capabilities` | Route endpoint must be the **bare origin** `http://${HERMES_HOST}:8642`. Fix the sample; optionally strip a trailing `/v1` in `#baseUrl()`. |
| 10 | `update.revertible:false`, `forwardOnly:true` (`:151`) | **UNKNOWN** — conservative guess | Leave safe default; confirm before exposing an "update" affordance (Phase 2). |
| 11 | Dev stub emits top-level `version` + `/health`→`{status:"ok"}` (`hermes-stub.ts:167`) | **WRONG (stub diverges from live)** — why tests pass but live would break #1/#2 | Align stub to live: drop top-level `version`, add `/health/detailed`, make `/health` a bare 200. |
| — | No client-side turn **timeout** in `startStream` (`:436`) | **GAP** | Add a deadline; a long agent turn (esp. one awaiting approval) can park the stream forever. |
| — | No Hermes `CapabilityProvider` in `packages/capabilities` | **MISSING** (optional for MVP) | Implement one against `provider.ts`; pass the conformance suite; merge via `mergeCapabilities`. |

---

## 5. Security (advisor — highest severity)

**Key-unset = open agent.** If `API_SERVER_KEY` is unset and the port is published,
`POST /v1/chat/completions` runs the **full tool-executing agent (with a Docker sandbox)**
for **anyone** who can reach `${HERMES_HOST}:8642`. On a shared incus subnet that is more than
one tenant — an RCE-class exposure.

Mandatory gates:
1. **`API_SERVER_KEY` must be set.** Treat "open when key unset" as a fail-closed condition,
   not a footnote.
2. **Pre-flight assertion:** a live `curl` to `/v1/chat/completions` with **no** Authorization
   must return **401**. If it returns 200 → the key is unset → **STOP**. This single check
   closes the top risk.
3. **Bind to the incus-net IP only** (`${HERMES_HOST}:8642`), never `0.0.0.0`/public. Belt-and-
   suspenders: if any untrusted workload shares `<incus-subnet>`, add a firewall rule limiting
   8642 to <luna-host> (`${LUNA_HOST}`). Do not rely on network scoping alone — the key is the
   real control.
4. Store the key as `file:` (chmod 600, owner-matched — the resolver enforces this) or
   `op://`; avoid `env:` in shared shell history. Cleartext bearer over plain http is
   acceptable **only** on this trusted lab net (non-loopback → no TLS/spki pin today).

---

## 6. Phasing & workstreams

### Phase 1 — Interact (chat), thin slices

**Slice 1.0 — Enable + verify Hermes api_server (infra).**
Enable `api_server` in the existing `gateway run` container (advisor confirms: **same
container, not a second process** — both surfaces already share the process; a restart
drops the dashboard + in-flight runs, so schedule it). Set `API_SERVER_ENABLED=1` +
`API_SERVER_KEY` (strong random), publish `${HERMES_HOST}:8642:8642`, keep dashboard untouched.
Verify per the Security gates. **See Appendix B (Runbook).**

**Slice 1.1 — Adapter correctness (code).** Fixes #1, #2, #7, #9, + the turn timeout, and
align the dev stub (#11). Explicitly a **stateless smoke test** — do not mistake a green
single-turn curl for "chat works."

**Slice 1.2 — Session continuity + multi-turn (code, the real work).** Fix #4: stable
`X-Hermes-Session-Id` per Luna thread; add a `RouteConfig`/`openSession` field for
`X-Hermes-Session-Key`; confirm history semantics (server-stateful per session vs. replay).
Extend the stub + tests to assert the header is sent and stable across two turns.

**Slice 1.3 — Transport engine (code, the blocker).** Branch/promote `PoolEngine` to drive
the Hermes adapter via `descriptorChanges`/`connection`/`openSession().messages` instead of
the Luna-WS-only `subscribeFrames`/`subscribeConnection`; fix Rust `derive_transport` to map
`http(s)://` → `http`/`https` (not `ws`). Gate exit: a real streaming chat turn in Moon
against the live Hermes.

**Slice 1.4 — Route wiring + live e2e.** Add the `client.toml` route (Appendix A §Route),
descriptor projection maps `features/endpoints`, live end-to-end chat from Moon.

### Phase 2 — Manage/inspect/update (later)
Layer the dashboard `/api/*` onto the descriptor's `inspect`/`administer`/`update`
operations (sessions view, model info, `POST /api/hermes/update`, gateway restart). Confirm
`hermes update` reversibility (#10) before exposing an update affordance. Optional: Hermes
`CapabilityProvider` for slash-commands/skills.

### Chat vs. Runs API
`/v1/chat/completions` is right for a straightforward streaming turn. If agent turns can
**pause for human approval**, chat/completions will hang — that's what the **Runs API**
(`/v1/runs` + `/events` + `/approval` + `/stop`) exists for. Decide per slice; MVP uses
chat/completions with a client timeout.

---

## 7. Test / conformance plan

- **Adapter unit tests:** `packages/ui-transport/test/hermes-http-sse-adapter.test.ts` (688
  lines) drives the stub — **passes today but the stub diverges from live** (#11). After
  1.1/1.2: update the stub and add assertions (version from `/health/detailed`; stable
  `X-Hermes-Session-Id` across two turns; OpenAI error-body parse).
- **Keep the stub as the CI contract.** Use the live container only as a **manual** gate —
  don't couple CI to its uptime/latency.
- **Live smoke:** `attach()` (assert `version ≠ "unknown"`, `identity.kind:"hermes"`,
  `health.status:"normal"`) → `openSession()` + `send()` → assert delta frames then exactly
  one `done`. Curl equivalent in Appendix B §4.
- **Capabilities conformance:** `packages/capabilities/src/testing/conformance.ts` —
  `describeProviderConformance(...)`; a future Hermes provider must pass it.

---

## 8. Open questions / MUST-CONFIRM (live)

1. **`/health/detailed` version field name** — blocks fix #1. Need the live body.
2. **`/health` (simple) body shape** — 200-only or fielded? Sets how far to relax #2.
3. **History semantics** — does Hermes reconstruct prior context server-side from the session
   id (expected), or must the adapter replay full `messages`? A single turn hides this.
4. **Session headers require a server-side key** (else HTTP 400). If we ever run the instance
   open, continuity is impossible — another reason the key is mandatory.
5. **Auth on `/v1/capabilities` / `/v1/models` / `/health/detailed`** — required or public?
6. **`hermes update` reversibility** (#10) — before any Phase-2 update affordance.
7. **PoolEngine promotion scope** — the bulk of the effort; confirm appetite to promote the
   dark flag vs. a Hermes-only shim.

---

## Appendix A — Hermes api_server API Reference

### Overview
The `api_server` platform is Hermes's OpenAI-compatible HTTP surface (aiohttp), started by
`gateway run` when enabled. Every chat/response/run request drives the **full Hermes agent**
(`run_agent.AIAgent`), with **tools executing on the api-server host**
(`runtime.mode="server_agent"`, `tool_execution="server"`, `split_runtime=false`).

### Base URL & auth
- **Base URL:** `http://<host>:<port>`, port default **8642** (`API_SERVER_PORT`); host
  `API_SERVER_HOST`. Our instance: `http://${HERMES_HOST}:8642`. **Endpoint is the bare origin —
  no `/v1` suffix.**
- **Enable:** `API_SERVER_ENABLED=true` **or** simply setting `API_SERVER_KEY` (key presence
  enables the platform). Related: `API_SERVER_CORS_ORIGINS`, `API_SERVER_HOST`,
  `API_SERVER_MODEL_NAME`.
- **Auth:** Bearer. **If `API_SERVER_KEY` is unset the API is OPEN (no auth) — a trap; always
  set it.** When set: `Authorization: Bearer <key>` (hmac-compared); mismatch → **401**
  `{"error":{"message":"Invalid API key","type":"invalid_request_error","code":"invalid_api_key"}}`.

### Endpoints
- `GET /health` — simple liveness. Body shape: **MUST-CONFIRM (live)**.
- `GET /health/detailed` — rich status; where build/version info lives. Field names + whether
  it needs auth: **MUST-CONFIRM (live)**.
- `GET /v1/capabilities` — machine-readable contract. **No top-level `version`.** Shape:
  ```json
  {
    "object": "hermes.api_server.capabilities",
    "platform": "hermes-agent",
    "model": "<model_name>",
    "auth": { "type": "bearer", "required": true },
    "runtime": { "mode": "server_agent", "tool_execution": "server", "split_runtime": false, "description": "..." },
    "features": {
      "chat_completions": true, "chat_completions_streaming": true,
      "responses_api": true, "responses_streaming": true,
      "run_submission": true, "run_status": true, "run_events_sse": true,
      "run_stop": true, "run_approval_response": true,
      "tool_progress_events": true, "approval_events": true,
      "session_continuity_header": "X-Hermes-Session-Id",
      "session_key_header": "X-Hermes-Session-Key",
      "cors": false
    },
    "endpoints": { "health": {...}, "health_detailed": {...}, "models": {...},
      "chat_completions": {"method":"POST","path":"/v1/chat/completions"},
      "responses": {...}, "runs": {...}, "run_status": {...},
      "run_events": {...}, "run_approval": {...}, "run_stop": {...} }
  }
  ```
- `GET /v1/models` — lists `hermes-agent` (OpenAI models-list shape).
- `POST /v1/chat/completions` — OpenAI Chat Completions; runs the full agent. Body
  `{model, stream, messages:[{role,content}]}`. **`model` is ignored** (server picks).
  Headers (opt-in, **both require a server key**, else 400): `X-Hermes-Session-Id` (reuse
  agent session + sandbox across turns), `X-Hermes-Session-Key` (long-term memory scope).
- `POST /v1/responses` — OpenAI Responses API; stateful via `previous_response_id`; SQLite
  store at `$HERMES_HOME/response_store.db`, persists across restarts.
- Runs API: `POST /v1/runs` (→ `run_id`, 202), `GET /v1/runs/{id}` (status),
  `GET /v1/runs/{id}/events` (SSE lifecycle incl. tool-progress + approval requests),
  `POST /v1/runs/{id}/approval`, `POST /v1/runs/{id}/stop`.

### Streaming format (`chat/completions`, `stream:true`)
SSE (`text/event-stream`): repeated `data: {chat.completion.chunk, choices[0].delta.content}`
chunks → a final chunk with `choices[0].finish_reason` ∈ `{"stop","length","error"}` →
`data: [DONE]`. Treat `[DONE]` as end; inspect `finish_reason` to distinguish success/error.

### Error shapes
- 401 invalid key: see auth section.
- Session header without a server key → **400** (body: MUST-CONFIRM).
- In-stream failure → `finish_reason:"error"` on the final chunk, then `[DONE]`.

### Route entry (Luna `client.toml`)
```toml
[route.hermes-lab]
  label     = "Hermes (lab)"
  endpoints = ["http://${HERMES_HOST}:8642"]     # bare origin, NO /v1
  tokenRef  = "env:HERMES_API_SERVER_KEY"    # or file:/op://; "none" only if API is open
```

---

## Appendix B — Runbook: Enabling api_server on the Hermes container

Turns on `/v1/*` on the **existing** `<hermes-container>` container **without disturbing
the dashboard**. Both coexist: dashboard `43160`, api_server `8642`. Bind api_server to the
**incus-net IP** (<luna-host> must reach it), never `0.0.0.0`.

### 1. Generate + store the key
```bash
openssl rand -hex 32        # -> <API_KEY>
```
**Recommended (docker secret):**
```bash
cd ${COMPOSE_DIR}
printf '%s' '<API_KEY>' > secrets/hermes_api_server_key && chmod 600 secrets/hermes_api_server_key
```
(Requires the entrypoint/Hermes to source `API_SERVER_KEY` from the mounted secret file —
**MUST-CONFIRM**. Otherwise use the `.env` fallback: `HERMES_API_SERVER_KEY=<API_KEY>` in a
git-ignored, chmod-600 `.env`, referenced as `API_SERVER_KEY: ${HERMES_API_SERVER_KEY}`.)

### 2. compose `hermes` service diff
```diff
     environment:
       AGENT_LAB_SERVICE: hermes
       HERMES_HOME: /opt/data
       HERMES_DASHBOARD: '1'
       HERMES_DASHBOARD_HOST: 0.0.0.0
       HERMES_DASHBOARD_PORT: '9119'
+      API_SERVER_ENABLED: '1'
+      API_SERVER_HOST: 0.0.0.0
+      API_SERVER_PORT: '8642'
+      API_SERVER_KEY: ${HERMES_API_SERVER_KEY}   # or docker-secret indirection
     ports:
       - "127.0.0.1:43160:9119"        # dashboard (unchanged)
+      - "${HERMES_HOST}:8642:8642"        # api_server — incus-net bind ONLY, never 0.0.0.0
```
`API_SERVER_HOST: 0.0.0.0` is the in-container listen addr; host exposure is governed solely
by the `ports:` bind (`${HERMES_HOST}:8642`).

### 3. Apply
```bash
cd ${COMPOSE_DIR}
docker compose up -d --no-deps hermes     # recreates just hermes; hermes_data volume persists
docker compose logs --tail=50 hermes      # look for api_server bound on :8642
```

### 4. Verify (from <luna-host> or inside <agent-vm>) — `BASE=http://${HERMES_HOST}:8642`
```bash
curl -sS "$BASE/health"
# SECURITY GATE — no token must be rejected:
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Content-Type: application/json' \
  -d '{"model":"hermes-agent","messages":[{"role":"user","content":"ping"}]}' \
  "$BASE/v1/chat/completions"                       # expect 401 — if 200, key is UNSET → STOP
curl -sS -H "Authorization: Bearer <API_KEY>" "$BASE/v1/capabilities" | jq .   # object=hermes.api_server.capabilities
curl -sS -N -H "Authorization: Bearer <API_KEY>" -H 'Content-Type: application/json' \
  -d '{"model":"hermes-agent","stream":true,"messages":[{"role":"user","content":"Say hi in one sentence."}]}' \
  "$BASE/v1/chat/completions"                        # SSE chunks → finish_reason:"stop" → [DONE]
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:43160/   # dashboard regression check
```

### 5. Rollback
Remove the `API_SERVER_*` env + the `${HERMES_HOST}:8642:8642` port line, then
`docker compose up -d --no-deps hermes`. `hermes_data` is untouched.

### Security checklist
- [ ] `API_SERVER_KEY` **set** (unset = fully open agent).
- [ ] Key from a strong RNG; stored chmod-600 / secret; never committed.
- [ ] Port bound to `${HERMES_HOST}:8642` only — no `0.0.0.0`/public.
- [ ] `401` verified on `/v1/chat/completions` without a token.
- [ ] Authenticated chat verified.
- [ ] Dashboard (`127.0.0.1:43160`) unchanged and still responding.
- [ ] incus-net access to `8642` restricted to intended peers (e.g. <luna-host>).
