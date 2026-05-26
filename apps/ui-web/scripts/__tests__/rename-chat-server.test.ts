import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "../../../..");
const r = (p: string) => resolve(repoRoot, p);
const read = (p: string) => readFileSync(r(p), "utf8");

describe("rename: dev-server-chat -> chat-server", () => {
  describe("file renames", () => {
    it("apps/ui-web/scripts/chat-server.ts exists", () => {
      expect(existsSync(r("apps/ui-web/scripts/chat-server.ts"))).toBe(true);
    });

    it("apps/ui-web/scripts/dev-server-chat.ts does NOT exist", () => {
      expect(existsSync(r("apps/ui-web/scripts/dev-server-chat.ts"))).toBe(
        false,
      );
    });
  });

  describe("apps/ui-web/package.json", () => {
    const pkg = () =>
      JSON.parse(read("apps/ui-web/package.json")) as {
        scripts: Record<string, string>;
      };

    it("has script key 'server:chat'", () => {
      expect(pkg().scripts["server:chat"]).toBeDefined();
    });

    it("does NOT have script key 'dev:server:chat'", () => {
      expect(pkg().scripts["dev:server:chat"]).toBeUndefined();
    });

    it("'server:chat' script points to scripts/chat-server.ts", () => {
      expect(pkg().scripts["server:chat"]).toBe(
        "bun run scripts/chat-server.ts",
      );
    });
  });

  describe("scripts/luna-server-install", () => {
    it("starts the chat server through the canonical server:chat script", () => {
      expect(read("scripts/luna-server-install")).toContain(
        "server:chat",
      );
    });

    it("does NOT contain dev:server:chat", () => {
      expect(read("scripts/luna-server-install")).not.toContain(
        "dev:server:chat",
      );
    });
  });

  describe("README.md", () => {
    it("references 'server:chat'", () => {
      expect(read("README.md")).toContain(
        "bun run --filter '@luna/ui-web' server:chat",
      );
    });

    it("does NOT reference 'dev:server:chat'", () => {
      expect(read("README.md")).not.toContain("dev:server:chat");
    });
  });

  describe("DESIGN.md", () => {
    it("references '(chat-server) calls it after broker hydration'", () => {
      expect(read("DESIGN.md")).toContain(
        "(chat-server) calls it after broker hydration",
      );
    });

    it("does NOT reference '(dev-server-chat) calls it after broker hydration'", () => {
      expect(read("DESIGN.md")).not.toContain(
        "(dev-server-chat) calls it after broker hydration",
      );
    });
  });

  describe("CLAUDE.md (project root)", () => {
    it("references 'server:chat' when present", () => {
      if (!existsSync(r("CLAUDE.md"))) return;
      expect(read("CLAUDE.md")).toContain(
        "bun run --filter '@luna/ui-web' server:chat",
      );
    });

    it("does NOT reference 'dev:server:chat' when present", () => {
      if (!existsSync(r("CLAUDE.md"))) return;
      expect(read("CLAUDE.md")).not.toContain("dev:server:chat");
    });
  });

  describe("apps/agent-cli/src/luna.ts", () => {
    const file = () => read("apps/agent-cli/src/luna.ts");

    it("references apps/ui-web/scripts/chat-server.ts in header pointer", () => {
      expect(file()).toContain("apps/ui-web/scripts/chat-server.ts");
    });

    it("does NOT contain the literal 'dev-server-chat'", () => {
      expect(file()).not.toContain("dev-server-chat");
    });
  });

  describe("apps/agent-cli/test/live-smoke.test.ts", () => {
    const file = () => read("apps/agent-cli/test/live-smoke.test.ts");

    it("uses 'chat-server boots:'", () => {
      expect(file()).toContain("chat-server boots:");
    });

    it("uses 'server:chat' in canonical-verification note", () => {
      expect(file()).toContain(
        "server:chat`) is the canonical end-to-end verification.",
      );
    });

    it("does NOT contain 'dev-server-chat'", () => {
      expect(file()).not.toContain("dev-server-chat");
    });

    it("does NOT contain 'dev:server:chat'", () => {
      expect(file()).not.toContain("dev:server:chat");
    });
  });

  describe("apps/ui-web/scripts/dna-loader.ts", () => {
    const file = () => read("apps/ui-web/scripts/dna-loader.ts");

    it("references chat-server.ts dependency tree", () => {
      expect(file()).toContain(
        "pulling in the full chat-server.ts dependency tree.",
      );
    });

    it("references chat-server.ts as the importer", () => {
      expect(file()).toContain(
        "Imported and re-exported by chat-server.ts; consumers that only",
      );
    });

    it("does NOT contain 'dev-server-chat'", () => {
      expect(file()).not.toContain("dev-server-chat");
    });
  });

  describe("apps/ui-web/scripts/__tests__/loadDna.test.ts", () => {
    const file = () => read("apps/ui-web/scripts/__tests__/loadDna.test.ts");

    it("references chat-server.ts in the import-path comment", () => {
      expect(file()).toContain(
        "from chat-server.ts so both import paths are valid.",
      );
    });

    it("does NOT contain 'dev-server-chat'", () => {
      expect(file()).not.toContain("dev-server-chat");
    });
  });

  describe("apps/ui-web/scripts/chat-server.ts (renamed file, internal refs)", () => {
    const file = () => read("apps/ui-web/scripts/chat-server.ts");

    it("uses 'server:chat' in usage comment", () => {
      expect(file()).toContain(
        "bun run --filter '@luna/ui-web' server:chat",
      );
    });

    it("references 'apps/ui-web/scripts/chat-server.ts → DNA.md is 3 levels up.'", () => {
      expect(file()).toContain(
        "apps/ui-web/scripts/chat-server.ts → DNA.md is 3 levels up.",
      );
    });

    it("uses 'chat-server silently falls back to naive cosine ranking'", () => {
      expect(file()).toContain(
        "this, chat-server silently falls back to naive cosine ranking",
      );
    });

    it("references 'bun run chat-server.ts' as direct entry point", () => {
      expect(file()).toContain(
        "the direct entry point (bun run chat-server.ts).",
      );
    });

    it("does NOT contain 'dev-server-chat'", () => {
      expect(file()).not.toContain("dev-server-chat");
    });

    it("does NOT contain 'dev:server:chat'", () => {
      expect(file()).not.toContain("dev:server:chat");
    });
  });

  describe("packages/memory/src/backends/vectorlite-bootstrap.ts", () => {
    const file = () =>
      read("packages/memory/src/backends/vectorlite-bootstrap.ts");

    it("references apps/ui-web/scripts/chat-server.ts", () => {
      expect(file()).toContain(
        "App entrypoints (`apps/ui-web/scripts/chat-server.ts`) provide",
      );
    });

    it("does NOT contain 'dev-server-chat'", () => {
      expect(file()).not.toContain("dev-server-chat");
    });
  });

  describe("packages/memory/test/integration-boot.test.ts", () => {
    const file = () => read("packages/memory/test/integration-boot.test.ts");

    it("references chat-server boot order (intro)", () => {
      expect(file()).toContain("Reproduces the chat-server boot order:");
    });

    it("references chat-server composition", () => {
      expect(file()).toContain("Mirror the chat-server composition:");
    });

    it("references chat-server boot order (force)", () => {
      expect(file()).toContain("Force the chat-server boot order:");
    });

    it("does NOT contain 'dev-server-chat'", () => {
      expect(file()).not.toContain("dev-server-chat");
    });
  });

  describe("packages/memory/test/sqlite-vector.test.ts", () => {
    const file = () => read("packages/memory/test/sqlite-vector.test.ts");

    it("references chat-server fixture pattern", () => {
      expect(file()).toContain("(Same fixture pattern chat-server uses.)");
    });

    it("does NOT contain 'dev-server-chat'", () => {
      expect(file()).not.toContain("dev-server-chat");
    });
  });

  describe("packages/core/src/account-broker/account-broker-sql.ts", () => {
    const file = () =>
      read("packages/core/src/account-broker/account-broker-sql.ts");

    it("references 'Seed CLI / chat-server wiring (Phase 25b)'", () => {
      expect(file()).toContain("Seed CLI / chat-server wiring (Phase 25b)");
    });

    it("does NOT contain 'dev-server-chat'", () => {
      expect(file()).not.toContain("dev-server-chat");
    });
  });

  describe("packages/core/src/db/sqlite-bootstrap.ts", () => {
    const file = () => read("packages/core/src/db/sqlite-bootstrap.ts");

    it("references apps/ui-web/scripts/chat-server.ts", () => {
      expect(file()).toContain(
        "App entrypoints (`apps/ui-web/scripts/chat-server.ts`) provide",
      );
    });

    it("does NOT contain 'dev-server-chat'", () => {
      expect(file()).not.toContain("dev-server-chat");
    });
  });

  describe("docs/visualizer.html", () => {
    const file = () => read("docs/visualizer.html");

    it("references 'chat-server (WebSocket :4753)'", () => {
      expect(file()).toContain(
        "Chat UI on :5173 + chat-server (WebSocket :4753).",
      );
    });

    it("does NOT contain 'dev-server-chat'", () => {
      expect(file()).not.toContain("dev-server-chat");
    });
  });
});
