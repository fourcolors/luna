/**
 * @luna/channels — public API.
 *
 * Communication-channel ingress for Luna. Wires Discord/Telegram/Slack/etc.
 * bots to the ChatService without touching the core streaming architecture.
 *
 * Key exports:
 *   - `ChannelAdapter`         — interface a platform author implements
 *   - `ChannelMessage`         — normalized inbound message
 *   - `ChannelAttachment`      — inline binary attachment (image/PDF) on a message
 *   - `DeliveryCapability`     — how a platform accepts output
 *   - `ChannelService`         — orchestrator (Effect Tag + API)
 *   - `ChannelServiceLayer`    — production Layer (inject ChatService et al.)
 *   - `ChannelSessionStore`    — session-map store (Tag + Memory + makeLayer)
 *   - `InboundDedupStore`      — dedup store (Tag + Memory + makeLayer)
 *   - `lookupOrCreate`         — session-map primary API
 *   - `splitToChunks`          — delivery chunking utility
 *   - `subscribeAndDeliver`    — low-level delivery primitive
 */

export type {
  TransportKind,
  ChannelMessage,
  ChannelAttachment,
  DeliveryCapability,
  DeliveryTarget,
  DeliverOptions,
  ChannelAdapter,
} from "./types.js"
export { ChannelError } from "./types.js"

export type { ChannelSessionStoreApi } from "./session-map.js"
export {
  ChannelSessionStore,
  normalizeThreadingKey,
  lookupOrCreate,
} from "./session-map.js"

export type { InboundDedupStoreApi } from "./dedup.js"
export { InboundDedupStore } from "./dedup.js"

export type { ToolStep } from "./delivery.js"
export {
  splitToChunks,
  subscribeAndDeliver,
  streamEditThrottleMs,
  buildStatusLine,
  buildTurnSummary,
  toolStepDetail,
  repairSplitFences,
} from "./delivery.js"

export type { ChannelCommandSpec, ChannelCommandResult } from "./commands.js"
export { channelCommands, handleChannelCommand } from "./commands.js"

export type { ChannelServiceApi } from "./service.js"
export { ChannelService, ChannelServiceLayer } from "./service.js"

export type {
  TelegramAdapterConfig,
  TelegramHttpTransport,
  TelegramFileTransport,
} from "./adapters/telegram.js"
export {
  makeTelegramAdapter,
  makeRealTransport,
  makeRealFileTransport,
  normalizeCommandMention,
} from "./adapters/telegram.js"
export {
  markdownToTelegramHtml,
  toPlainTextFallback,
  escapeTelegramHtml,
} from "./adapters/telegram-format.js"

export type {
  DiscordAdapterConfig,
  DiscordTransport,
  InboundDiscordMessage,
} from "./adapters/discord.js"
export {
  makeDiscordAdapter,
  makeRealDiscordTransport,
  parseDiscord429RetryMs,
  stripExpandableQuoteMarker,
} from "./adapters/discord.js"
