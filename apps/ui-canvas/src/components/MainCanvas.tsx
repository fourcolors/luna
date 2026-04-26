import {
  CodeBlock,
  CodeBlockFallback,
  canonLang,
  countLines,
  formatBytes,
  type Artifact,
  type ThreadView,
} from "@experiment-agent/ui-shared"

/**
 * MainCanvas — the dot-grid hero area.
 *
 * v1: renders the LATEST artifact in the active thread full-bleed. If
 * there's nothing to show, the canvas is just the dot-grid with one
 * line of low-contrast hint text. Drawing tools are stubbed in
 * RightToolbar — this component doesn't know about them yet.
 */
export function MainCanvas({ thread }: { thread: ThreadView | null }) {
  const latest: Artifact | null = thread
    ? (thread.artifacts[thread.artifacts.length - 1] ?? null)
    : null

  return (
    <div className={`main-canvas ${latest ? "has-artifact" : "is-empty"}`}>
      <div className="dot-grid" aria-hidden="true" />
      {latest ? (
        <ArtifactSurface artifact={latest} />
      ) : (
        <>
          <div className="canvas-frame" aria-hidden="true">
            <span className="canvas-frame-label">Canvas</span>
          </div>
          <div className="canvas-empty">
            <p className="muted">
              Ask the AI to write code or build something — it&apos;ll appear here.
            </p>
          </div>
        </>
      )}
    </div>
  )
}

function downloadArtifact(a: Artifact) {
  const filename =
    (a.path && a.path.split("/").pop()) ||
    (a.title && a.title.replace(/[^\w.\-]+/g, "_")) ||
    `artifact-${a.id}.txt`
  const blob = new Blob([a.content], { type: "text/plain;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function ArtifactSurface({ artifact }: { artifact: Artifact }) {
  const lang = canonLang(artifact.lang)
  const lines = countLines(artifact.content)
  return (
    <div className="artifact-surface">
      <div className="artifact-titlebar">
        <span className="artifact-name" title={artifact.path ?? undefined}>
          {artifact.source === "tool-write" ? "📄" : "📝"}{" "}
          {artifact.path ?? artifact.title}
        </span>
        <span className="artifact-meta muted small">
          {lines} {lines === 1 ? "line" : "lines"} ·{" "}
          {formatBytes(artifact.content.length)}
        </span>
        <span style={{ flex: 1 }} />
        <button
          className="chip"
          onClick={() => downloadArtifact(artifact)}
          title="Download as file"
        >
          ⬇ download
        </button>
        <button
          className="chip"
          onClick={() => {
            navigator.clipboard?.writeText(artifact.content).catch(() => {})
          }}
          title="Copy to clipboard"
        >
          ⧉ copy
        </button>
      </div>
      <div className="artifact-body">
        {lang ? (
          <CodeBlock lang={lang} source={artifact.content} />
        ) : (
          <CodeBlockFallback source={artifact.content} />
        )}
      </div>
    </div>
  )
}
