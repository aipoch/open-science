import type { ContentBlock, ToolCallContent, ToolKind } from '@agentclientprotocol/sdk'

import { formatByteSize } from '@/lib/utils'
import type { ToolActivity } from '@/stores/session-store'

type ToolCodeSection = {
  kind: 'code'
  label: string
  language?: string
  text: string
  truncated?: boolean
}

type ToolDiffSection = {
  kind: 'diff'
  label: string
  path: string
  language?: string
  oldText: string | null
  newText: string
  addedLines: number
  removedLines: number
}

type ToolDetailSection = ToolCodeSection | ToolDiffSection

type ToolActivityDetails = {
  displayName: string
  subtitle?: string
  metaLabel?: string
  sections: ToolDetailSection[]
}

// Bounds very large tool payloads so a single read/execute row cannot flood the transcript.
const MAX_CODE_CHARS = 20000

// Human-readable fallbacks for ACP tool kinds when the provider tool name is unavailable.
const TOOL_KIND_LABELS: Record<ToolKind, string> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  search: 'Search',
  execute: 'Terminal',
  think: 'Task',
  fetch: 'Fetch',
  switch_mode: 'Switch Mode',
  other: 'Tool'
}

// Maps common file extensions to Shiki-friendly language ids for diff/read highlighting.
const EXTENSION_LANGUAGES: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'jsonc',
  jsx: 'jsx',
  kt: 'kotlin',
  less: 'less',
  lua: 'lua',
  md: 'markdown',
  mjs: 'javascript',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash'
}

// Narrows unknown protocol extensions before reading provider-specific fields.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Normalizes optional strings so empty payload values do not override better fallbacks.
const trimDetail = (value: string | null | undefined): string | undefined => {
  const trimmedValue = value?.trim()

  return trimmedValue ? trimmedValue : undefined
}

// Converts supported ACP content block variants into displayable text snippets.
const collectContentText = (content: ContentBlock): string[] => {
  switch (content.type) {
    case 'text':
      return [content.text]
    case 'resource':
      return 'text' in content.resource ? [content.resource.text] : []
    default:
      return []
  }
}

// Gathers plain-text output blocks from a tool activity's content collection.
const collectToolTexts = (activity: ToolActivity): string[] =>
  (activity.toolContent ?? [])
    .filter(
      (content): content is Extract<ToolCallContent, { type: 'content' }> =>
        content.type === 'content'
    )
    .flatMap((content) => collectContentText(content.content))
    .map((text) => text.trimEnd())
    .filter((text) => text.length > 0)

// Extracts structured file diffs so edit tools can render add/remove line summaries.
const collectDiffs = (activity: ToolActivity): Array<Extract<ToolCallContent, { type: 'diff' }>> =>
  (activity.toolContent ?? []).filter(
    (content): content is Extract<ToolCallContent, { type: 'diff' }> => content.type === 'diff'
  )

// Reads the last path segment for compact diff/read section labels.
const basename = (path: string): string => {
  const segments = path.split(/[\\/]/u).filter(Boolean)

  return segments[segments.length - 1] ?? path
}

// Derives a Shiki language id from a file path extension for highlighted diffs.
const languageFromPath = (path: string | undefined): string | undefined => {
  if (!path) return undefined

  const extension = path.split('.').pop()?.toLowerCase()

  return extension ? EXTENSION_LANGUAGES[extension] : undefined
}

