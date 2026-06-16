// @vitest-environment jsdom
/**
 * MarkdownView link-rendering tests — the security gate on assistant-prose
 * links (see MarkdownView.tsx). A bare <a> would navigate the SPA away from
 * itself, and an agent could emit a dangerous scheme, so:
 *   - https links render as a NEW-TAB anchor with a hardened rel
 *   - mailto links render as a real anchor
 *   - javascript: links are refused → inert text (no anchor), label preserved
 *   - relative / non-absolute hrefs are refused → inert text
 */
import { describe, expect, it } from "vitest"
import { render } from "solid-js/web"
import { MarkdownView } from "../src/MarkdownView.jsx"

const mount = (text: string) => {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(() => <MarkdownView text={text} />, container)
  return {
    container,
    dispose: () => {
      dispose()
      container.remove()
    },
  }
}

describe("MarkdownView links", () => {
  it("renders an https link as a new-tab anchor with a hardened rel", () => {
    const { container, dispose } = mount(
      "see [PR #123](https://github.com/fourcolors/luna/pull/123)",
    )
    const a = container.querySelector("a")
    expect(a).not.toBeNull()
    expect(a!.getAttribute("href")).toBe("https://github.com/fourcolors/luna/pull/123")
    expect(a!.getAttribute("target")).toBe("_blank")
    expect(a!.getAttribute("rel")).toBe("noopener noreferrer")
    dispose()
  })

  it("renders a mailto link as a real anchor", () => {
    const { container, dispose } = mount("mail [me](mailto:hello@example.com)")
    const a = container.querySelector("a")
    expect(a).not.toBeNull()
    expect(a!.getAttribute("href")).toBe("mailto:hello@example.com")
    dispose()
  })

  it("refuses a javascript: link → inert text, no anchor, label kept", () => {
    const { container, dispose } = mount("click [here](javascript:danger)")
    expect(container.querySelector("a")).toBeNull()
    expect(container.textContent).toContain("here")
    dispose()
  })

  it("refuses a relative (non-absolute) href → inert text, no anchor", () => {
    const { container, dispose } = mount("go [home](/dashboard)")
    expect(container.querySelector("a")).toBeNull()
    expect(container.textContent).toContain("home")
    dispose()
  })
})
