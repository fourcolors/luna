# Harness Regression Corpus (seed)

A self-running regression harness for a Luna install. It turns load-bearing
operational lessons — the failures that already cost you time — into **executable
probes** that run nightly and report red the moment an invariant breaks.

This directory is the **vendored seed**, checked into the repo so a fresh install
bootstraps a working corpus. The **live instance** lives at
`~/.luna/harness-corpus/` (its own git repo, with run history) — the same
seed-vs-instance split as `seeds/agent-memory`.

Built from primitives Luna already has: git + shell probes + one workflow cron
job. No new infrastructure, no network dependency in the harness itself.

## Installing

```bash
bash seeds/harness-corpus/install.sh
# copies the seed into ~/.luna/harness-corpus (if not already present) and
# registers the nightly `harness-corpus-nightly` workflow job in luna.db.
```

The nightly job fires automatically once the chat-server is running (the V2
JobTicker is the only scheduler). Run it any time by hand:

```bash
~/.luna/harness-corpus/run-corpus.sh          # human table; exit 1 if any FAIL
~/.luna/harness-corpus/run-corpus.sh --json   # machine-readable (used by nightly.sh)
```

## The probe contract

A probe is one executable `*.sh` in `probes/` guarding one invariant. Its **exit
code is the verdict**: `0` = PASS, `77` = SKIP (precondition unmet), anything else
= FAIL. Full rules in [CONTRACT.md](./CONTRACT.md), including the **mutation gate**
(`lessons.md` + `005-lesson-coverage`): no new lesson without a probe or an
explicit waiver.

## What's here (generic, ships publicly)

- `run-corpus.sh`, `nightly.sh` — the runner and the nightly wrapper.
- `CONTRACT.md`, `lessons.md` — the contract and the lesson↔probe registry.
- `probes/000-runner-selfcheck.sh` — the harness's own smoke test.
- `probes/005-lesson-coverage.sh` — the mutation gate.
- `probes/010-widget-tools-list.sh` — guards a Luna-framework invariant: an MCP
  tool server must serialize its full `tools/list` (a malformed tool schema can
  silently hide every tool). Set `LUNA_REPO` to your checkout, or it SKIPs.
- `probes/040-incus-nftables-guard.sh` — guards a self-hosting foot-gun for
  incus-based installs (nf_tables loaded; nftables.service not enabled).
- `probes/_template.sh` — copy this to author a probe.
- `DESIGN-P3b-soft-beliefs.md` — design notes for the deferred soft-belief layer.

## What's NOT here (install-specific — you add these locally)

Probes that encode **your** setup (credentials, accounts, private repos) must NOT
be committed to a public repo. Add them to your live instance's `probes/` only.
Sanitized starting points are in [`examples/`](./examples):

- `examples/020-push-auth.sh.example` — verify your git push-auth path still works.
- `examples/030-email-smoke.sh.example` — verify a stored API session still authenticates.

Copy one into `~/.luna/harness-corpus/probes/`, fill in your values, add a row to
your instance `lessons.md`, and confirm `run-corpus.sh` stays green.
