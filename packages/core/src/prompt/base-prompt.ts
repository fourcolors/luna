/**
 * Base Prompt composition — DESIGN.md §2.1.3.
 *
 * Builds a SystemPromptSpec for the SDK's unified `systemPrompt` field.
 * The SDK accepts three shapes:
 *   - `string`              → full replacement
 *   - `string[]`            → ordered fragments (with optional dynamic boundary marker)
 *   - `{type:'preset', preset:'claude_code', append?}` → keep default preset + append
 *
 * Our composition has four fragment kinds, each optional:
 *   - identity      (agent's own role/persona)
 *   - skillSegments (skill-injected content, e.g. "You have the git-ops skill…")
 *   - projectContext (workspace/project brief)
 *   - hookAppend    (runtime additions from UserPromptSubmit / SessionStart hooks)
 *
 * Strategy:
 *   - If `preset: true`, output {type:'preset',…, append: join([skill, project, hook])}.
 *     Identity is ignored in preset mode (preset IS the identity).
 *   - If identity is set and preset is false → output string[] with fragments in order.
 *   - If only identity is set → plain string.
 *   - Empty input → undefined (caller leaves field unset, SDK uses default).
 */
import type { SystemPromptSpec } from "../schema/session-options.js"

export interface BasePromptInput {
  readonly preset?: boolean
  readonly identity?: string
  readonly skillSegments?: ReadonlyArray<string>
  readonly projectContext?: string
  readonly hookAppend?: string
}

const nonEmpty = (s: string | undefined): s is string =>
  typeof s === "string" && s.trim().length > 0

const joinFragments = (parts: ReadonlyArray<string | undefined>): string =>
  parts.filter(nonEmpty).join("\n\n")

export function composeBasePrompt(
  input: BasePromptInput,
): SystemPromptSpec | undefined {
  const skills = input.skillSegments?.filter(nonEmpty) ?? []
  const dynamic = joinFragments([
    ...skills,
    input.projectContext,
    input.hookAppend,
  ])

  if (input.preset) {
    return {
      type: "preset",
      preset: "claude_code",
      ...(dynamic.length > 0 ? { append: dynamic } : {}),
    }
  }

  const fragments: string[] = []
  if (nonEmpty(input.identity)) fragments.push(input.identity)
  for (const s of skills) fragments.push(s)
  if (nonEmpty(input.projectContext)) fragments.push(input.projectContext)
  if (nonEmpty(input.hookAppend)) fragments.push(input.hookAppend)

  if (fragments.length === 0) return undefined
  if (fragments.length === 1) return fragments[0]
  return fragments
}
