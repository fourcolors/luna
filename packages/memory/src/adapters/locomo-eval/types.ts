/**
 * LoCoMo dataset types — mirrors the shape of `data/locomo10.json` from
 * snap-research/locomo (see README.md in this directory for provenance and
 * license). Verified against the actual downloaded file, not guessed from
 * the paper — see `dataset.ts` for the fetch/parse path.
 *
 * We only type the fields this harness actually reads. LoCoMo also ships
 * `observation` (generated) and `session_summary` (generated) per-session
 * synthesis products used by the paper's own "RAG over observations/
 * summaries" baselines — this harness intentionally does NOT ingest those,
 * see README.md "What this measures" for why.
 */

/** A single conversational turn. `dia_id` is unique within a sample, e.g. "D3:7". */
export interface LocomoTurn {
  readonly speaker: string
  readonly dia_id: string
  readonly text: string
  /** Present on multimodal turns; we fold this into the ingested text. */
  readonly blip_caption?: string
}

/**
 * `conversation` is a flat object keyed by `session_<n>` and
 * `session_<n>_date_time`, plus `speaker_a` / `speaker_b`. There is no
 * upper bound on `n` baked into the schema (LoCoMo conversations range up
 * to ~35 sessions), so we index it dynamically rather than typing each key.
 */
export interface LocomoConversation {
  readonly speaker_a: string
  readonly speaker_b: string
  readonly [key: string]: string | ReadonlyArray<LocomoTurn> | undefined
}

/** LoCoMo QA categories, verified against task_eval/evaluation.py upstream:
 *  1 = multi-hop (comma-joined sub-answers, partial F1 per sub-answer)
 *  2 = single-hop
 *  3 = temporal reasoning (answer truncated at first ";" before scoring)
 *  4 = open-domain knowledge
 *  5 = adversarial (unanswerable from the conversation; correct behavior is
 *      to abstain, NOT to produce `adversarial_answer`)
 */
export type LocomoCategory = 1 | 2 | 3 | 4 | 5

export interface LocomoQA {
  readonly question: string
  /** Absent for category 5 (adversarial) QA pairs. */
  readonly answer?: string | number
  readonly category: LocomoCategory
  readonly evidence?: ReadonlyArray<string>
  /** Category 5 only — the plausible-but-wrong answer a naive model might give. */
  readonly adversarial_answer?: string
}

export interface LocomoSample {
  readonly sample_id: string
  readonly conversation: LocomoConversation
  readonly qa: ReadonlyArray<LocomoQA>
}

/** Flattened turn ready for ingestion, with session number and date attached. */
export interface FlatTurn {
  readonly sampleId: string
  readonly sessionNum: number
  readonly sessionDateTime: string
  readonly speaker: string
  readonly diaId: string
  readonly text: string
}

/**
 * Per-QA retrieval evidence-coverage record, written by `run.ts` to
 * `.out/retrieval-<stamp>.json` for every QA pair that has annotated
 * `evidence` dia_ids. Lives here (not in `run.ts`) so it can be imported
 * by `judge-rescore.ts` WITHOUT pulling in `run.ts` itself — `run.ts` runs
 * its entire pipeline as a module-scope side effect (`await main()` at the
 * bottom), so importing anything from it would trigger a live run.
 */
export interface RetrievalRecord {
  readonly sampleId: string
  readonly question: string
  readonly evidenceCount: number
  readonly evidenceHit: number
}
