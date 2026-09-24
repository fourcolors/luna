# Server v0.5.4

Model lineup refresh (Opus 5.5 / Sonnet 5 / Haiku 4.5 defaults, new
classifier role), a WebSocket handshake fix, and the LongMemEval memory
eval harness. `UI_WS_PROTOCOL_VERSION` remains 2; no wire-version bump is
required.

## Highlights

**Model defaults.** New threads now default to `claude-opus-5-5` at
medium effort, on `@anthropic-ai/claude-agent-sdk` 0.3.280. Role defaults
moved to the current Claude lineup: advisor → Opus 5.5, wake → Sonnet 5;
daily-driver stays Opus 5.5 and dream stays Haiku 4.5. (PR #708)

**Classifier role.** A new `classifier` model-routing role (default
`claude-haiku-4-5`) gives message routing and general structured work a
cheap JSON lane. It joins the JSON-consumer audit set, so bindings to
`structuredOutput='none'` providers fail at write time like wake/dream,
and `LUNA_CLASSIFIER_MODEL` is primed from the store binding at boot.

**WebSocket handshake.** Flaky "socket closed before hello (code=1006)"
failures are fixed: the test server no longer dual-stack-binds while
clients dial 127.0.0.1, dead handshake sockets are closed instead of
lingering, and pre-hello rejections now surface the underlying socket
error. (PR #710, fixes #705)

**Memory eval.** LongMemEval harness: a smoke run over the official
oracle split with chance baselines (PR #645, fixes #697), plus S/M
splits, pinned `num_ctx`, and a fail-loud error on Ollama context
overflow instead of silent truncation. (PR #703)

## Migrations

No schema changes. No manual migration step is required.

## Verifying the update

```bash
systemctl status luna-chat-server        # active, no chdir errors
luna doctor                              # clean
```

Your server version is reported by `control.version`, sourced from
`server.version.json`.
