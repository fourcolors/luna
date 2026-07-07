# Serving the Luna Web Client — Single-Origin Runbook

## How it works

When the chat-server boots in normal mode and `apps/ui-web/dist/` exists, it
serves the pre-built SPA directly on the same port and host as the WebSocket
endpoint (default `127.0.0.1:4753`). No separate HTTP server is needed.

- The WebSocket endpoint remains at `ws[s]://<host>:4753/ui`.
- Health probes remain at `http://<host>:4753/healthz` and `/readyz`.
- All other `GET`/`HEAD` requests are handled by the built-in static server.

The `dist/` directory is built automatically by `luna-update-server` on every
upgrade (see `scripts/luna-update-server`, `apply_ref()`). On a fresh clone that
has not run `bun run build` yet, static serving is silently disabled and the
server logs:

```
[luna/ui] dist/ not built — web client static serving disabled
```

Run `cd apps/ui-web && bun run build` once to enable it locally.

### Environment overrides

| Variable | Effect |
|---|---|
| `LUNA_UI_WEB_STATIC_DISABLE=1` | Force-disable static serving even if `dist/` exists. |
| `LUNA_UI_WEB_STATIC_ROOT=<abs-path>` | Serve from an explicit directory instead of `dist/`. |

## Reaching the web client

The chat-server binds `127.0.0.1` by default (loopback only). To expose it
to a browser you need one of the following ingress options:

### Option 1: Direct HTTP over localhost (simplest, no TLS)

Works as-is for local development. Open `http://127.0.0.1:4753/` in your
browser. Note: plain HTTP is acceptable here because the web client uses no
secure-context-only APIs (clipboard access has a graceful fallback for
non-secure contexts).

For LAN access, set `LUNA_UI_HOST=0.0.0.0` (or the specific LAN IP) in your
`.env`. Plain HTTP over a trusted LAN is reasonable for personal use; add TLS
(options below) before exposing beyond the local network.

### Option 2: Caddy with real TLS (recommended for remote access)

Install [Caddy](https://caddyserver.com/). Create `/etc/caddy/Caddyfile`:

```caddyfile
your.domain.example {
    reverse_proxy /ui ws://127.0.0.1:4753
    reverse_proxy * http://127.0.0.1:4753
}
```

Run `sudo systemctl reload caddy`. Caddy auto-provisions a Let's Encrypt
certificate. Both the SPA (`/`) and the WebSocket (`/ui`) are reverse-proxied
to the same chat-server port — single-origin, no CORS needed.

### Option 3: Caddy with internal TLS (LAN, no public domain)

```caddyfile
:8443 {
    tls internal
    reverse_proxy /ui ws://127.0.0.1:4753
    reverse_proxy * http://127.0.0.1:4753
}
```

`tls internal` uses Caddy's local CA. Install the CA cert in your browser once
(`caddy trust`). Useful for devices on a LAN that cannot reach the internet for
ACME challenges.

### Option 4: Tailscale Serve (recommended for personal remote access)

```bash
# Expose chat-server to your tailnet (HTTPS auto-configured by Tailscale):
PORT="${LUNA_UI_PORT:-4753}"
tailscale serve --bg "localhost:${PORT}"
```

The `scripts/luna-web-ingress.sh` helper script automates this. After running
it, Tailscale assigns a stable `https://<machine>.your-tailnet.ts.net/` URL
accessible from any device on your tailnet.

### Option 5: Tunnel (ngrok, Cloudflare Tunnel, etc.)

For quick ad-hoc sharing. Example with ngrok:

```bash
ngrok http 4753
```

This exposes the chat-server (SPA + WebSocket) publicly. Use only for
short-lived testing; disable when done.

## Token security

The chat-server authenticates every `ui-ws` connection — desktop Moon client and
browser session alike — with a single bearer token read from `LUNA_UI_WS_TOKEN`.
There is currently **no separate browser token**: a distinct per-surface token is
not yet implemented, so do not rely on setting a second variable (e.g.
`LUNA_UI_WS_TOKEN_WEB`) — the server does not read it, and doing so gives a false
sense of isolation. For shared or public ingress today, terminate at a trusted
reverse proxy and treat the single `LUNA_UI_WS_TOKEN` as sensitive.

Keep the token:
- **Inside TLS** (never send over plain HTTP on untrusted networks).
- **Out of access logs** — configure your reverse proxy to strip the
  `Authorization` header from logged requests, or use the `?token=` query
  parameter which is harder to scrub from logs (prefer the header where possible).

## Minimal Caddyfile (copy-paste)

```caddyfile
# Replace your.domain.example with your actual domain or Tailscale hostname.
# This Caddyfile only reverse-proxies — Caddy itself serves nothing statically.
your.domain.example {
    # WebSocket endpoint — must come before the catch-all.
    reverse_proxy /ui ws://127.0.0.1:4753

    # SPA + all other paths → chat-server's built-in static server.
    reverse_proxy * http://127.0.0.1:4753
}
```
