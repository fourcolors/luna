/**
 * @luna/ui-shared — chat-app-agnostic React building blocks
 * used by apps/ui-web (and any future surface that wants the same chrome).
 *
 * Everything in here is pure UI plumbing: WebSocket transport, the chat
 * frame reducer, code/markdown rendering, and small helpers. No layout
 * decisions — apps compose their own shell on top.
 */
export { CodeBlock, CodeBlockFallback, canonLang } from "./CodeBlock.js"
export { default as MarkdownView } from "./MarkdownView.js"
export {
  countLines,
  deriveTitle,
  formatBytes,
  relativeTime,
  truncate,
} from "./helpers.js"
export {
  ALLOWED_ATTACH_TYPES,
  MAX_ATTACH_BYTES,
  fileToAttachment,
  type PendingAttachment,
} from "./attachments.js"
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
  SubscribeThreadFrame,
  ThreadCreatedFrame,
  ThreadListFrame,
  ThreadSnapshotFrame,
  UnsubscribeThreadFrame,
  UserAcceptedFrame,
  UserMessageFrame,
} from "./wire.js"
export { UI_WS_PROTOCOL_VERSION } from "./wire.js"
