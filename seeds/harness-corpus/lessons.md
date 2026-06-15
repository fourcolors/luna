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
id                | status  | probe                               | note
widget-tools-list | covered | probes/010-widget-tools-list.sh     | a malformed tool schema can make an MCP server's tools/list throw, silently hiding all of its tools
incus-nftables    | covered | probes/040-incus-nftables-guard.sh  | incus create-ops hang without nf_tables; enabling nftables.service flushes the ruleset and wipes incus NAT
```
