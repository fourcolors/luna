/**
 * LongMemEval dataset types — mirrors the official ICLR 2025 release
 * (`xiaowu0162/longmemeval-cleaned` on HuggingFace, MIT). Verified against
 * the published README schema, then against a real `longmemeval_oracle.json`
 * download (see dataset.ts). We only type the fields this harness reads.
 *
 * Official files (all 500 questions; haystack size differs):
 *   - longmemeval_oracle.json     — evidence sessions only (this smoke)
 *   - longmemeval_s_cleaned.json  — ~40 sessions / ~115k tokens
 *   - longmemeval_m_cleaned.json  — ~500 sessions
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
  readonly answer: string
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
  readonly evidenceCount: number
  readonly evidenceHit: number
  readonly answerSessionCount: number
  readonly answerSessionHit: number
}
