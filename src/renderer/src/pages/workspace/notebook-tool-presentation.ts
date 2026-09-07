import { matchNotebookControlTool } from './notebook-tool-names'
import { identityTranslate, type TranslateClause } from './workspace-translate-clause'

export type ToolSummary = {
  title: string
  subtitle?: string
  fields: Array<{ label: string; value: string; expandable?: boolean }>
  rows?: Array<{ title: string; detail?: string; status?: string; error?: string }>
  note?: string
  error?: string
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined
const scalar = (value: unknown): string | undefined =>
  text(value) ?? (typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined)

// Providers wrap the same MCP result in JSON text, content blocks or a bridge envelope.
export const readNotebookToolResult = (
  value: unknown,
  depth = 0
): Record<string, unknown> | undefined => {
  if (depth > 5) return undefined
  if (typeof value === 'string') {
    try {
      return readNotebookToolResult(JSON.parse(value), depth + 1)
    } catch {
      return undefined
    }
  }
  const item = record(value)
  if (!item) return undefined
  if (
    ['kernelStatus', 'runtimes', 'bound', 'bindingChanged'].some((key) => key in item) ||
    text(item.error)
  )
    return item
  for (const nested of [item.structuredContent, item.result]) {
    const found = readNotebookToolResult(nested, depth + 1)
    if (found) return found
  }
  if (Array.isArray(item.content)) {
    for (const block of item.content) {
      const found = readNotebookToolResult(record(block)?.text, depth + 1)
      if (found) return found
    }
  }
  return undefined
}

export const notebookInput = (value: unknown): Record<string, unknown> => {
  const input = record(value) ?? {}
  return record(input.arguments) ?? input
}

const statusLabel = (value: unknown, t: TranslateClause): string | undefined => {
  switch (value) {
    case 'idle':
      return t('Idle')
    case 'active':
      return t('Active')
    case 'completed':
      return t('Completed')
    case 'failed':
      return t('Failed')
    case 'running':
      return t('Running')
    case 'restarted':
      return t('Restarted')
    default:
      return text(value)
  }
}

export const isNotebookSummaryTool = (identity: string | undefined): boolean =>
  [
    'notebook_state',
    'list_notebook_runtimes',
    'notebook_bind_runtime',
    'notebook_switch_runtime',
    'notebook_restart'
  ].includes(matchNotebookControlTool(identity) ?? '')

export const buildNotebookToolSummary = (
  identity: string | undefined,
  rawInput: unknown,
  result?: Record<string, unknown>,
  t: TranslateClause = identityTranslate,
  approval = false
): ToolSummary | undefined => {
  const tool = matchNotebookControlTool(identity)
  if (!isNotebookSummaryTool(identity)) return undefined
  const input = notebookInput(rawInput)
  const fields: ToolSummary['fields'] = []
  const field = (label: string, value: unknown, expandable = false): void => {
    const formatted = scalar(value)
    if (formatted !== undefined)
      fields.push({ label, value: formatted, ...(expandable ? { expandable: true } : {}) })
  }
  const summary: ToolSummary = { title: '', fields, error: text(result?.error) }
  const language = (value: unknown): string | undefined =>
    value === 'r' ? 'R' : value === 'python' ? 'Python' : text(value)
  if (tool === 'notebook_restart') {
    summary.title = t('Restart notebook')
    field(t('Status'), statusLabel(result?.status, t))
    field(t('Kernel'), statusLabel(result?.kernelStatus, t))
    field(t('Cells'), result?.cells)
    if (approval) summary.note = t('Clears in-memory variables. Run history is preserved.')
    else if (result?.status === 'restarted' && !summary.error)
      summary.note = t('In-memory variables cleared. Run history preserved.')
  } else if (tool === 'notebook_bind_runtime' || tool === 'notebook_switch_runtime') {
    const bound = record(result?.bound)
    const target = record(result?.target)
    summary.title =
      tool === 'notebook_switch_runtime' ? t('Switch notebook runtime') : t('Bind notebook runtime')
    if (approval && tool === 'notebook_switch_runtime')
      summary.note = t(
        'Clears memory in the selected language kernel. Other kernels are unaffected.'
      )
    summary.subtitle = text(bound?.label)
    field(t('Language'), language(bound?.language ?? input.language))
    field(t('Version'), bound?.version)
    field(
      t('Runtime source'),
      bound?.source === 'managed'
        ? t('Managed')
        : bound?.source === 'external'
          ? t('External')
          : bound?.source
    )
    field(t('Status'), statusLabel(bound?.status, t))
    field(t('Runtime'), bound?.runtimeId ?? target?.runtimeId ?? input.runtimeId, !approval)
    if (result?.bindingChanged === true)
      summary.note = t('The runtime binding changed despite the error.')
  } else if (tool === 'list_notebook_runtimes') {
    summary.title = t('Notebook runtimes')
    if (approval) summary.note = t('Lists the notebook runtimes available to this conversation.')
    field(t('Language'), language(input.language))
    field(t('Limit'), input.limit)
    field(t('Offset'), input.offset)
    field(t('Total'), result?.runtimeCount)
    if (Array.isArray(result?.runtimes)) {
      summary.rows = result.runtimes.slice(0, 40).flatMap((entry) => {
        const runtime = record(entry)
        if (!runtime) return []
        return [
          {
            title: text(runtime.label) ?? text(runtime.runtimeId) ?? t('Runtime'),
            detail: [
              language(runtime.language),
              text(runtime.version),
              runtime.source === 'managed'
                ? t('Managed')
                : runtime.source === 'external'
                  ? t('External')
                  : text(runtime.source)
            ]
              .filter(Boolean)
              .join(' · '),
            status: runtime.bound === true ? t('Bound') : statusLabel(runtime.status, t),
            error:
              runtime.runnable === false
                ? (text(runtime.reason) ?? text(runtime.detail) ?? t('Unavailable'))
                : undefined
          }
        ]
      })
      if (!result.runtimes.length) summary.note = t('No runtimes returned.')
      else if (result.nextOffset !== undefined || result.runtimes.length > 40)
        summary.note = t('More runtimes are available. See details for pagination.')
    }
  } else {
    summary.title = t('Notebook state')
    if (approval) summary.note = t('Reads the current notebook environment and runtime state.')
    field(t('Kernel'), statusLabel(result?.kernelStatus, t))
    field(t('Cells'), result?.cellCount)
    field(t('Runs'), result?.runCount)
    field(t('Environments'), result?.environmentCount)
    if (Array.isArray(result?.environments)) {
      for (const environment of result.environments.slice(0, 4)) {
        const env = record(environment)
        if (env)
          field(
            language(env.kind) ?? t('Environment'),
            [text(env.environment), statusLabel(env.status, t)].filter(Boolean).join(' · ')
          )
      }
    }
    if (Array.isArray(result?.recentRuns)) {
      summary.rows = result.recentRuns
        .slice(-5)
        .reverse()
        .flatMap((entry) => {
          const run = record(entry)
          if (!run) return []
          return [
            {
              title: text(run.cellId) ?? text(run.runId) ?? t('Notebook run'),
              detail: [
                language(run.kernelKind),
                text(run.environment),
                scalar(run.executionCount) ? `#${scalar(run.executionCount)}` : undefined
              ]
                .filter(Boolean)
                .join(' · '),
              status: statusLabel(run.status, t),
              error: run.status === 'failed' ? text(run.outputPreview) : undefined
            }
          ]
        })
    }
    if (
      result?.historyCompacted === true ||
      (Array.isArray(result?.recentRuns) && result.recentRuns.length > 5)
    )
      summary.note = t('Recent runs only. Full history is available in the Notebook preview.')
  }
  return summary
}
