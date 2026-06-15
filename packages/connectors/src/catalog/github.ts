/**
 * GitHub — api-key connector (PAT via secure-entry → env secretRef → stdio).
 *
 * Transport: the OFFICIAL github/github-mcp-server Go binary (v1.3.0+,
 * MIT). It is a native binary, NOT an npm package — install it once:
 *
 *   macOS (Homebrew):  brew install github-mcp-server
 *   Linux (tarball):   gh release download --repo github/github-mcp-server
 *                      (or your OS package manager; see releases page)
 *   Windows:           winget install GitHub.GitHubMCPServer
 *
 * The binary runs via `github-mcp-server stdio` and authenticates with
 * the env var GITHUB_PERSONAL_ACCESS_TOKEN — set automatically by Luna's
 * stdio transport when the operator has stored their PAT via secure-entry.
 *
 * Token setup (one-time):
 *   1. github.com → Settings → Developer settings → Personal access tokens
 *      → Fine-grained tokens (recommended) OR classic tokens.
 *   2. For fine-grained: select repo(s) and the permissions below.
 *   3. Store the token via Luna's Secrets tab — it is kept as a secretRef
 *      (env:LUNA_GITHUB_TOKEN) and never travels in a connector frame.
 *
 * Capabilities and the scopes they map to (GitHub PAT permissions):
 *   repo-read   → Contents:read, Metadata:read, Issues:read, PRs:read
 *   repo-write  → Contents:write, Issues:write, PRs:write
 *
 * Verification (2026-06-14): `github-mcp-server stdio` exits with
 *   "A GitHub MCP server that handles various tools and resources."
 * The binary was confirmed from github/github-mcp-server v1.3.0 release
 * (Linux_x86_64 tarball). env var GITHUB_PERSONAL_ACCESS_TOKEN confirmed
 * from the official README.
 */
import type { ConnectorDefinition } from "../types.js"

export const GITHUB_CONNECTOR: ConnectorDefinition = {
  id: "github",
  name: "GitHub",
  blurb:
    "Repos, issues, pull requests and code search via a Personal Access Token. " +
    "Requires the github-mcp-server binary (brew install github-mcp-server or download from github.com/github/github-mcp-server/releases).",
  category: "development",
  auth: {
    kind: "api-key",
    fieldLabel: "GitHub Personal Access Token (github_pat_… or ghp_…)",
  },
  transport: {
    kind: "mcp-stdio",
    command: "github-mcp-server",
    args: ["stdio"],
    secretEnvVar: "GITHUB_PERSONAL_ACCESS_TOKEN",
  },
  capabilities: [
    {
      id: "repo-read",
      label: "Read repos, issues & pull requests",
      scopes: [],
      defaultGranted: true,
    },
    {
      id: "repo-write",
      label: "Create/update issues, PRs & file contents",
      scopes: [],
      defaultGranted: false,
    },
    {
      id: "code-search",
      label: "Search code across GitHub",
      scopes: [],
      defaultGranted: true,
    },
  ],
  serverKey: "github",
}
