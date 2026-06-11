/**
 * @luna/ui-shared/core — framework-agnostic subset.
 *
 * No React (or any UI framework) imports. Safe to import from Solid,
 * Svelte, vanilla, server, or test code. Use this entry point from any
 * non-React UI surface (e.g. apps/ui-web-solid during the migration).
 *
 * The default barrel (`@luna/ui-shared`) re-exports everything in here
 * PLUS the React-bound CodeBlock and MarkdownView components — importing
 * the default barrel from a Solid app would pull React into module
 * evaluation. Always use `@luna/ui-shared/core` from non-React surfaces.
 */
export {
  countLines,
  deriveTitle,
  formatBytes,
  formatVal,
  relativeTime,
  truncate,
} from "./helpers.js"
export {
  ALLOWED_ATTACH_TYPES,
  MAX_ATTACH_BYTES,
  fileToAttachment,
  type PendingAttachment,
} from "./attachments.js"
export { downloadArtifact } from "./artifact-download.js"
export { closeOpenFences } from "./streaming.js"
export {
  initialState,
  reduce,
  filterEvents,
  type Action,
  type ChatLocalAction,
  type InFlightTurn,
  type ThreadView,
  type UIState,
} from "./reducer.js"
export {
  browserWebSocketTransport,
  type ConnectionStatus,
  type Transport,
  type TransportHandle,
} from "./transport.js"
export type {
  Artifact,
  ArtifactSource,
  ArtifactsExtractedFrame,
  AssistantDeltaFrame,
  AssistantDoneFrame,
  AssistantErrorFrame,
  ByeFrame,
  ChatAttachment,
  ChatErrorKind,
  ChatMessage,
  ChatToolUse,
  ClientFrame,
  DropFrame,
  EventFrame,
  HelloFrame,
  InterruptFrame,
  ListThreadsFrame,
  NewThreadFrame,
  ObsEvent,
  ObsEventBase,
  ObsEventKind,
  ObsEventLevel,
  PingFrame,
  PongFrame,
  ServerFrame,
  SessionSummary,
  SkillCatalogFrame,
  SkillCatalogItem,
  SkillStatusFrame,
  SkillToggleFrame,
  ConnectorCatalogFrame,
  ConnectorCatalogItem,
  ConnectorInstanceItem,
  ConnectorListFrame,
  ConnectorStatusFrame,
  ConnectorConnectFrame,
  ConnectorDisconnectFrame,
  ArtifactKind,
  ArtifactListFrame,
  ArtifactUpdateFrame,
  ArtifactPinFrame,
  ArtifactUnpinFrame,
  PinnedArtifactItem,
  SubscribeThreadFrame,
  ThreadCreatedFrame,
  ThreadListFrame,
  ThreadSnapshotFrame,
  UnsubscribeThreadFrame,
  UserAcceptedFrame,
  UserMessageFrame,
  WorkflowGalleryItem,
  WorkflowRunItem,
  WorkflowListFrame,
  WorkflowRunsFrame,
  WorkflowRunsRequestFrame,
  WorkflowRefreshFrame,
  VaultWireItem,
  VaultSyncWire,
  VaultListFrame,
  VaultStatusFrame,
  VaultPutFrame,
  VaultDeleteFrame,
  VaultSyncConfigFrame,
  VaultImportFrame,
} from "./wire.js"
export { UI_WS_PROTOCOL_VERSION } from "./wire.js"
