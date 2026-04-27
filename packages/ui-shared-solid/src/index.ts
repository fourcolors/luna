/**
 * @luna/ui-shared-solid — Solid components mirroring the React surface
 * in @luna/ui-shared. Currently exports CodeBlock and (next chunk)
 * MarkdownView. Logic lives in @luna/ui-shared/core; this package only
 * holds Solid-bound rendering.
 */
export { CodeBlock, CodeBlockFallback, canonLang } from "./CodeBlock.jsx"
export { MarkdownView } from "./MarkdownView.jsx"
export { MessageBubble } from "./MessageBubble.jsx"
export { ToolCallGroup } from "./ToolCallGroup.jsx"
export { ChatPanel, type ChatPanelProps } from "./ChatPanel.jsx"
export {
  ConnectionSummary,
  type ConnectionSummaryProps,
} from "./ConnectionSummary.jsx"
export { Sidebar, type SidebarProps } from "./Sidebar.jsx"
export { createUiStore, type UiStoreHandle } from "./store.js"
export {
  createTransport,
  type CreateTransportParams,
  type TransportComposable,
} from "./useTransport.js"
