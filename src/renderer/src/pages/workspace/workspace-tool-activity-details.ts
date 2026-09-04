import type { ContentBlock, ToolCallContent, ToolKind } from '@agentclientprotocol/sdk'

import { formatByteSize } from '@/lib/utils'
import type { ToolActivity } from '@/stores/session-store'
import { memoryAgentRememberResultSchema, memoryAgentResultSchema } from '../../../../shared/memory'
import type { NotebookRunStatus } from '../../../../shared/notebook'
import {
  getNotebookMemoryToolDisplayName,
  isNotebookManagePackagesToolName,
  matchNotebookMemoryTool,
  resolveNotebookLanguage,
  resolveNotebookRunToolName
} from './notebook-tool-names'
import { identityTranslate, type TranslateClause } from './workspace-translate-clause'
import {
  extractSkillLoadDocument,
  getLoadedSkillName,
  isSkillLoadActivity
} from './workspace-skill-load'
import {
  buildLiteratureToolSummary,
  isLiteratureReadDocumentTool,
  type LiteratureToolSummary
} from './literature-tool-presentation'

type ToolCodeSection = {
  kind: 'code'
  label: string
  language?: string
  text: string
  truncated?: boolean
  // When true the section renders behind a default-collapsed toggle (e.g. notebook cell output).
  collapsible?: boolean
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

type ToolLiteratureSection = {
  kind: 'literature'
  summary: LiteratureToolSummary
}

type ToolDetailSection = ToolCodeSection | ToolDiffSection | ToolLiteratureSection

type ToolActivityDetails = {
  displayName: string
  subtitle?: string
  metaLabel?: string
  // UI-only correlation key. The compact tool result keeps this id while figure bytes remain in
  // the local notebook state and never enter transcript/session replay data.
  notebookRunId?: string
  sections: ToolDetailSection[]
}

// Bounds very large tool payloads so a single read/execute row cannot flood the transcript.
const MAX_CODE_CHARS = 20000
const SKILL_ACTIVITY_TITLE_PATTERN = /^(?:run|load|loading|loaded)\s+skill(?:\?|:|\s|$)/iu

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

// Skill documents are internal agent instructions. Existing persisted sessions can contain their
// old payloads, so keep native Skill activities as compact rows without an expandable detail view.
// load_skill MCP calls are Skill activities too; once their output carries the SKILL.md document,
// WorkspaceActivityGroup routes them to the WorkspaceSkillLoadRow markdown view instead.
const isSkillActivity = (activity: ToolActivity): boolean =>
  activity.providerToolName?.trim().toLowerCase() === 'skill' ||
  SKILL_ACTIVITY_TITLE_PATTERN.test(activity.title.trim()) ||
  isSkillLoadActivity(activity)

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
const buildDiffDetails = (
  activity: ToolActivity,
  t: TranslateClause = identityTranslate
): ToolActivityDetails | undefined => {
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
    // A single diff shows its path; several collapse to a count, which is prose and so translates.
    subtitle: diffs.length === 1 ? primaryPath : t('{{count}} files', { count: diffs.length }),
    metaLabel: formatDiffMeta(totalAdded, totalRemoved),
    sections
  }
}

