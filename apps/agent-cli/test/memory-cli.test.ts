import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { Effect, Layer, Stream } from "effect"
import {
  LunaSqliteBootstrap,
  StubEmbedderLayer,
  float32ToBuffer,
} from "@luna/core"
import { SqliteVectorBackend } from "@luna/memory"
import { runMemoryCommand } from "../src/memory.js"

const hasBunSqlite = (() => {
  return typeof (process.versions as { bun?: string }).bun === "string"
})()

const d = hasBunSqlite ? describe : describe.skip

interface LegacyMemoryFixture {
  readonly id: string
  readonly namespace: string
  readonly kind: string
  readonly text: string
  readonly tags: ReadonlyArray<string>
}

const defaultLegacyRecords: ReadonlyArray<LegacyMemoryFixture> = [
  {
    id: "legacy-1",
    namespace: "notes",
    kind: "note",
    text: "legacy stub-vector memory",
    tags: ["fixture"],
  },
]

async function makeLegacyDb(
  records: ReadonlyArray<LegacyMemoryFixture> = defaultLegacyRecords,
): Promise<{
  readonly dbPath: string
  readonly cleanup: () => void
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-memory-cli-"))
  const dbPath = path.join(dir, "memory.db")
  const bunSqlite = (await import("bun:sqlite" as string)) as {
    Database: new (p: string) => {
      run: (sql: string) => void
      query: (sql: string) => {
        run: (...p: unknown[]) => { changes: number }
      }
      close: () => void
    }
  }
  const db = new bunSqlite.Database(dbPath)
  try {
    db.run(`
      CREATE TABLE memory_keyed (
        id              TEXT PRIMARY KEY,
        namespace       TEXT NOT NULL,
        kind            TEXT NOT NULL,
        content_json    TEXT NOT NULL,
        schema_version  INTEGER NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        tags_json       TEXT NOT NULL
      );
      CREATE TABLE memory_vectors (
        id          TEXT PRIMARY KEY REFERENCES memory_keyed(id) ON DELETE CASCADE,
        namespace   TEXT NOT NULL,
        embedding   BLOB NOT NULL,
        dimension   INTEGER NOT NULL,
        text        TEXT NOT NULL,
        ts          INTEGER NOT NULL
      );
    `)
    const keyed = db.query(
      `INSERT INTO memory_keyed
         (id, namespace, kind, content_json, schema_version, created_at, updated_at, tags_json)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    const vector = db.query(
      `INSERT INTO memory_vectors
         (id, namespace, embedding, dimension, text, ts)
       VALUES (?,?,?,?,?,?)`,
    )
    for (const record of records) {
      keyed.run(
        record.id,
        record.namespace,
        record.kind,
        JSON.stringify({ text: record.text }),
        1,
        1,
        1,
        JSON.stringify(record.tags),
      )
      vector.run(
        record.id,
        record.namespace,
        float32ToBuffer(new Float32Array(64)),
        64,
        record.text,
        1,
      )
    }
  } finally {
    db.close()
  }
  return {
    dbPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

async function readVectorRow(dbPath: string): Promise<{
  readonly text: string
  readonly contentJson: string
  readonly dimension: number
  readonly embeddingProvider: string
  readonly embeddingModel: string
  readonly embeddingFormat: string
  readonly embeddingInputHash: string
  readonly embeddedAt: number
}> {
  const bunSqlite = (await import("bun:sqlite" as string)) as {
    Database: new (p: string) => {
      query: (sql: string) => { get: (...p: unknown[]) => unknown }
      close: () => void
    }
  }
  const db = new bunSqlite.Database(dbPath)
  try {
    return db
      .query(
        `SELECT
           v.text,
           k.content_json AS contentJson,
           v.dimension,
           v.embedding_provider AS embeddingProvider,
           v.embedding_model AS embeddingModel,
           v.embedding_format AS embeddingFormat,
           v.embedding_input_hash AS embeddingInputHash,
           v.embedded_at AS embeddedAt
         FROM memory_vectors v
         JOIN memory_keyed k ON k.id = v.id
         WHERE v.id = ?`,
      )
      .get("legacy-1") as {
      text: string
      contentJson: string
      dimension: number
      embeddingProvider: string
      embeddingModel: string
      embeddingFormat: string
      embeddingInputHash: string
      embeddedAt: number
    }
  } finally {
    db.close()
  }
}

d("luna memory CLI", () => {
  it("status groups vector rows and prints stale metadata reasons", async () => {
    const fixture = await makeLegacyDb()
    try {
      const result = await runMemoryCommand(["status", "--db-path", fixture.dbPath], {
        env: {},
      })

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain(`Memory DB: ${fixture.dbPath}`)
      expect(result.stdout).toContain(
        "Active embedder: provider=stub model=stub dimension=64 format=memory-note-v1",
      )
      expect(result.stdout).toContain("Vectors: total=1 stale=1")
      expect(result.stdout).toContain(
        "count=1 dimension=64 provider=unknown model=unknown format=raw-v0 compatible=no",
      )
      expect(result.stdout).toContain(
        "legacy-1 namespace=notes reasons=embedding_provider,embedding_model,embedding_format,embedding_input_hash",
      )
    } finally {
      fixture.cleanup()
    }
  })

  it("reembed --dry-run reports stale rows without mutating vector metadata", async () => {
    const fixture = await makeLegacyDb()
    try {
      await runMemoryCommand(["status", "--db-path", fixture.dbPath], {
        env: {},
      })
      const before = await readVectorRow(fixture.dbPath)

      const result = await runMemoryCommand(
        ["reembed", "--dry-run", "--db-path", fixture.dbPath],
        { env: {} },
      )

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("Dry run: 1 stale row(s)")
      expect(result.stdout).toContain(
        "legacy-1 namespace=notes reasons=embedding_provider,embedding_model,embedding_format,embedding_input_hash",
      )
      expect(await readVectorRow(fixture.dbPath)).toEqual(before)
    } finally {
      fixture.cleanup()
    }
  })

  it("reembed --force rebuilds stale rows from keyed content and marks them current", async () => {
    const fixture = await makeLegacyDb()
    try {
      await runMemoryCommand(["status", "--db-path", fixture.dbPath], {
        env: {},
      })

      const result = await runMemoryCommand(
        ["reembed", "--force", "--db-path", fixture.dbPath],
        { env: {} },
      )

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("Re-embedded: 1")
      const row = await readVectorRow(fixture.dbPath)
      expect(row.text).toBe("legacy stub-vector memory")
      expect(row.contentJson).toBe(
        JSON.stringify({ text: "legacy stub-vector memory" }),
      )
      expect(row.dimension).toBe(64)
      expect(row.embeddingProvider).toBe("stub")
      expect(row.embeddingModel).toBe("stub")
      expect(row.embeddingFormat).toBe("memory-note-v1")
      expect(row.embeddingInputHash).toMatch(/^[a-f0-9]{64}$/)
      expect(row.embeddedAt).toBeGreaterThan(0)

      const status = await runMemoryCommand(["status", "--db-path", fixture.dbPath], {
        env: {},
      })
      expect(status.stdout).toContain("Vectors: total=1 stale=0")
    } finally {
      fixture.cleanup()
    }
  })

  it("reembed --force supports hybrid retrieval for the regression fixture", async () => {
    const fixture = await makeLegacyDb([
      {
        id: "pref-1",
        namespace: "notes",
        kind: "note",
        text: "User preference: concise technical answers should include concrete verification evidence.",
        tags: ["preference"],
      },
      {
        id: "decision-1",
        namespace: "notes",
        kind: "note",
        text: "Project decision: Luna memory retrieval must re-embed stale vectors before judging quality.",
        tags: ["project"],
      },
      {
        id: "distractor-1",
        namespace: "notes",
        kind: "note",
        text: "Distractor fact: lunch planning uses roasted vegetables and sparkling water.",
        tags: ["distractor"],
      },
    ])
    try {
      const reembed = await runMemoryCommand(
        ["reembed", "--force", "--db-path", fixture.dbPath],
        { env: {} },
      )
      expect(reembed.exitCode, reembed.stderr).toBe(0)

      const NoVectorliteLayer = Layer.succeed(LunaSqliteBootstrap, {
        ok: false as const,
        reason: "test disables vectorlite",
      })
      const layer = Layer.provideMerge(
        SqliteVectorBackend.fromPath(fixture.dbPath),
        Layer.merge(StubEmbedderLayer, NoVectorliteLayer),
      )
      const ids = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const b = yield* SqliteVectorBackend
            const hits = yield* Stream.runCollect(
              b.search({
                queryText: "concise technical answers verification",
                mode: "hybrid",
                namespace: "notes",
                topK: 3,
              }),
            )
            return Array.from(hits).map((hit) => hit.record.id)
          }).pipe(Effect.provide(layer)),
        ),
      )

      expect(ids[0]).toBe("pref-1")
    } finally {
      fixture.cleanup()
    }
  })
})
