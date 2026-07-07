// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { VaultPanel } from "./vault-panel.jsx";

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
  {
    id: "op_1",
    name: "Primary 1Password",
    kind: "op-token",
    ref: "luna-op://primary/token",
    source: "1password",
    description: null,
    createdAt: 3,
    updatedAt: 4,
    synced: true,
    shadowed: true,
  },
];

function baseProps(overrides = {}) {
  return {
    items: fixtureItems,
    sync: {
      enabled: false,
      opLabel: "primary",
      opVault: "Luna",
      lastSyncedAt: null,
      lastError: null,
      pollSeconds: 300,
    },
    storage: null,
    onPut: vi.fn(),
    onDelete: vi.fn(),
    onSyncConfig: vi.fn(),
    lastStatus: null,
    disabled: false,
    ...overrides,
  };
}

function mount(ui) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function text() {
  return document.body.textContent || "";
}

function buttonByName(name) {
  const button = Array.from(document.querySelectorAll("button")).find((b) =>
    (b.textContent || "").trim().includes(name),
  );
  if (!button) throw new Error(`Missing button: ${name}`);
  return button;
}

function setField(selector, value) {
  const field = document.querySelector(selector);
  if (!field) throw new Error(`Missing field: ${selector}`);
  const proto = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  act(() => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return field;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("Studio VaultPanel", () => {
  it("renders vault metadata rows without secret values", () => {
    const props = baseProps();
    const { unmount } = mount(<VaultPanel {...props} />);

    expect(text()).toContain("Notion API Key");
    expect(text()).toContain("env-secret");
    expect(text()).toContain("env:NOTION_API_KEY");
    expect(text()).toContain("manual");
    expect(text()).toContain("for docs");
    expect(text()).toContain("Primary 1Password");
    expect(text()).toContain("op-token");
    expect(text()).toContain("luna-op://primary/token");
    expect(text()).toContain("1password");
    expect(text()).toContain("synced");
    expect(text()).toContain("shadowed");

    unmount();
  });

  it("sends vault-put from the add form and wipes the password input immediately", () => {
    const props = baseProps({ onPut: vi.fn() });
    const { container, unmount } = mount(<VaultPanel {...props} />);

    act(() => buttonByName("Add credential").click());
    setField("#studio-vault-name", "Notion API Key");
    const secretInput = setField("#studio-vault-value", "sk-secret-value");
    setField("#studio-vault-description", "notion workspace");
    act(() => buttonByName("Save credential").click());

    expect(props.onPut).toHaveBeenCalledTimes(1);
    expect(props.onPut.mock.calls[0][0]).toMatchObject({
      name: "Notion API Key",
      kind: "env-secret",
      varName: "NOTION_API_KEY",
      value: "sk-secret-value",
      description: "notion workspace",
    });
    expect(props.onPut.mock.calls[0][0].requestId).toMatch(/^vlt_/);
    expect(secretInput.value).toBe("");
    expect(container.textContent).not.toContain("sk-secret-value");

    unmount();
  });

  it("uses a two-step inline delete confirmation", () => {
    const props = baseProps({ onDelete: vi.fn() });
    const { unmount } = mount(<VaultPanel {...props} />);

    const row = Array.from(document.querySelectorAll(".studio-vault-row")).find((el) =>
      (el.textContent || "").includes("Notion API Key"),
    );
    const deleteButton = Array.from(row.querySelectorAll("button")).find((b) =>
      (b.textContent || "").includes("Delete"),
    );
    act(() => deleteButton.click());

    expect(props.onDelete).not.toHaveBeenCalled();
    expect(row.textContent).toContain("Delete this credential?");

    const confirmButton = Array.from(row.querySelectorAll("button")).find((b) =>
      (b.textContent || "").includes("Confirm delete"),
    );
    act(() => confirmButton.click());

    expect(props.onDelete).toHaveBeenCalledTimes(1);
    expect(props.onDelete.mock.calls[0][0]).toMatchObject({ id: "env_1" });

    unmount();
  });

  it("renders the exact storage status phrases for keychain, 1Password, and residue counts", () => {
    const { unmount: unmountOne } = mount(
      <VaultPanel
        {...baseProps({
          storage: {
            mode: "auto",
            writeTier: "keychain",
            onePassword: "active",
            osKeychain: true,
            lunaVault: true,
            envResidue: 1,
          },
        })}
      />,
    );
    expect(document.querySelector("[data-testid='studio-vault-storage']").textContent).toBe(
      "New secrets → macOS Keychain · 1Password: connected · 1 secret still in plaintext .env - run the migration script to secure them",
    );
    unmountOne();

    const { unmount: unmountMany } = mount(
      <VaultPanel
        {...baseProps({
          storage: {
            mode: "auto",
            writeTier: "luna-vault",
            onePassword: "detected",
            osKeychain: false,
            lunaVault: true,
            envResidue: 4,
          },
        })}
      />,
    );
    expect(document.querySelector("[data-testid='studio-vault-storage']").textContent).toBe(
      "New secrets → Luna encrypted vault · 1Password: CLI detected - connect a service account to use it · 4 secrets still in plaintext .env - run the migration script to secure them",
    );
    unmountMany();
  });

  it("hides the storage status line when no storage snapshot exists", () => {
    const { unmount } = mount(<VaultPanel {...baseProps({ storage: null })} />);

    expect(document.querySelector("[data-testid='studio-vault-storage']")).toBeNull();

    unmount();
  });

  it("sends clamped 1Password sync config", () => {
    const props = baseProps({ onSyncConfig: vi.fn() });
    const { unmount } = mount(<VaultPanel {...props} />);

    act(() => buttonByName("1Password sync").click());
    act(() => document.querySelector(".studio-vault-control .twk-toggle").click());
    setField("#studio-vault-sync-label", "primary");
    setField("#studio-vault-sync-vault", "Luna");
    setField("#studio-vault-sync-poll", "12");
    act(() => buttonByName("Save sync settings").click());

    expect(props.onSyncConfig).toHaveBeenCalledTimes(1);
    expect(props.onSyncConfig.mock.calls[0][0]).toMatchObject({
      enabled: true,
      opLabel: "primary",
      opVault: "Luna",
      pollSeconds: 60,
    });

    unmount();
  });
});