// Assembles command/output code sections for execute-kind tools (Bash, scripts).
const buildExecuteDetails = (
  activity: ToolActivity,
  t: TranslateClause = identityTranslate
): ToolActivityDetails | undefined => {
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
    metaLabel: typeof exitCode === 'number' ? t('exit {{code}}', { code: exitCode }) : undefined,
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

const buildLiteratureDetails = (activity: ToolActivity): ToolActivityDetails | undefined => {
  if (!isLiteratureReadDocumentTool(activity.providerToolName, activity.title)) return undefined

  const contentTexts = collectToolTexts(activity)
  const summary = buildLiteratureToolSummary(
    activity.rawInput,
    contentTexts.length > 0 ? contentTexts : activity.rawOutput
  )
  return {
    displayName: 'Reading',
    subtitle: summary.query ?? summary.documentNames[0],
    sections: [{ kind: 'literature', summary }]
  }
}

const ARTIFACT_WRITE_ACTIVITY_IDENTITIES = new Set([
  'write_artifact_file',
  'write artifact file',
  'save_artifacts',
  'mcp__open-science-artifacts__write_artifact_file',
  'mcp__open_science_artifacts__write_artifact_file',
  'mcp.open-science-artifacts.write_artifact_file',
  'open-science-artifacts_write_artifact_file',
  'open_science_artifacts_write_artifact_file'
])

// Detects the managed artifact-writing MCP tool (open-science-artifacts / write_artifact_file).
const isArtifactWriteActivity = (activity: ToolActivity): boolean => {
  const providerName = trimDetail(activity.providerToolName)?.toLowerCase() ?? ''
  const title = trimDetail(activity.title)?.toLowerCase() ?? ''

  return (
    ARTIFACT_WRITE_ACTIVITY_IDENTITIES.has(providerName) ||
    ARTIFACT_WRITE_ACTIVITY_IDENTITIES.has(title)
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

// Finds an Artifact receipt in direct JSON, MCP content blocks, or a Codex bridge result envelope.
const extractArtifactRecord = (value: unknown, depth = 0): Record<string, unknown> | undefined => {
  if (depth > 4) return undefined

  if (typeof value === 'string') {
    try {
      return extractArtifactRecord(JSON.parse(value) as unknown, depth + 1)
    } catch {
      return undefined
    }
  }

  if (!isRecord(value)) return undefined
  if (isRecord(value.artifact)) return value.artifact

  for (const nested of [value.result, value.structuredContent]) {
    const artifact = extractArtifactRecord(nested, depth + 1)

    if (artifact) return artifact
  }

  if (Array.isArray(value.content)) {
    for (const block of value.content) {
      if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue

      const artifact = extractArtifactRecord(block.text, depth + 1)

      if (artifact) return artifact
    }
  }

  return undefined
}

// Reads the artifact metadata the MCP tool echoes back as `{ "artifact": { … } }` JSON output.
const extractArtifactOutput = (activity: ToolActivity): Record<string, unknown> | undefined => {
  for (const text of collectToolTexts(activity)) {
    const artifact = extractArtifactRecord(text)

    if (artifact) return artifact
  }

  return extractArtifactRecord(activity.rawOutput)
}

// Reads a trimmed string field from an optional record without leaking non-string values.
const getRecordString = (
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined =>
  record && typeof record[key] === 'string' ? trimDetail(record[key] as string) : undefined

// Reads the first finite numeric field from one of the supported receipt spellings.
const getRecordNumber = (
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined => {
  for (const key of keys) {
    const value = record?.[key]

    if (typeof value === 'number' && Number.isFinite(value)) return value
  }

  return undefined
}

// Summarizes a saved artifact file (name/type/size/path) without reading or echoing its raw bytes.
const buildArtifactDetails = (activity: ToolActivity): ToolActivityDetails | undefined => {
  const rawInput = isRecord(activity.rawInput) ? activity.rawInput : undefined
  const output = extractArtifactOutput(activity)
  const filename =
    getRecordString(rawInput, 'filename') ??
    getRecordString(output, 'name') ??
    getRecordString(output, 'filename')
  const mimeType =
    getRecordString(rawInput, 'mimeType') ??
    getRecordString(output, 'mimeType') ??
    getRecordString(output, 'content_type')
  const path = getRecordString(output, 'path')
  const size = getRecordNumber(output, 'size', 'size_bytes')
  const sizeLabel = formatByteSize(size)

  if (!filename && !path) return undefined

  const summary: Record<string, string> = {}

  if (filename) summary.file = filename
  if (mimeType) summary.type = mimeType
  if (sizeLabel) summary.size = sizeLabel
  if (path) summary.path = path

  const summarySection = createCodeSection(
    mimeType?.startsWith('image/') ? 'Tool output image' : 'File',
    JSON.stringify(summary, null, 2),
    'json'
  )

  return {
    displayName: 'Write file',
    subtitle: filename ?? path,
    metaLabel: sizeLabel,
    sections: summarySection ? [summarySection] : []
  }
}

// The kernel kinds a notebook run tool can produce; drives language, label, and display name.
type NotebookKernelKindLike = 'python' | 'r' | 'repl' | 'bash'

const toNotebookKernelKind = (value: unknown): NotebookKernelKindLike | undefined => {
  if (typeof value !== 'string') return undefined

  const normalized = value.toLowerCase()
  return normalized === 'python' ||
    normalized === 'r' ||
    normalized === 'repl' ||
    normalized === 'bash'
    ? normalized
    : undefined
}

// Detects any notebook kernel run (python/r cell, repl control-plane, or bash) so all three render
// as code plus output rather than the raw run-summary JSON envelope.
// Matches both server-name forms (Claude Code's hyphenated open-science-notebook and the
// responses bridge's underscore-sanitized open_science_notebook) via the shared matcher, which
// also requires the server segment to match exactly so lookalike server names are excluded.
const getNotebookRunToolName = (activity: ToolActivity): string | undefined =>
  resolveNotebookRunToolName(trimDetail(activity.providerToolName), trimDetail(activity.title))

const getNotebookInput = (activity: ToolActivity): Record<string, unknown> => {
  if (!isRecord(activity.rawInput)) return {}

  // Codex preserves the MCP envelope on completed activities. The actual notebook input lives in
  // `arguments`, while other providers expose those arguments directly.
  return isRecord(activity.rawInput.arguments) ? activity.rawInput.arguments : activity.rawInput
}

const getMemoryToolSuffix = (activity: ToolActivity): string | undefined =>
  matchNotebookMemoryTool(activity.providerToolName) ?? matchNotebookMemoryTool(activity.title)

const getMemoryToolDisplayName = (activity: ToolActivity): string | undefined =>
  getNotebookMemoryToolDisplayName(activity.providerToolName) ??
  getNotebookMemoryToolDisplayName(activity.title)

// Memory results can arrive directly, stringified, or wrapped by a known ACP/MCP result envelope.
// Validate the complete receipt before surfacing any field from provider-controlled output.
const parseMemoryResult = (value: unknown, depth = 0): Record<string, unknown> | undefined => {
  if (depth > 5) return undefined

  if (typeof value === 'string') {
    try {
      return parseMemoryResult(JSON.parse(value) as unknown, depth + 1)
    } catch {
      return undefined
    }
  }

  if (!isRecord(value)) return undefined
  const parsed = memoryAgentResultSchema.safeParse(value)

  if (parsed.success) return parsed.data
  const rememberResult = memoryAgentRememberResultSchema.safeParse(value)
  if (rememberResult.success && rememberResult.data.status !== 'rejected') {
    return rememberResult.data.memory
  }

  for (const key of ['structuredContent', 'result', 'memory'] as const) {
    const nestedResult = parseMemoryResult(value[key], depth + 1)

    if (nestedResult) return nestedResult
  }

  if (Array.isArray(value.content)) {
    for (const block of value.content) {
      if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue

      const nestedResult = parseMemoryResult(block.text, depth + 1)

      if (nestedResult) return nestedResult
    }
  }

  return undefined
}

const getSavedMemoryCategoryName = (activity: ToolActivity): string | undefined => {
  for (const text of collectToolTexts(activity)) {
    const categoryName = getRecordString(parseMemoryResult(text), 'categoryName')

    if (categoryName) return categoryName
  }

  return getRecordString(parseMemoryResult(activity.rawOutput), 'categoryName')
}

// Keeps the familiar expandable Input/Output panel while replacing transport identities with the
// action and the one useful context value already shown by comparable tool rows.
const buildMemoryDetails = (
  activity: ToolActivity,
  t: TranslateClause = identityTranslate
): ToolActivityDetails | undefined => {
  const displayName = getMemoryToolDisplayName(activity)
  const suffix = getMemoryToolSuffix(activity)

  if (!displayName || !suffix) return undefined

  const details = buildGenericDetails(activity)

  if (!details) return undefined

  const input = getNotebookInput(activity)
  const query = suffix === 'search_memories' ? getRecordString(input, 'query') : undefined
  const savedCategory =
    suffix === 'remember_memory' ? getSavedMemoryCategoryName(activity) : undefined
  const subtitle = savedCategory === 'About you' ? t('About you') : (savedCategory ?? query)

  return { ...details, displayName, subtitle }
}

const isNotebookKernelRunActivity = (activity: ToolActivity): boolean =>
  getNotebookRunToolName(activity) !== undefined

// Resolves the kernel's Shiki language from input, run summary, tool name, and code heuristics.
// Returns the language string directly (no intermediate NotebookKernelKindLike round-trip).
// Uses the shared notebook-tool-names helper so the dialog and transcript agree on language.
const getNotebookLanguage = (
  activity: ToolActivity,
  summary: Record<string, unknown> | undefined
): string => {
  const input = getNotebookInput(activity)
  const inputKernel = ['kernelKind', 'kernel', 'language'].reduce<
    NotebookKernelKindLike | undefined
  >((found, key) => found ?? toNotebookKernelKind(input[key]), undefined)
  const summaryKernel = toNotebookKernelKind(summary?.kernelKind)
  const resolvedInput =
    inputKernel || !summaryKernel ? input : { ...input, kernelKind: summaryKernel }
  const code =
    typeof input.code === 'string'
      ? input.code
      : typeof summary?.script === 'string'
        ? summary.script
        : undefined
  return resolveNotebookLanguage(getNotebookRunToolName(activity), resolvedInput, code)
}

// Reads the notebook run summary the execute tool returns as JSON content (or raw output).
const parseNotebookRunSummary = (activity: ToolActivity): Record<string, unknown> | undefined => {
  for (const text of collectToolTexts(activity)) {
    try {
      const parsed: unknown = JSON.parse(text)

      if (isRecord(parsed)) return parsed
    } catch {
      // Not a JSON payload; keep scanning the remaining content blocks.
    }
  }

  return isRecord(activity.rawOutput) ? activity.rawOutput : undefined
}

// Prefers the executed code from tool input, falling back to the script echoed in the run summary.
// Reads code (python/r/repl) or command (bash) from input, whichever the kernel's tool sends.
const getNotebookCode = (
  activity: ToolActivity,
  summary: Record<string, unknown> | undefined
): string | undefined => {
  const input = getNotebookInput(activity)
  if (Object.keys(input).length > 0) {
    for (const key of ['code', 'command', 'script'] as const) {
      const value = input[key]

      if (typeof value === 'string') {
        const trimmed = trimDetail(value)

        if (trimmed) return trimmed
      }
    }
  }

  return summary && typeof summary.script === 'string' ? trimDetail(summary.script) : undefined
}

// Reads a stream field from either the nested `text` block (notebook_execute) or the top-level
// record (repl_execute/bash_execute control-plane results carry stdout/stderr/traceback directly).
const readStreamField = (
  summary: Record<string, unknown>,
  text: Record<string, unknown> | undefined,
  field: 'stdout' | 'stderr' | 'traceback'
): string => {
  const nested = text && typeof text[field] === 'string' ? (text[field] as string) : ''

  if (nested.trim().length > 0) return nested.trimEnd()

  const top = typeof summary[field] === 'string' ? (summary[field] as string) : ''

  return top.trimEnd()
}

// Collects human-readable results from structured outputs: echoed values (display text mimes), plain
// text, and json. Images are skipped (shown in the notebook panel) as are streams (already in stdout).
const collectDisplayResultText = (summary: Record<string, unknown>): string[] => {
  const outputs = Array.isArray(summary.outputs) ? summary.outputs : []
  const parts: string[] = []

  for (const output of outputs) {
    if (!isRecord(output)) continue

    if (output.type === 'text' && typeof output.text === 'string') {
      parts.push(output.text.trimEnd())
    } else if (output.type === 'json') {
      const serialized = stringifyRaw(output.data)

      if (serialized) parts.push(serialized)
    } else if (output.type === 'display' && isRecord(output.data)) {
      for (const [mime, payload] of Object.entries(output.data)) {
        if (mime.startsWith('image/')) continue
        if (typeof payload === 'string') parts.push(payload.trimEnd())
      }
    }
  }

  return parts.filter((part) => part.trim().length > 0)
}

// Joins the run's textual streams and echoed results into one readable output block.
const getNotebookOutput = (summary: Record<string, unknown> | undefined): string | undefined => {
  if (!summary) return undefined

  const text = isRecord(summary.text) ? summary.text : undefined
  const stdout = readStreamField(summary, text, 'stdout')
  const stderr = readStreamField(summary, text, 'stderr')
  const traceback = readStreamField(summary, text, 'traceback')
  // Traceback usually duplicates stderr, so only append it when it adds new information.
  const streamText = [stdout, stderr, stderr.includes(traceback) ? '' : traceback].filter(Boolean)
  const streamJoined = streamText.join('\n')
  // Drop echoed results already printed verbatim to a stream (e.g. console.log then a trailing echo).
  const displays = collectDisplayResultText(summary).filter((part) => !streamJoined.includes(part))
  const parts = [...streamText, ...displays]

  return parts.length > 0 ? parts.join('\n') : undefined
}

const getNotebookRunIdFromActivity = (activity: ToolActivity): string | undefined => {
  const summary = parseNotebookRunSummary(activity)
  return summary && typeof summary.runId === 'string' ? trimDetail(summary.runId) : undefined
}

const NOTEBOOK_RUN_STATUSES = new Set<NotebookRunStatus>([
  'queued',
  'running',
  'completed',
  'failed',
  'timeout',
  'interrupted',
  'cancelled'
])

// Restores execution truth for transcript rows outside the hydrated Run window. The app-owned
// invocation identity and compact Run result must both be present; otherwise callers stay
// fail-closed instead of trusting an outer ACP observer's status.
const getNotebookRunStatusFromActivity = (
  activity: ToolActivity
): NotebookRunStatus | undefined => {
  if (!activity.executionInvocationId) return undefined
  const summary = parseNotebookRunSummary(activity)
  if (
    !summary ||
    typeof summary.runId !== 'string' ||
    summary.executionInvocationId !== activity.executionInvocationId ||
    typeof summary.status !== 'string'
  ) {
    return undefined
  }

  return NOTEBOOK_RUN_STATUSES.has(summary.status as NotebookRunStatus)
    ? (summary.status as NotebookRunStatus)
    : undefined
}

// Renders a notebook run as its code plus execution output, not the raw summary JSON. Handles every
// kernel: python/r cells, the repl control-plane (Agent SDK), and bash shell runs.
const buildNotebookDetails = (activity: ToolActivity): ToolActivityDetails | undefined => {
  const summary = parseNotebookRunSummary(activity)
  const language = getNotebookLanguage(activity, summary)
  const code = getNotebookCode(activity, summary)
  const sections: ToolDetailSection[] = []
  const codeLabel = language === 'bash' ? 'Command' : 'Code'
  const codeSection = code ? createCodeSection(codeLabel, code, language) : undefined

  if (codeSection) sections.push(codeSection)

  const output = getNotebookOutput(summary)
  const outputSection = output ? createCodeSection('Output', output) : undefined

  // The code leads the cell; keep the output tucked behind a collapsed toggle like the sidebar.
  if (outputSection) sections.push({ ...outputSection, collapsible: true })

  // Without at least the code there is nothing notebook-specific to show; use the generic view.
  if (sections.length === 0) return undefined

  const status = summary && typeof summary.status === 'string' ? summary.status : undefined

  // Derive display name from language: python/r are Notebook runs, javascript (repl) is Agent SDK,
  // and bash is shell.
  const displayName =
    language === 'javascript' ? 'Agent SDK' : language === 'bash' ? 'Shell' : 'Notebook run'

  return {
    displayName,
    metaLabel: status,
    notebookRunId: getNotebookRunIdFromActivity(activity),
    sections
  }
}

// Detects the manage_packages MCP tool so an install renders a friendly summary, not raw JSON.
const isManagePackagesActivity = (activity: ToolActivity): boolean => {
  return (
    isNotebookManagePackagesToolName(activity.providerToolName) ||
    isNotebookManagePackagesToolName(activity.title)
  )
}

const isManagePackagesResult = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) &&
  ['ok', 'needsRestart', 'method', 'environmentName', 'packageChanges', 'error'].some(
    (key) => key in value
  )

// ACP providers retain MCP results in different envelopes. Unwrap only the known result/content
// fields so the renderer can use the compact verified package versions without reading installer logs.
const parseManagePackagesResultValue = (
  value: unknown,
  depth = 0
): Record<string, unknown> | undefined => {
  if (depth > 3) return undefined

  if (typeof value === 'string') {
    try {
      return parseManagePackagesResultValue(JSON.parse(value), depth + 1)
    } catch {
      return undefined
    }
  }

  if (!isRecord(value)) return undefined
  for (const key of ['structuredContent', 'result'] as const) {
    const nested = parseManagePackagesResultValue(value[key], depth + 1)
    if (nested) return nested
  }

  if (Array.isArray(value.content)) {
    for (const block of value.content) {
      if (!isRecord(block) || block.type !== 'text') continue
      const nested = parseManagePackagesResultValue(block.text, depth + 1)
      if (nested) return nested
    }
  } else {
    const nested = parseManagePackagesResultValue(value.content, depth + 1)
    if (nested) return nested
  }

  return isManagePackagesResult(value) ? value : undefined
}

// Reads the install result the manage_packages tool returns as JSON content (or raw output).
const parseManagePackagesResult = (activity: ToolActivity): Record<string, unknown> | undefined => {
  for (const text of collectToolTexts(activity)) {
    const result = parseManagePackagesResultValue(text)
    if (result) return result
  }

  return parseManagePackagesResultValue(activity.rawOutput)
}

// Trims the install log for display: drops libmamba trace/debug verbosity and backtrace decoration
// (a failed conda attempt dumps hundreds of these), collapses blank-line runs. The R startup banner
// is already suppressed at the backend.
const cleanInstallLog = (log: string): string =>
  log
    .split('\n')
    .filter(
      (line) =>
        !/^\s*(trace|debug)\s+libmamba\b/u.test(line) &&
        !/libmamba.*Backtrace (Start|End)/u.test(line)
    )
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()

// Keeps a compact actionable failure when an ACP provider returns installer output as plain text
// instead of the structured manage_packages result envelope.
const getManagePackagesFallbackText = (activity: ToolActivity): string | undefined => {
  const contentText = collectToolTexts(activity).join('\n\n').trim()
  if (contentText) return cleanInstallLog(contentText)

  return typeof activity.rawOutput === 'string'
    ? trimDetail(cleanInstallLog(activity.rawOutput))
    : undefined
}

// Reads the requested package list from tool input for the row subtitle.
const getManagedPackageList = (activity: ToolActivity): string | undefined => {
  const rawInput = isRecord(activity.rawInput) ? activity.rawInput : undefined
  const packages = rawInput && Array.isArray(rawInput.packages) ? rawInput.packages : []
  const names = packages.filter((entry): entry is string => typeof entry === 'string')

  return names.length > 0 ? names.join(', ') : undefined
}

const formatPackageChange = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined
  const name = getRecordString(value, 'name')
  const change = getRecordString(value, 'change')
  const before = getRecordString(value, 'beforeVersion')
  const after = getRecordString(value, 'afterVersion')
  if (!name || !change) return undefined

  if (change === 'updated') return `${name}: ${before ?? 'unknown'} → ${after ?? 'unknown'}`
  if (change === 'installed' || change === 'observed') {
    return `${name}: ${change}${after ? ` ${after}` : ''}`
  }
  if (change === 'removed') return `${name}: removed${before ? ` ${before}` : ''}`
  if (change === 'unchanged') return `${name}: unchanged${after ? ` at ${after}` : ''}`
  return `${name}: ${change}`
}

// Summarizes a package install: which packages, the installer used, and a cleaned collapsible log —
// instead of dumping the raw { ok, needsRestart, log, method } JSON envelope into the transcript.
const buildManagePackagesDetails = (
  activity: ToolActivity,
  t: TranslateClause = identityTranslate
): ToolActivityDetails | undefined => {
  const result = parseManagePackagesResult(activity)

  // Nothing parseable to summarize; let the generic input/output view handle it.
  if (!result) return undefined

  const rawInput = isRecord(activity.rawInput) ? activity.rawInput : undefined
  const language = getRecordString(rawInput, 'language')
  const environment = getRecordString(rawInput, 'environment')
  const packages =
    rawInput && Array.isArray(rawInput.packages)
      ? rawInput.packages.filter((entry): entry is string => typeof entry === 'string')
      : []
  const subtitle = packages.length > 0 ? packages.join(', ') : getManagedPackageList(activity)
  const ok = typeof result.ok === 'boolean' ? result.ok : undefined
  const method = typeof result.method === 'string' ? trimDetail(result.method) : undefined
  const needsRestart = result.needsRestart === true
  const prefix = typeof result.prefix === 'string' ? trimDetail(result.prefix) : undefined
  const log = typeof result.log === 'string' ? cleanInstallLog(result.log) : ''
  const logTruncation = isRecord(result.logTruncation) ? result.logTruncation : undefined
  const droppedLogBytes =
    logTruncation &&
    Number.isSafeInteger(logTruncation.droppedBytes) &&
    Number(logTruncation.droppedBytes) > 0
      ? Number(logTruncation.droppedBytes)
      : undefined
  const error = typeof result.error === 'string' ? trimDetail(result.error) : undefined
  const packageChanges = Array.isArray(result.packageChanges)
    ? result.packageChanges.map(formatPackageChange).filter((change): change is string => !!change)
    : []
  const metaLabel = [
    ok === false ? t('failed') : method,
    needsRestart ? t('restart needed') : undefined,
    droppedLogBytes !== undefined
      ? t('log truncated ({{size}} dropped)', { size: formatByteSize(droppedLogBytes) })
      : undefined
  ]
    .filter(Boolean)
    .join(' · ')
  const sections: ToolDetailSection[] = []

  // Command section: show WHAT was requested (the invocation) and WHERE it installs (the resolved
  // env prefix), not just the output log — so the install command + location are always visible.
  const callArgs = [
    language ? `language="${language}"` : undefined,
    packages.length > 0 ? `packages=[${packages.map((pkg) => `"${pkg}"`).join(', ')}]` : undefined,
    environment ? `environment="${environment}"` : undefined
  ]
    .filter(Boolean)
    .join(', ')
  const commandText = [
    `manage_packages(${callArgs})`,
    prefix ? `installs into  ${prefix}${method ? `  (${method})` : ''}` : undefined
  ]
    .filter(Boolean)
    .join('\n')
  const commandSection = createCodeSection('Command', commandText)

  if (commandSection) sections.push(commandSection)

  const packagesSection = createCodeSection('Packages', packageChanges.join('\n'))
  if (packagesSection) sections.push(packagesSection)

  if (error) {
    const errorSection = createCodeSection('Error', error)

    if (errorSection) sections.push(errorSection)
  }

  if (log) {
    const logSection = createCodeSection('Log', log)

    if (logSection) sections.push({ ...logSection, collapsible: true })
  }

  return {
    displayName: 'Manage packages',
    subtitle,
    metaLabel: metaLabel.length > 0 ? metaLabel : undefined,
    sections
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

// Reads the SKILL.md document a load_skill call returned, when the output is a skill document.
// The expanded Skill row renders this markdown instead of the generic input/output sections.
const getSkillLoadDocument = (activity: ToolActivity): string | undefined => {
  if (!isSkillLoadActivity(activity)) return undefined

  const output = getOutputText(activity)

  return output ? extractSkillLoadDocument(output.code) : undefined
}

// Projects one tool activity into the structured, expandable detail model, or nothing for chips.
const buildToolActivityDetails = (
  activity: ToolActivity,
  t: TranslateClause = identityTranslate
): ToolActivityDetails | undefined => {
  if (isSkillActivity(activity) && !isSkillLoadActivity(activity)) return undefined
  // A load_skill call keeps the generic input/output sections but reads as "Skill · <name>"
  // instead of the raw mcp__skills__load_skill tool identifier.
  if (isSkillLoadActivity(activity)) {
    const details = buildGenericDetails(activity)

    return details
      ? { ...details, displayName: 'Skill', subtitle: getLoadedSkillName(activity) }
      : undefined
  }
  const literatureDetails = buildLiteratureDetails(activity)
  if (literatureDetails) return literatureDetails
  // Saved files show a metadata summary instead of dumping their (possibly base64) content.
  if (isArtifactWriteActivity(activity)) return buildArtifactDetails(activity)
  // File edits prefer a diff view, falling back to raw input/output when no diff is provided.
  if (isEditActivity(activity))
    return buildDiffDetails(activity, t) ?? buildGenericDetails(activity)
  // Package installs show which packages / installer and a cleaned log, not the raw result JSON.
  if (isManagePackagesActivity(activity)) {
    return buildManagePackagesDetails(activity, t) ?? buildGenericDetails(activity)
  }
  // Memory calls use concise actions and context instead of exposing their transport identities.
  if (getMemoryToolSuffix(activity)) {
    return buildMemoryDetails(activity, t) ?? buildGenericDetails(activity)
  }
  // Notebook runs (python/r cells, repl, bash) show their code and output, not the run-summary JSON.
  if (isNotebookKernelRunActivity(activity)) {
    return buildNotebookDetails(activity) ?? buildGenericDetails(activity)
  }
  if (activity.toolKind === 'execute') return buildExecuteDetails(activity, t)
  // Tool-discovery steps summarize the tools they found rather than repeating "ToolSearch".
  if (isToolSearchActivity(activity)) return buildToolSearchDetails(activity)
  // WebFetch shows the URL and fetched result; other fetches without a URL stay plain chips.
  if (activity.toolKind === 'fetch') return buildFetchDetails(activity)

  return buildGenericDetails(activity)
}

export {
  buildToolActivityDetails,
  getNotebookRunIdFromActivity,
  getNotebookRunStatusFromActivity,
  getSkillLoadDocument,
  getToolDisplayName,
  isEditActivity,
  getManagePackagesFallbackText,
  parseManagePackagesResult,
  isSkillActivity
}
export type {
  ToolActivityDetails,
  ToolCodeSection,
  ToolDetailSection,
  ToolDiffSection,
  ToolLiteratureSection
}