// Unwraps a single fenced code block so agent-wrapped output renders without literal backticks.
const unwrapFencedCode = (text: string): { language?: string; code: string } => {
  const fenceMatch = text.trim().match(/^(`{3,})([^\n`]*)\n([\s\S]*?)\n?`{3,}\s*$/u)

  if (!fenceMatch) return { code: text }

  const language = fenceMatch[2].trim()

  return {
    language: language && language !== 'console' ? language : undefined,
    code: fenceMatch[3]
  }
}

// Caps oversized payloads while flagging the truncation for the UI.
const truncateCode = (text: string): { text: string; truncated: boolean } => {
  if (text.length <= MAX_CODE_CHARS) return { text, truncated: false }

  return { text: `${text.slice(0, MAX_CODE_CHARS)}\n…`, truncated: true }
}

// Pretty-prints raw tool arguments/results, tolerating already-stringified payloads.
const stringifyRaw = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return trimDetail(value)

  try {
    const serialized = JSON.stringify(value, null, 2)

    return serialized && serialized !== '{}' && serialized !== '[]' ? serialized : undefined
  } catch {
    return undefined
  }
}

// Prefers the explicit provider tool name, falling back to a readable tool-kind label.
const getToolDisplayName = (activity: ToolActivity): string => {
  const provider = trimDetail(activity.providerToolName)

  if (provider) return provider
  if (activity.toolKind) return TOOL_KIND_LABELS[activity.toolKind] ?? 'Tool'

  return 'Tool'
}

// Resolves the command string for execute tools from raw input or the activity title.
const getCommandText = (activity: ToolActivity): string | undefined => {
  const rawInput = activity.rawInput

  if (isRecord(rawInput) && typeof rawInput.command === 'string') {
    const command = rawInput.command.trim()

    if (command) return command
  }

  return trimDetail(activity.title)
}

// Chooses the best available textual output: terminal stream, content blocks, then raw output.
const getOutputText = (activity: ToolActivity): { language?: string; code: string } | undefined => {
  const terminalOutput = trimDetail(activity.terminalOutput)

  if (terminalOutput) return { language: undefined, code: terminalOutput }

  const contentTexts = collectToolTexts(activity)

  if (contentTexts.length > 0) return unwrapFencedCode(contentTexts.join('\n\n'))

  const rawOutput = stringifyRaw(activity.rawOutput)

  return rawOutput ? { language: undefined, code: rawOutput } : undefined
}

// Builds a bounded code section, returning nothing when there is no text to show.
const createCodeSection = (
  label: string,
  code: string,
  language?: string
): ToolCodeSection | undefined => {
  const trimmed = code.replace(/\s+$/u, '')

  if (!trimmed) return undefined

  const { text, truncated } = truncateCode(trimmed)

  return { kind: 'code', label, language, text, truncated }
}

// Counts changed lines so edit rows can summarize a diff without expanding it.
const countDiffLines = (oldText: string | null, newText: string): [number, number] => {
  const removedLines = oldText ? oldText.split('\n').length : 0
  const addedLines = newText ? newText.split('\n').length : 0

  return [addedLines, removedLines]
}

// Formats the compact "+A −R" summary shown on the right side of an edit row.
const formatDiffMeta = (added: number, removed: number): string | undefined => {
  const parts: string[] = []

  if (added > 0) parts.push(`+${added}`)
  if (removed > 0) parts.push(`−${removed}`)

  return parts.length > 0 ? parts.join(' ') : undefined
}

// Assembles diff sections for edit-kind tools (Edit/Write) with per-file summaries.
const buildDiffDetails = (activity: ToolActivity): ToolActivityDetails | undefined => {
  const diffs = collectDiffs(activity)

  if (diffs.length === 0) return undefined

  let totalAdded = 0
  let totalRemoved = 0
  const sections: ToolDetailSection[] = diffs.map((diff) => {
    const [added, removed] = countDiffLines(diff.oldText ?? null, diff.newText)

    totalAdded += added
    totalRemoved += removed

    return {
      kind: 'diff',
      label: basename(diff.path),
      path: diff.path,
      language: languageFromPath(diff.path),
      oldText: diff.oldText ?? null,
      newText: diff.newText,
      addedLines: added,
      removedLines: removed
    }
  })
  const primaryPath = diffs[0].path

  return {
    displayName: getToolDisplayName(activity),
    subtitle: diffs.length === 1 ? primaryPath : `${diffs.length} files`,
    metaLabel: formatDiffMeta(totalAdded, totalRemoved),
    sections
  }
}

// Assembles command/output code sections for execute-kind tools (Bash, scripts).
const buildExecuteDetails = (activity: ToolActivity): ToolActivityDetails | undefined => {
  const command = getCommandText(activity)
  const output = getOutputText(activity)
  const sections: ToolDetailSection[] = []
  const commandSection = command ? createCodeSection('Command', command, 'bash') : undefined

  if (commandSection) sections.push(commandSection)

  if (output) {
    const outputSection = createCodeSection('Output', output.code, output.language)

    if (outputSection) sections.push(outputSection)
  }

  if (sections.length === 0) return undefined

  const exitCode = activity.terminalExitCode

  return {
    displayName: getToolDisplayName(activity),
    subtitle: command,
    metaLabel: typeof exitCode === 'number' ? `exit ${exitCode}` : undefined,
    sections
  }
}

// Assembles input/output code sections for read/search/generic and MCP tools.
const buildGenericDetails = (activity: ToolActivity): ToolActivityDetails | undefined => {
  const sections: ToolDetailSection[] = []
  const isFileRead = activity.toolKind === 'read'
  const primaryPath = trimDetail(activity.toolLocations?.[0]?.path)

  // Show explicit input for tools whose arguments are not already implied by the title.
  if (!isFileRead) {
    const rawInput = stringifyRaw(activity.rawInput)
    const inputSection = rawInput ? createCodeSection('Input', rawInput, 'json') : undefined

    if (inputSection) sections.push(inputSection)
  }

  const output = getOutputText(activity)

  if (output) {
    const outputSection = createCodeSection(
      isFileRead ? 'Content' : 'Output',
      output.code,
      output.language ?? (isFileRead ? languageFromPath(primaryPath) : undefined)
    )

    if (outputSection) sections.push(outputSection)
  }

  if (sections.length === 0) return undefined

  const displayName = getToolDisplayName(activity)
  const candidateSubtitle = primaryPath ?? trimDetail(activity.title)
  // Drop a subtitle that just repeats the tool name (e.g. "Monitor · Monitor").
  const subtitle =
    candidateSubtitle && candidateSubtitle !== displayName ? candidateSubtitle : undefined

  return {
    displayName,
    subtitle,
    sections
  }
}

// Detects the managed artifact-writing MCP tool (open-science-artifacts / write_artifact_file).
const isArtifactWriteActivity = (activity: ToolActivity): boolean => {
  const providerName = trimDetail(activity.providerToolName)?.toLowerCase() ?? ''

  return (
    providerName === 'save_artifacts' ||
    providerName.includes('artifact_file') ||
    providerName.includes('write_artifact')
  )
}

// Tool names that edit files even when the agent does not report the ACP `edit` tool kind.
const EDIT_PROVIDER_TOOL_NAMES = new Set([
  'edit',
  'multiedit',
  'write',
  'write_file',
  'edit_file',
  'create_file',
  'str_replace',
  'strreplace',
  'str_replace_editor',
  'apply_patch',
  'fswrite',
  'fsappend',
  'notebookedit'
])

// Detects file-editing tools by ACP kind or a known editor tool name (Edit, Write, str_replace…).
const isEditActivity = (activity: ToolActivity): boolean => {
  if (activity.toolKind === 'edit') return true
  if (isArtifactWriteActivity(activity)) return false

  const providerName = trimDetail(activity.providerToolName)?.toLowerCase() ?? ''

  return EDIT_PROVIDER_TOOL_NAMES.has(providerName)
}

// Reads the artifact metadata the MCP tool echoes back as `{ "artifact": { … } }` JSON output.
const extractArtifactOutput = (activity: ToolActivity): Record<string, unknown> | undefined => {
  for (const text of collectToolTexts(activity)) {
    try {
      const parsed: unknown = JSON.parse(text)

      if (isRecord(parsed) && isRecord(parsed.artifact)) return parsed.artifact
    } catch {
      // Not a JSON payload; keep scanning the remaining content blocks.
    }
  }

  return undefined
}

// Reads a trimmed string field from an optional record without leaking non-string values.
const getRecordString = (
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined =>
  record && typeof record[key] === 'string' ? trimDetail(record[key] as string) : undefined

// Summarizes a saved artifact file (name/type/size/path) without echoing its raw content payload.
const buildArtifactDetails = (activity: ToolActivity): ToolActivityDetails | undefined => {
  const rawInput = isRecord(activity.rawInput) ? activity.rawInput : undefined
  const output = extractArtifactOutput(activity)
  const filename = getRecordString(rawInput, 'filename') ?? getRecordString(output, 'name')
  const mimeType = getRecordString(rawInput, 'mimeType') ?? getRecordString(output, 'mimeType')
  const path = getRecordString(output, 'path')
  const size = typeof output?.size === 'number' ? output.size : undefined
  const sizeLabel = formatByteSize(size)

  if (!filename && !path) return undefined

  const summary: Record<string, string> = {}

  if (filename) summary.file = filename
  if (mimeType) summary.type = mimeType
  if (sizeLabel) summary.size = sizeLabel
  if (path) summary.path = path

  const summarySection = createCodeSection('File', JSON.stringify(summary, null, 2), 'json')

  return {
    displayName: 'Write file',
    subtitle: filename ?? path,
    metaLabel: sizeLabel,
    sections: summarySection ? [summarySection] : []
  }
}

// Detects Claude's tool-discovery (ToolSearch) rows by provider name or synthetic title.
const isToolSearchActivity = (activity: ToolActivity): boolean => {
  const providerName = trimDetail(activity.providerToolName)?.toLowerCase()
  const title = trimDetail(activity.title)?.toLowerCase()

  return providerName === 'toolsearch' || title === 'toolsearch'
}

// Reads the "Tools found: A, B, C" summary the tool-search feature emits in its result content.
const extractFoundTools = (activity: ToolActivity): string | undefined => {
  for (const text of collectToolTexts(activity)) {
    const match = text.match(/tools found:\s*(.+)/iu)

    if (match) return trimDetail(match[1])
  }

  return undefined
}

// Summarizes a tool-search step by the tools it discovered instead of a bare "ToolSearch" label.
const buildToolSearchDetails = (activity: ToolActivity): ToolActivityDetails | undefined => {
  const output = getOutputText(activity)

  // A wrapper row with no result carries nothing useful; let it fall back to a plain chip.
  if (!output) return undefined

  const foundTools = extractFoundTools(activity)
  const section = createCodeSection('Tools found', output.code, output.language)

  return {
    displayName: 'Tool search',
    subtitle: foundTools,
    sections: section ? [section] : []
  }
}

// Extracts a fetch target only from trusted fields so arbitrary titles never leak into the row.
const getFetchUrl = (activity: ToolActivity): string | undefined => {
  const rawInput = activity.rawInput

  if (isRecord(rawInput) && typeof rawInput.url === 'string') {
    const url = rawInput.url.trim()

    if (url) return url
  }

  // claude-agent-acp titles WebFetch calls as "Fetch <url>"; accept only that structured form.
  const titleMatch = trimDetail(activity.title)?.match(/^fetch\s+(https?:\/\/\S+)$/iu)

  return titleMatch ? titleMatch[1] : undefined
}

// Reads the optional extraction prompt WebFetch was given.
const getFetchPrompt = (activity: ToolActivity): string | undefined =>
  isRecord(activity.rawInput) && typeof activity.rawInput.prompt === 'string'
    ? trimDetail(activity.rawInput.prompt)
    : undefined

// Renders a WebFetch as "Web Fetch · <url>" with the extraction prompt and fetched result.
const buildFetchDetails = (activity: ToolActivity): ToolActivityDetails | undefined => {
  const url = getFetchUrl(activity)

  // Without a trusted URL there is nothing specific to show, so keep the privacy-safe chip.
  if (!url) return undefined

  const sections: ToolDetailSection[] = []
  const prompt = getFetchPrompt(activity)

  if (prompt) {
    const promptSection = createCodeSection('Prompt', prompt)

    if (promptSection) sections.push(promptSection)
  }

  const output = getOutputText(activity)

  if (output) {
    const resultSection = createCodeSection('Result', output.code, output.language)

    if (resultSection) sections.push(resultSection)
  }

  // Guarantee at least one expandable section so the URL is always inspectable.
  if (sections.length === 0) {
    const request: Record<string, string> = { url }

    if (prompt) request.prompt = prompt

    const requestSection = createCodeSection('Request', JSON.stringify(request, null, 2), 'json')

    if (requestSection) sections.push(requestSection)
  }

  return {
    displayName: 'Web Fetch',
    subtitle: url,
    sections
  }
}

// Projects one tool activity into the structured, expandable detail model, or nothing for chips.
const buildToolActivityDetails = (activity: ToolActivity): ToolActivityDetails | undefined => {
  // Saved files show a metadata summary instead of dumping their (possibly base64) content.
  if (isArtifactWriteActivity(activity)) return buildArtifactDetails(activity)
  // File edits prefer a diff view, falling back to raw input/output when no diff is provided.
  if (isEditActivity(activity)) return buildDiffDetails(activity) ?? buildGenericDetails(activity)
  if (activity.toolKind === 'execute') return buildExecuteDetails(activity)
  // Tool-discovery steps summarize the tools they found rather than repeating "ToolSearch".
  if (isToolSearchActivity(activity)) return buildToolSearchDetails(activity)
  // WebFetch shows the URL and fetched result; other fetches without a URL stay plain chips.
  if (activity.toolKind === 'fetch') return buildFetchDetails(activity)

  return buildGenericDetails(activity)
}

export { buildToolActivityDetails, getToolDisplayName, isEditActivity }
export type { ToolActivityDetails, ToolDetailSection, ToolDiffSection }
