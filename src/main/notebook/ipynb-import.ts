import type {
  NotebookKernelKind,
  NotebookOutput,
  NotebookRunRecord,
  NotebookTextOutput
} from '../../shared/notebook'

type IpynbImportContext = {
  createId: () => string
  importedAt: number
}

type IpynbImportResult = {
  runs: NotebookRunRecord[]
  skippedCellCount: number
}

type JsonObject = Record<string, unknown>

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const textValue = (value: unknown, field: string): string => {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    return value.join('')
  }
  throw new Error(`Invalid .ipynb ${field}: expected a string or string array.`)
}

const optionalObject = (value: unknown): JsonObject => (isObject(value) ? value : {})

const notebookKernel = (notebook: JsonObject): 'python' | 'r' => {
  const metadata = optionalObject(notebook.metadata)
  const kernelspec = optionalObject(metadata.kernelspec)
  const name = typeof kernelspec.name === 'string' ? kernelspec.name.toLowerCase() : ''
  const language = typeof kernelspec.language === 'string' ? kernelspec.language.toLowerCase() : ''
  return name === 'ir' || language === 'r' ? 'r' : 'python'
}

const cellKernel = (cell: JsonObject, fallback: 'python' | 'r'): NotebookKernelKind => {
  const metadata = optionalObject(cell.metadata)
  const openScience = optionalObject(metadata.open_science)
  const kernel = openScience.kernel
  if (kernel === 'python' || kernel === 'r' || kernel === 'repl' || kernel === 'bash') {
    return kernel
  }
  const tags = Array.isArray(metadata.tags) ? metadata.tags : []
  if (tags.includes('open-science-bash')) return 'bash'
  if (tags.includes('open-science-repl')) return 'repl'
  return fallback
}

const stripKernelMarker = (source: string, kernel: NotebookKernelKind): string => {
  if (kernel === 'bash' && source.startsWith('%%bash\n')) return source.slice('%%bash\n'.length)
  if (kernel === 'repl' && source.startsWith('%%javascript\n')) {
    return source.slice('%%javascript\n'.length)
  }
  return source
}

const mimeText = (value: unknown): string | null => {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    return value.join('')
  }
  return null
}

const mapDisplayData = (dataValue: unknown, executeResult: boolean): NotebookOutput | null => {
  if (!isObject(dataValue)) return null
  const entries = Object.entries(dataValue)
  if (entries.length === 1 && entries[0][0] === 'application/json') {
    return { type: 'json', data: entries[0][1] }
  }
  if (executeResult && entries.length === 1 && entries[0][0] === 'text/plain') {
    const text = mimeText(entries[0][1])
    return text === null ? null : { type: 'text', text }
  }

  const data: Record<string, string> = {}
  for (const [mime, value] of entries) {
    const text = mimeText(value)
    if (text !== null) data[mime] = text
  }
  return Object.keys(data).length > 0 ? { type: 'display', data } : null
}

const mapOutput = (value: unknown): NotebookOutput | null => {
  if (!isObject(value) || typeof value.output_type !== 'string') return null
  switch (value.output_type) {
    case 'stream': {
      const name = value.name === 'stderr' ? 'stderr' : 'stdout'
      return { type: 'stream', name, text: textValue(value.text, 'stream output') }
    }
    case 'error':
      return {
        type: 'error',
        name: typeof value.ename === 'string' ? value.ename : undefined,
        message: typeof value.evalue === 'string' ? value.evalue : undefined,
        traceback: textValue(value.traceback ?? '', 'error traceback')
      }
    case 'display_data':
      return mapDisplayData(value.data, false)
    case 'execute_result':
      return mapDisplayData(value.data, true)
    default:
      return null
  }
}

const textProjection = (outputs: NotebookOutput[]): NotebookTextOutput => {
  const stdout = outputs
    .filter(
      (output): output is Extract<NotebookOutput, { type: 'stream' }> =>
        output.type === 'stream' && output.name === 'stdout'
    )
    .map((output) => output.text)
    .join('')
  const stderr = outputs
    .filter(
      (output): output is Extract<NotebookOutput, { type: 'stream' }> =>
        output.type === 'stream' && output.name === 'stderr'
    )
    .map((output) => output.text)
    .join('')
  const traceback = outputs
    .filter(
      (output): output is Extract<NotebookOutput, { type: 'error' }> => output.type === 'error'
    )
    .map((output) => output.traceback)
    .join('\n')

  return {
    stdout,
    stderr,
    traceback,
    plain: [stdout, stderr].filter((text) => text.trim().length > 0)
  }
}

const readExecutionCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined

// Parses the supported nbformat 4 subset into durable, not-yet-executed run records. ID/time
// generation is injected so the projection is deterministic in tests.
const ipynbToRunRecords = (
  notebookValue: unknown,
  context: IpynbImportContext
): IpynbImportResult => {
  if (!isObject(notebookValue) || notebookValue.nbformat !== 4) {
    throw new Error('Unsupported .ipynb format: expected nbformat 4.')
  }
  if (!Array.isArray(notebookValue.cells)) {
    throw new Error('Invalid .ipynb: cells must be an array.')
  }

  const fallbackKernel = notebookKernel(notebookValue)
  const runs: NotebookRunRecord[] = []
  let skippedCellCount = 0

  for (const cellValue of notebookValue.cells) {
    if (!isObject(cellValue) || cellValue.cell_type !== 'code') {
      skippedCellCount += 1
      continue
    }
    const kernelKind = cellKernel(cellValue, fallbackKernel)
    const source = stripKernelMarker(textValue(cellValue.source, 'cell source'), kernelKind)
    const outputs = Array.isArray(cellValue.outputs)
      ? cellValue.outputs
          .map(mapOutput)
          .filter((output): output is NotebookOutput => output !== null)
      : []
    const metadata = optionalObject(cellValue.metadata)
    const openScience = optionalObject(metadata.open_science)
    const id = context.createId()
    const environment =
      (kernelKind === 'python' || kernelKind === 'r') &&
      typeof openScience.environment === 'string' &&
      openScience.environment.trim()
        ? openScience.environment
        : undefined

    runs.push({
      runId: `imported-run-${id}`,
      cellId: `imported-cell-${id}`,
      source: 'user',
      inputKind: 'cell',
      kernelKind,
      script: source,
      status: 'imported',
      startedAt: context.importedAt,
      executionCount: readExecutionCount(cellValue.execution_count),
      text: textProjection(outputs),
      outputs,
      artifacts: [],
      workingFiles: [],
      ...(environment ? { environment } : {})
    })
  }

  return { runs, skippedCellCount }
}

export { ipynbToRunRecords }
export type { IpynbImportContext, IpynbImportResult }
