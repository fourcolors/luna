export * from "./types.js"
export * from "./agent-notes.js"
export * from "./ui-feedback-status-store.js"
export * from "./feedback-job-observer.js"
// Named (not `export *`) re-export: feedback-job-bridge.js's `JobRecordSpec`
// would otherwise collide with suggested-actions/accept-handler.js's own
// `JobRecordSpec` at this package's top-level barrel (the same TS2308 hazard
// UI_FEEDBACK_STATUS_COMPONENT's naming works around above) — every other
// symbol re-exports normally, `JobRecordSpec` just stays reachable only via
// a direct "@luna/core/.../feedback-job-bridge.js" import (as the module's
// own tests already do).
export {
  buildFeedbackJobSpec,
  createFeedbackCreateJobDep,
  createJobFromFeedback,
  feedbackJobIdFor,
  PROMPT_MAX,
  type CreateFeedbackCreateJobDepConfig,
  type CreateJobFromFeedbackDeps,
  type CreateJobFromFeedbackResult,
  type FeedbackJobLookupRow,
  type FeedbackJobLookupStore,
  type FeedbackJobsDep,
  type FeedbackSetStatusDep,
} from "./feedback-job-bridge.js"
