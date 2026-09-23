/**
 * LongMemEval dataset types - mirrors the official ICLR 2025 release
 * (`xiaowu0162/longmemeval-cleaned` on HuggingFace, MIT). Verified against
 * the published README schema, then against a real `longmemeval_oracle.json`
 * download (see dataset.ts). We only type the fields this harness reads.
 *
 * Official files (all 500 questions; haystack size differs):
 *   - longmemeval_oracle.json     - evidence sessions only (this smoke)
 *   - longmemeval_s_cleaned.json  - ~40 sessions / ~115k tokens
 *   - longmemeval_m_cleaned.json  - ~500 sessions
 *
 * Abstention is NOT a `question_type`. Official scoring treats a question as
 * abstention iff `question_id` contains `_abs` (see evaluate_qa.py).
 */

export type LmeQuestionType =
  | "single-session-user"
  | "single-session-assistant"
  | "single-session-preference"
  | "temporal-reasoning"
  | "knowledge-update"
  | "multi-session"

export interface LmeTurn {
  readonly role: string
  readonly content: string
  /** Present on the turn(s) that hold the gold evidence. */
  readonly has_answer?: boolean
}

export interface LmeInstance {
  readonly question_id: string
  readonly question_type: LmeQuestionType | string
  readonly question: string
  /** Mostly strings, but ~6% of the official answers are bare integers. */
  readonly answer: string | number
  readonly question_date: string
  readonly haystack_session_ids: ReadonlyArray<string>
  readonly haystack_dates: ReadonlyArray<string>
  readonly haystack_sessions: ReadonlyArray<ReadonlyArray<LmeTurn>>
  readonly answer_session_ids: ReadonlyArray<string>
}

/** Flattened turn ready for MemoryRouter.put(). */
export interface FlatTurn {
  readonly questionId: string
  readonly sessionId: string
  /** Position of the session in the haystack; used for opaque record ids. */
  readonly sessionIdx: number
  readonly sessionDate: string
  readonly turnIdx: number
  readonly role: string
  readonly text: string
  readonly hasAnswer: boolean
}

export interface RetrievalRecord {
  readonly questionId: string
  readonly question: string
  readonly questionType: string
  /** Abstention questions are excluded from retrieval totals (paper rule). */
  readonly abstention: boolean
  readonly haystackTurns: number
  /** Records the search actually returned (the random baseline assumes min(topK, haystackTurns)). */
  readonly hitCount: number
  readonly evidenceCount: number
  readonly evidenceHit: number
  readonly answerSessionCount: number
  readonly answerSessionHit: number
  /** Expected evidence-turn hits if topK turns were drawn uniformly at random. */
  readonly randomEvidenceHit: number
  /** Expected answer-session hits under the same random draw. */
  readonly randomAnswerSessionHit: number
}
