// @vitest-environment jsdom
// Behavioral tests for the Studio vault panel, focused on the tiered-storage
// status line (vault-list.storage, PR #241) plus the panel's core security
// posture. Rendering uses React's own createRoot + act (no testing-library
// dependency, mirroring the Moon panel-vault.test.ts approach of driving
// real DOM).
import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { VaultPanel, storageStatusText, writeTierLabel } from "./vault-panel.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const fixtureItems = [
  {
    id: "env_1",
    name: "Notion API Key",
    kind: "env-secret",
    ref: "env:NOTION_API_KEY",
    source: "manual",
    description: "for docs",
    createdAt: 1,
    updatedAt: 2,
    synced: false,
    shadowed: false,
  },
];

function makeStorage(overrides = {}) {
  return {
    mode: "auto",
    writeTier: "keychain",
    onePassword: "active",
    osKeychain: true,
    lunaVault: true,
    envResidue: 0,
    ...overrides,
  };
}

function baseProps(overrides = {}) {
  return {
    items: fixtureItems,
    sync: null,
    storage: null,
    disabled: false,
    onPut: vi.fn(),
    onDelete: vi.fn(),
    onSyncConfig: vi.fn(),
    onImport: vi.fn(),
    onServerFrame: undefined,
    ...overrides,
  };
}

const mounted = [];

function mount(props) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<VaultPanel {...props} />);
  });
  mounted.push({ root, container });
  return container;
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

const storageLine = (container) => container.querySelector(".vault-storage-line");

describe("storage status line", () => {
  it("renders the exact keychain + connected + residue string", () => {
    const container = mount(
      baseProps({ storage: makeStorage({ envResidue: 3 }) }),
    );
    expect(storageLine(container)?.textContent).toBe(
      "New secrets → macOS Keychain · 1Password: connected · 3 secrets still in plaintext .env - run the migration script to secure them",
    );
  });

  it("renders the luna-vault tier with 1Password detected", () => {
    const container = mount(
      baseProps({
        storage: makeStorage({ writeTier: "luna-vault", onePassword: "detected", osKeychain: false }),
      }),
    );
    expect(storageLine(container)?.textContent).toBe(
      "New secrets → Luna encrypted vault · 1Password: CLI detected - connect a service account to use it",
    );
  });

  it("uses the singular form for one residual secret and omits absent 1Password", () => {
    const container = mount(
      baseProps({ storage: makeStorage({ onePassword: "absent", envResidue: 1 }) }),
    );
    expect(storageLine(container)?.textContent).toBe(
      "New secrets → macOS Keychain · 1 secret still in plaintext .env - run the migration script to secure them",
    );
  });

  it("is hidden entirely when the server predates the storage field", () => {
    const container = mount(baseProps({ storage: null }));
    expect(storageLine(container)).toBeNull();
  });

  it("renders as a single text node (count only - no markup, no names)", () => {
    const container = mount(
      baseProps({ storage: makeStorage({ envResidue: 2 }) }),
    );
    const line = storageLine(container);
    expect(line?.children.length).toBe(0);
    expect(line?.textContent).not.toContain("NOTION_API_KEY");
  });
});

describe("storageStatusText helpers", () => {
  it("writeTierLabel covers all three tiers", () => {
    expect(writeTierLabel("keychain")).toBe("New secrets → macOS Keychain");
    expect(writeTierLabel("luna-vault")).toBe("New secrets → Luna encrypted vault");
    expect(writeTierLabel("env")).toBe("New secrets → plaintext .env (LUNA_VAULT_STORAGE=env)");
  });

  it("omits residue at zero", () => {
    expect(storageStatusText(makeStorage({ envResidue: 0 }))).not.toContain("plaintext .env -");
  });
});

describe("panel basics (previously untested)", () => {
  it("lists stored credentials by name without exposing values", () => {
    const container = mount(baseProps());
    expect(container.textContent).toContain("Notion API Key");
    expect(container.textContent).toContain("1 stored");
  });

  it("correlates vault-status acks via onServerFrame and ignores stale requestIds", () => {
    let listener;
    const onServerFrame = (fn) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    };
    const container = mount(baseProps({ onServerFrame }));
    expect(typeof listener).toBe("function");
    // A stale ack (requestId the panel never issued) must not surface a status.
    act(() => listener({ type: "vault-status", requestId: "vlt_stale", ok: false, message: "nope" }));
    expect(container.textContent).not.toContain("nope");
  });
});
