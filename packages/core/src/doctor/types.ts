/**
 * Doctor framework types — shared finding + remedy model for the runnable
 * doctor workflow (scheduler extreme stability plan v2.3).
 */

export type RemedyClass = "restart" | "unstuck" | "patch" | "escalate" | "auto"

export type DoctorFindingSource =
  | "job_ticker"
  | "readyz"
  | "probe"
  | "manual"
  | "journal"

export type DoctorSeverity = "info" | "warn" | "error" | "critical"

export type DoctorPatientKind = "job" | "service" | "subsystem"

export interface DoctorPatient {
  readonly kind: DoctorPatientKind
  readonly id: string
}

export interface DoctorFinding {
  readonly id: string
  readonly source: DoctorFindingSource
  readonly severity: DoctorSeverity
  readonly summary: string
  readonly patient: DoctorPatient
  readonly evidence: Record<string, unknown>
  /** Suggested remedy; "auto" lets diagnose step choose. */
  readonly suggestedRemedy: RemedyClass
  /**
   * When false, the workflow must escalate (never auto-mutate).
   * Default true for job chronic-fail findings.
   */
  readonly autoEligible: boolean
}

export type DoctorApplyStatus =
  | "pending"
  | "applied"
  | "rolled_back"
  | "verified_ok"
  | "verified_fail"

export interface DoctorBackupManifest {
  readonly id: string
  readonly createdAt: number
  readonly findingId: string
  readonly remedyClass: RemedyClass
  readonly patient: DoctorPatient
  readonly doctorAttempt: number
  readonly backupPaths: ReadonlyArray<string>
  readonly applyStatus: DoctorApplyStatus
  readonly note?: string
}

/** Workflow payload envelope (plus standard workflow steps). */
export interface DoctorWorkflowPayload {
  readonly label: "doctor"
  readonly source: "doctor-workflow"
  readonly halt_on_failure: true
  readonly finding: DoctorFinding
  readonly doctor_attempt: number
  readonly steps: ReadonlyArray<DoctorWorkflowStep>
}

export type DoctorWorkflowStep =
  | {
      readonly kind: "shell"
      readonly cmd: string
      readonly timeout_ms?: number
    }
  | {
      readonly kind: "prompt"
      readonly user_prompt: string
      readonly system_prompt?: string
      readonly max_turns?: number
      readonly timeout_ms?: number
      readonly allowed_tools?: ReadonlyArray<string>
    }

export const DOCTOR_WORKFLOW_SOURCE = "doctor-workflow" as const
export const DOCTOR_WORKFLOW_LABEL = "doctor" as const
