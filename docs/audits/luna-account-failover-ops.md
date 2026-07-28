# Luna Account Failover — Operator Runbook

**When to use this runbook:** Turns are hanging or producing no response while
the server process itself appears healthy (healthz 200, WebSocket connects, no
crash in journal). Suspected cause: one of the registered Anthropic accounts
is rate-limited or exhausted and the AccountBroker has no healthy fallback.

---

## 1. Diagnose — confirm account health

From any machine that can reach your server host, run:

```zsh
luna accounts --profile stable
```

Sample output:

```
  ID            LABEL      KIND       HEALTH
───────────────────────────────────────────────
  acc-primary   Primary    anthropic  rate_limited ⚠
  acc-backup    Backup     anthropic  healthy
```

- **`healthy`** — the account is in normal rotation.
- **`rate_limited ⚠`** — the broker has placed a cooldown on this account; it
  will not receive new turns until the cooldown expires or the server is
  restarted with a modified `cooldown_ms` (see §3).

If only one account is registered and it shows `rate_limited`, no new turns
can complete until the cooldown expires or you act.

---

## 2. Identify hung subprocesses on the server host

Before killing anything, map candidate PIDs to the chat-server service so you
do not accidentally terminate processes from other containers or services sharing
the same PID namespace.

```zsh
# On the server host, list all `claude` processes visible in the namespace:
ps aux | grep -E '\bclaude\b' | grep -v grep

# For each candidate PID, confirm it belongs to the chat-server unit's cgroup:
#   Replace <pid> with the actual process ID.
cat /proc/<pid>/cgroup
```

The chat-server unit's cgroup path will contain its service name (e.g.
`system.slice/luna-chat-server.service` or the equivalent incus slice). Only
kill PIDs whose cgroup path matches the chat-server service — other cgroup
paths belong to other workloads.

```zsh
kill <pid>
# Wedged subprocesses have been observed ignoring SIGTERM — escalate if needed:
kill -9 <pid>
```

Killing the subprocess ends that turn (the client sees it stop; the operator
resends their message). Note: the server's turn-inactivity watchdog
(`LUNA_TURN_INACTIVITY_TIMEOUT_MS`, default 300000 ms, `0` disables) normally
does all of this automatically — abort the wedged call, cool the account so the
next message fails over, and surface a clean error. This manual recipe is the
fallback for watchdog-disabled servers or builds that predate it. Re-run
`luna accounts` to confirm health.

---

## 3. Force the server to use the secondary account

Use this when the primary account is rate-limited and you need the server to
route traffic to a secondary account immediately, before the cooldown would
naturally expire.

> **Note on `cooldown_ms` semantics:** `cooldown_ms` in `luna.db` is the
> *remaining* cooldown in milliseconds, applied at the next server boot as
> `cooldownUntilMs = now + cooldown_ms`. Setting it to a large value forces the
> server to treat that account as rate-limited for at least that many
> milliseconds after the next restart.

> **SQLite binding warning:** bun:sqlite named parameters with plain object keys
> (`{ $id: ... }`) can silently bind nothing if the key does not match the
> placeholder exactly. Use positional `?` binding or verify with `.get()` after
> the update.

**Step 1 — stop the service:**

```zsh
systemctl stop <chat-server-unit>
```

**Step 2 — set the cooldown for the primary account:**

Open `luna.db` in the appropriate directory (wherever the running service reads
it; check the unit's `WorkingDirectory` or environment):

```zsh
sqlite3 /path/to/luna.db
```

```sql
-- Positional binding is safer — see warning above.
UPDATE accounts SET cooldown_ms = 10800000 WHERE id = '<primary-id>';
-- 10800000 ms = 3 hours. Adjust to match the provider's rate-limit window.
-- Verify:
SELECT id, label, cooldown_ms FROM accounts WHERE id = '<primary-id>';
```

**Step 3 — start the service:**

```zsh
systemctl start <chat-server-unit>
```

**Step 4 — verify:**

```zsh
luna accounts --profile stable
```

The primary account should now show `rate_limited ⚠`; the secondary should
show `healthy` and begin receiving traffic.

---

## 4. Revert — restore the primary account to normal rotation

**Option A — let the cooldown expire naturally.** The in-memory cooldown
auto-expires at `cooldownUntilMs` without a restart; no action needed.

**Option B — zero the cooldown immediately:**

```zsh
systemctl stop <chat-server-unit>
# Set cooldown_ms back to 0:
sqlite3 /path/to/luna.db "UPDATE accounts SET cooldown_ms = 0 WHERE id = '<primary-id>';"
systemctl start <chat-server-unit>
luna accounts --profile stable   # primary should show healthy
```

---

## 5. Throttle cooldowns without an overflow chain

Cooling an account on a throttle is gated on failover being viable - cooling
the only usable account manufactures an outage strictly worse than surfacing
the error.
Viability is computed at pick time and now covers same-kind pools, not just
configured chains.

**A same-kind sibling now counts as a failover target.**
Two `anthropic` accounts with no `LUNA_OVERFLOW_CHAINS` set will cool the
throttled account and route the *next* acquire to the sibling.
Previously this required an explicit chain; the no-chain path never cooled.
Cooling still does not happen when the account is the sole usable one, when
its siblings are already cooled, or when the thread is pinned to a specific
account via `boundAccountId`.

**Session limits cool for 3 hours; other throttles for 60 seconds.**
A session limit reflects a subscription quota window measured in hours, not a
transient burst, so the old 60-second default caused thrash-retry against an
account that could not recover yet.
A provider-supplied `retry-after` always wins over both defaults.

**The SQL-backed broker now cools on all four throttle kinds.**
It previously acted only on `rate_limit` while the in-memory broker already
handled `session_limit`, `quota_exhausted`, and `model_busy`, so persisted
deployments silently skipped cooling on three of the four.
The two brokers are now behaviorally aligned.

Note that this changes *which account the next turn picks*.
It does not retry the failed turn - a throttle still surfaces to the user,
who resends.

---

## 6. Reference

| Command | Purpose |
|---|---|
| `luna accounts --profile stable` | Show live health (table) |
| `luna accounts --profile stable --json` | Machine-readable JSON |
| `luna doctor --profile stable` | Full connection preflight (L1–L4) |
