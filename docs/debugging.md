# Debugging switches

Environment variables that turn on extra diagnostics in the Luna server. All are
off by default; set them in `~/.luna/.env` and restart `luna-chat-server`.

| Variable | What it does |
|---|---|
| `LUNA_SDK_TRACE=1` | Logs one `[sdk-trace]` line to stderr (the journal) for every raw Agent SDK message: type, subtype, tool and task ids, status, and text lengths. Tool output text is never logged, except the background-agent launch acknowledgement. Use it to check how background subagents start, report progress and finish (`packages/chat-service/src/chat-service-sdk-messages.ts`). |
