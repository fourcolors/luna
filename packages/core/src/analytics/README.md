# Analytics Module

**Status:** MVP — types, contract tests, and mocked layer. DuckDB integration pending.

## Overview

The Analytics module provides cross-domain queries over **session history** + **telemetry data**. It powers the **analytics agent** (future phase) that helps diagnose issues by answering questions like:

- "What tools ran in this session and how long did they take?"
- "Which sessions had the highest error rates?"
- "Is there a pattern in failures?"

## Architecture

### Data Sources

1. **Session History** (from `SessionHistoryService`)
   - Full message transcripts
   - Tool/skill usage attribution
   - Entrypoint tracking (Discord, Telegram, CLI)

2. **Telemetry** (from `TelemetryService`, to be moved to DuckDB Phase 28)
   - Counter metrics (tool execution times, error counts)
   - Duration summaries
   - Resource usage

### Query Model

Analytics queries are **pull-based** (no daemon). Agents trigger queries to understand session behavior:

```typescript
interface AnalyticsQuery {
  sessionId?: string          // filter by session
  toolName?: string           // e.g. "Read", "Bash"
  skillName?: string          // e.g. "advisor", "auditor"
  startTime?: string          // ISO 8601
  endTime?: string            // ISO 8601
  includeMetrics?: boolean    // join with telemetry
  limit?: number
}

interface AnalyticsResult {
  sessions: SessionTelemetryJoin[]  // one row per session
  summary: {
    totalSessions: number
    totalMessages: number
    totalToolUses: number
    errorRate: number
  }
}
```

### API

```typescript
interface AnalyticsApi {
  querySessionMetrics(q: AnalyticsQuery): Promise<AnalyticsResult>
  explainSession(sessionId: string): Promise<SessionTelemetryJoin>
  findAnomalies(threshold?: { errorRate?, duration? }): Promise<SessionTelemetryJoin[]>
}
```

## Usage

### Query a single session's metrics

```typescript
import { AnalyticsService } from "@luna/core"
import { Effect } from "effect"

Effect.gen(function* () {
  const analytics = yield* AnalyticsService
  
  const result = yield* Effect.promise(() =>
    analytics.querySessionMetrics({
      sessionId: "sess-abc",
      includeMetrics: true,
    })
  )
  
  console.log(`Messages: ${result.summary.totalMessages}`)
  console.log(`Tools: ${result.summary.totalToolUses}`)
  console.log(`Error rate: ${result.summary.errorRate}`)
})
```

### Explain a session in detail

```typescript
const session = yield* Effect.promise(() =>
  analytics.explainSession("sess-abc")
)

console.log(session.metrics.toolUsageCount)  // { Read: 15, Bash: 8, ... }
console.log(session.metrics.totalDuration)   // 3600000 ms
```

### Find anomalous sessions

```typescript
const anomalies = yield* Effect.promise(() =>
  analytics.findAnomalies({
    errorRate: 0.1,    // sessions with >10% errors
    duration: 3600000, // sessions lasting >1 hour
  })
)
```

## Analytics Agent (Phase 29)

Once DuckDB integration is complete, the **analytics agent** will be a subagent that:

1. **Listens** to user queries about sessions or diagnostics
2. **Queries** the AnalyticsService for relevant data
3. **Analyzes** patterns and anomalies
4. **Recommends** actions (e.g., "Tool X was slow in 30% of sessions")

Example agent prompt:

```
You are the Luna Analytics Agent. You have access to session history
and telemetry via the AnalyticsService. Users ask you diagnostic questions
like "Why was session X slow?" or "What's our tool usage pattern?"

Use querySessionMetrics to understand aggregate patterns.
Use explainSession to drill into a specific session.
Use findAnomalies to surface outliers for attention.
```

## Integration Points

### With SessionHistoryService

Analytics depends on session history being recorded:

```typescript
// Gateway records every message
const uuid = yield* api.record({
  type: "assistant",
  sessionId,
  uuid: idgen(),
  textContent: response,
  toolName: usedToolName,
  ...
})

// Later, analytics can query this
const sessions = yield* Effect.promise(() =>
  analytics.querySessionMetrics({ toolName })
)
```

### With TelemetryService (Phase 28)

Once telemetry moves to DuckDB (DESIGN.md §2.2.8), analytics will JOIN:

```sql
SELECT s.sessionId, COUNT(*) as messageCount,
       SUM(CASE WHEN t.errorCount > 0 THEN 1 ELSE 0 END) as errorCount
FROM session_history s
LEFT JOIN telemetry_counters t ON s.sessionId = t.sessionId
WHERE s.timestamp BETWEEN ? AND ?
GROUP BY s.sessionId
```

## Roadmap

- **Phase 27 (now):** Types, contract tests, mocked implementation
- **Phase 28:** DuckDB driver integration + real queries
- **Phase 29:** Analytics agent subagent (interprets results for users)
- **Phase 30:** Materialized views, caching, anomaly ML models

## Testing

Tests validate the query contract before DuckDB integration:

```bash
bun run test packages/core/src/analytics/
```

14 tests covering:
- Query shape and semantics
- Filter combinations (toolName, skillName, time ranges)
- Result aggregation
- Anomaly detection thresholds
- BDD scenarios (agent diagnostic workflow)

## References

- **DESIGN.md §2.2.8:** "Metrics/logs to DuckDB + OTLP"
- **DESIGN.md §21:** Agent architecture (agents, subagents, delegation)
- **SessionHistoryService:** `./session-history/`
- **TelemetryService:** `./telemetry/`
