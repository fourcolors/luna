// main-chat.tsx - the chat window's entry point.
//
// Everything it used to do inline now lives in chat/bootChat.ts, which
// test/helpers/chat-harness.ts calls too. That sharing is the point: until
// stack23 S20d the harness re-implemented the boot ORDER by hand, and that
// divergence caused two separate multi-test failures in the S20 arc alone.
// One sequence makes the whole class unexpressible.
//
// chat.html has no inline <script> as of S20d. It is markup and styles; this
// module is the only code the chat window runs.
import { bootChat } from "./chat/bootChat"

bootChat()
