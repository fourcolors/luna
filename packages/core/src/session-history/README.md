# Session History Module

**Status:** MVP — types and mocked implementation. DuckDB driver integration pending.

## Overview

The Session History module stores full transcripts of agent sessions in DuckDB for analytics queries. It mirrors the `cc_sessions` table pattern but integrates with Luna's Effect/Layer architecture.

## Architecture

### Schema (Phase 25e migrations)

```sql
CREATE TABLE session_history (
  uuid PRIMARY KEY,
  type VARCHAR CHECK(type IN ('user', 'assistant', 'system')),
  entrypoint VARCHAR,
  sessionId VARCHAR NOT NULL,
  parentUuid VARCHAR,  -- links to parent message (threading)
  timestamp TIMESTAMP NOT NULL,
  requestId VARCHAR,
  toolUseId VARCHAR,
  textContent VARCHAR NOT NULL,
  toolName VARCHAR,
  skillName VARCHAR,
  created_at TIMESTAMP
);

CREATE INDEX session_history_sessionId_timestamp 
  ON session_history(sessionId, timestamp DESC);
```

### API

```typescript
interface SessionHistoryApi {
  record(rec: SessionRecord): Promise<string>           // returns uuid
  query(q: SessionHistoryQuery): Promise<SessionRecord[]>
  getSession(sessionId: string): Promise<SessionRecord[]>
  deleteOlderThan(isoTimestamp: string): Promise<number>
}
```

## Usage

### Recording a message

```typescript
import { SessionHistoryService } from "@luna/core"
import { Effect } from "effect"

Effect.gen(function* () {
  const api = yield* SessionHistoryService
  
  const uuid = yield* Effect.promise(() =>
    api.record({
      type: "user",
      entrypoint: "discord",
      sessionId: "sess-abc",
      uuid: "msg-uuid",
      parentUuid: null,
      timestamp: new Date().toISOString(),
      requestId: "req-123",
      toolUseId: null,
      textContent: "Hello",
      toolName: null,
      skillName: null,
    })
  )
  console.log("Recorded:", uuid)
})
```

### Querying a session transcript

```typescript
Effect.gen(function* () {
  const api = yield* SessionHistoryService
  
  const transcript = yield* Effect.promise(() =>
    api.getSession("sess-abc")
  )
  
  transcript.forEach(msg => {
    console.log(`${msg.type}: ${msg.textContent}`)
  })
})
```

### Querying with filters

```typescript
const toolMessages = yield* Effect.promise(() =>
  api.query({
    sessionId: "sess-abc",
    toolName: "Read",
  })
)
```

## Integration with Analytics

The session history is the primary data source for the **AnalyticsService**, which joins it with telemetry:

```typescript
// AnalyticsService (phase 28) will support:
const result = yield* Effect.promise(() =>
  analytics.querySessionMetrics({
    sessionId: "sess-abc",
    includeMetrics: true,  // joins with telemetry
  })
)

// Returns:
{
  sessionId: "sess-abc",
  messageCount: 42,
  metrics: {
    toolUsageCount: { Read: 15, Bash: 8, ... },
    totalDuration: 3600000,
    errorCount: 2,
    successCount: 40,
  }
}
```

## Roadmap

- **Phase 27 (now):** Types, mocked implementation, comprehensive tests
- **Phase 28:** DuckDB driver integration (bun:duckdb or @duckdb/wasm)
- **Phase 29:** AnalyticsService JOIN queries (session + telemetry)
- **Phase 30:** Anomaly detection, materialized views for performance

## Testing

All tests use mocked DuckDB until driver integration:

```bash
bun run test packages/core/src/session-history/
bun run test packages/core/src/analytics/
```

11 session-history tests + 14 analytics tests validate the contract before real SQL execution.

## References

- **Reference cc_sessions:** `<local-agent-history-path>`
- **Luna DESIGN.md §2.2.8:** Telemetry → DuckDB + OTLP
- **Luna DESIGN.md §17:** Repo layout (Phase 25–28 progression)
