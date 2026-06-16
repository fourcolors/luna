# Lessons registry (mutation gate)

Every load-bearing lesson maps to either a **probe** (`covered`) or an explicit
**waiver** (`waived`, with a reason). The `005-lesson-coverage` meta-probe enforces
this linkage: it fails if a covered lesson names a missing probe, if a real
lesson-probe is unregistered, or if a waiver has no reason. This is how we enforce
"no new lesson without a probe."

Format (pipe-separated): `id | status | probe | note`
- `status` is `covered` or `waived`
- `probe` is a path under the corpus root, or `-` for waivers

This seed registers only the generic, publicly-shippable probes. Add a row here
for each install-specific probe you create in your instance.

```
id                       | status  | probe                                        | note
widget-tools-list        | covered | probes/010-widget-tools-list.sh              | a malformed tool schema can make an MCP server's tools/list throw, silently hiding all of its tools
incus-nftables           | covered | probes/040-incus-nftables-guard.sh           | incus create-ops hang without nf_tables; enabling nftables.service flushes the ruleset and wipes incus NAT
amdgpu-dmub-panic        | covered | probes/050-amdgpu-dmub-panic-guard.sh        | reading amdgpu DMUB debugfs nodes NULL-derefs and panics the host; no tracked script may recursively read into /sys, and a deployed bind-mount guard must stay active
thread-resume-restart    | covered | probes/055-thread-resume-survives-restart.sh | thread→SDK-session mapping was in-memory only; after restart threads returned "unknown thread" (task #15); ThreadRegistry (luna.db) makes resume durable
session-snapshot-fidelity | covered | probes/056-session-snapshot-fidelity.sh      | SessionStore was in-memory only; after restart subscribe() replayed an empty snapshot — full transcript lost. Phase 2 SQLite SessionStore: N frames in → N frames out across restart.
```
