// Single source of truth for identifying the Open Science notebook MCP server's kernel-run tools.
// Both the transcript (workspace-tool-activity-details) and the permission dialog
// (PermissionApprovalControls) must agree on which tools carry previewable code, so the suffix
// list and the identity check live here rather than being duplicated per call site.

// Provider tool suffixes (under the notebook MCP server) whose input/result is one kernel run.
const NOTEBOOK_RUN_TOOL_SUFFIXES = ['notebook_execute', 'repl_execute', 'bash_execute'] as const
const NOTEBOOK_CONTROL_TOOL_SUFFIXES = [
  'notebook_state',
  'list_notebook_runtimes',
  'notebook_bind_runtime',
  'notebook_switch_runtime',
  'notebook_restart',
  'notebook_shutdown',
  'inspect_packages',
  'manage_packages',
  'manage_environments'
] as const
const NOTEBOOK_MEMORY_TOOL_SUFFIXES = [
  'list_memory_categories',
  'search_memories',
  'remember_memory'
] as const

// The notebook MCP server segment, hyphenated. The responses bridge sanitizes it to
// open_science_notebook; we normalize `_`→`-` before the exact comparison so both forms match.
const NOTEBOOK_SERVER_SEGMENT = 'open-science-notebook'

// Returns the matched kernel-run suffix when a tool name is one of the notebook server's run tools,
// else undefined. Frameworks namespace tools as mcp__<server>__<tool> (Claude Code / responses
// bridge), <server>.<tool> (others), or the broker-projected <server>/<tool> identity, so only
// `__`, `.`, and `/` are treated as segment delimiters —
// single underscores occur inside both the tool suffix (notebook_execute) and the sanitized server
// name (open_science_notebook) and must not split. The segment immediately before the suffix must
// equal the notebook server exactly, so a lookalike (open-science-notebook-staging) or an unrelated
// server that merely contains the phrase is rejected, and a bare leaf name (no server segment) too.
const matchNotebookTool = (
  toolName: string | undefined | null,
  suffixes: readonly string[]
): string | undefined => {
  const name = toolName?.trim().toLowerCase() ?? ''
  if (!name) return undefined

  // Multi-char / dot delimited forms: mcp__<server>__<tool> (Claude Code, responses bridge),
  // <server>.<tool> and mcp.<server>.<tool> (dotted). The segment before the suffix must equal the
  // server exactly after normalizing `_`→`-`, so a lookalike server is rejected.
  const segments = name.split(/__|\.|\//u)
  if (segments.length >= 2) {
    const suffix = segments[segments.length - 1]
    if (suffixes.some((known) => known === suffix)) {
      const server = segments[segments.length - 2].replace(/_/gu, '-')
      if (server === NOTEBOOK_SERVER_SEGMENT) return suffix
    }
  }

  // opencode joins server and tool with a single `_` (<server>_<tool>). A single `_` also occurs
  // inside the server name and the suffix, so it can't be used as a split delimiter — instead match
  // the exact known server spellings (hyphenated or sanitized) concatenated with each known suffix.
  // Exact equality anchors the server/suffix boundary, so lookalikes (…-staging, my-…) never match.
  for (const suffix of suffixes) {
    if (
      name === `${NOTEBOOK_SERVER_SEGMENT}_${suffix}` ||
      name === `open_science_notebook_${suffix}`
    ) {
      return suffix
    }
  }
  return undefined
}

// Memory call styling hides the provider identity, so it uses a stricter whole-name allowlist than
// legacy run/control matching. Unknown or mixed identities must retain the generic tool display.
const matchExactNotebookTool = (
  toolName: string | undefined | null,
  suffixes: readonly string[]
): string | undefined => {
  const name = toolName ?? ''
  const serverNames = [NOTEBOOK_SERVER_SEGMENT, 'open_science_notebook'] as const

  for (const suffix of suffixes) {
    for (const server of serverNames) {
      if (
        name === `mcp__${server}__${suffix}` ||
        name === `${server}.${suffix}` ||
        name === `mcp.${server}.${suffix}` ||
        name === `${server}/${suffix}` ||
        name === `${server}_${suffix}`
      ) {
        return suffix
      }
    }
  }
  return undefined
}

const matchNotebookRunTool = (toolName: string | undefined | null): string | undefined =>
  matchNotebookTool(toolName, NOTEBOOK_RUN_TOOL_SUFFIXES)

const matchNotebookControlTool = (toolName: string | undefined | null): string | undefined =>
  matchNotebookTool(toolName, NOTEBOOK_CONTROL_TOOL_SUFFIXES)

const matchNotebookMemoryTool = (toolName: string | undefined | null): string | undefined =>
  matchExactNotebookTool(toolName, NOTEBOOK_MEMORY_TOOL_SUFFIXES)

const getNotebookMemoryToolDisplayName = (
  toolName: string | undefined | null
): string | undefined => {
  switch (matchNotebookMemoryTool(toolName)) {
    case 'list_memory_categories':
      return 'Memory categories'
    case 'search_memories':
      return 'Search memory'
    case 'remember_memory':
      return 'Save memory'
    default:
      return undefined
  }
}

const isNotebookManagePackagesToolName = (toolName: string | undefined | null): boolean =>
  matchNotebookControlTool(toolName) === 'manage_packages'

// True when a tool name is any of the notebook server's kernel-run tools.
const isNotebookExecuteToolName = (toolName: string | undefined | null): boolean =>
  matchNotebookRunTool(toolName) !== undefined

// Resolves the namespaced tool identity from the optional fields ACP providers expose. Codex keeps
// it in the dotted title while other providers commonly use providerToolName.
const resolveNotebookRunToolName = (
  ...toolNames: Array<string | undefined | null>
): string | undefined => toolNames.find((toolName) => isNotebookExecuteToolName(toolName))?.trim()

// Canonical kernel kinds, shared with the main process. 'repl' is JavaScript.
type NotebookKernelKind = 'python' | 'r' | 'repl' | 'bash'

// Resolves a notebook/kernel execute call's language, for syntax highlighting (Shiki language id).
// Priority: explicit kernel field on input → tool-name suffix → code heuristics → python.
// Both the permission dialog and the transcript use this so the same cell renders with the same
// language in both contexts.
const resolveNotebookLanguage = (
  toolName: string | undefined | null,
  input: Record<string, unknown> | undefined,
  code: string | undefined
): string => {
  // 1. Explicit kernel field (kernelKind, kernel, or language) in the input.
  const explicit = ['kernelKind', 'kernel', 'language'].reduce<string | undefined>(
    (found, key) =>
      found ?? (typeof input?.[key] === 'string' ? (input[key] as string) : undefined),
    undefined
  )
  if (explicit) {
    const kernelMap: Record<string, string> = {
      python: 'python',
      r: 'r',
      repl: 'javascript',
      bash: 'bash'
    }
    const mapped = kernelMap[explicit.toLowerCase()]
    if (mapped) return mapped
  }

  // 2. Tool-name suffix: repl_execute → javascript, bash_execute → bash.
  const suffix = matchNotebookRunTool(toolName)
  if (suffix === 'repl_execute') return 'javascript'
  if (suffix === 'bash_execute') return 'bash'

  // 3. Code heuristics when the notebook server left kernelKind blank (infer R cells, etc).
  if (code) {
    const heuristic = detectCellLanguage(code)
    if (heuristic !== 'python') return heuristic
  }

  // 4. Default to Python (the most common notebook kernel).
  return 'python'
}

// Heuristics to infer a notebook cell's language when the kernel field is absent. R cells have a
// signature that's unambiguous enough to recognize; everything else defaults to Python.
const detectCellLanguage = (code: string): string => {
  const trimmed = code.trim()
  // R assignment operators and common R functions that rarely appear in Python.
  if (
    /<-/.test(trimmed) ||
    /\blibrary\(/.test(trimmed) ||
    /\bdata\.frame\(/.test(trimmed) ||
    /\b(ggplot|dplyr|tidyr)\(/.test(trimmed)
  ) {
    return 'r'
  }
  return 'python'
}

export {
  NOTEBOOK_RUN_TOOL_SUFFIXES,
  NOTEBOOK_CONTROL_TOOL_SUFFIXES,
  NOTEBOOK_MEMORY_TOOL_SUFFIXES,
  NOTEBOOK_SERVER_SEGMENT,
  getNotebookMemoryToolDisplayName,
  matchNotebookControlTool,
  matchNotebookMemoryTool,
  isNotebookManagePackagesToolName,
  matchNotebookRunTool,
  isNotebookExecuteToolName,
  resolveNotebookRunToolName,
  resolveNotebookLanguage,
  type NotebookKernelKind
}
