# Server v0.5.0

Memory system review fixes (PR #628). `UI_WS_PROTOCOL_VERSION` remains 2;
no wire-version bump is required.

## Highlights

**Memory system.** Kind-aware belief embedding with missing-vector backfill.
Hash and dimension comparison to skip unchanged embeddings (avoids redundant
re-embedding). `INSERT... ON CONFLICT DO UPDATE` replaces cascade-prone
`INSERT OR REPLACE`. SQL pushdown for keyed-query filters (namespace, kind,
since, tag). Denormalized vector scope columns with scoped retrieval paths.
General-memory supersession, including the `memory_supersede` tool.
HNSW sidecar rebuild-on-open: if the `.hnsw.bin` sidecar is missing, empty,
or corrupt, the backend rebuilds it from the canonical `memory_vectors`
rows during open.

**Known limitations.** Scoped HNSW still ranks globally before scoped pruning;
the 4x router over-fetch mitigates starvation but does not eliminate it.
Superseded records are filtered after ranking and may reduce returned top-K.
`memory_supersede` blocks direct self-links but lacks general cycle detection.
Tags use `json_each` without a dedicated tag index. Superseded vectors remain
indexed.

## Migrations

All schema changes are additive and ledgered per component in
`schema_versions`. They apply automatically at boot, forward-only. No manual
migration step is required.

## Verifying the update

```bash
systemctl status luna-chat-server        # active, no chdir errors
luna doctor                              # clean
```

Your server version is reported by `control.version`, sourced from
`server.version.json`.
