# Domain docs

Luna currently uses a single-context layout.

Before architecture, diagnosis, or test-design work:

- Read root `CONTEXT.md` when it exists.
- Read relevant records under root `docs/adr/` when that directory exists.
- Proceed without warning when either location is absent; producer workflows create them only when the domain language or an architectural decision needs to be recorded.

Use terms exactly as defined by `CONTEXT.md`, and call out any proposal that contradicts an ADR instead of silently overriding it.
