import type { NotebookOutput, NotebookRunRecord } from '../../../../shared/notebook'
import { resolveNotebookRunFigures } from './notebook-run-figures'

// Shared cell-output area for Notebook, Session dialog, and conversation tool rows. Text and figures
// are intentionally separate: text owns its collapse control, while every figure stays visible in an
// individual frame. Older runs without outputs[] fall back to flattened text streams. ANSI SGR codes
// render as styled spans (terminal-like) rather than raw escape characters.

const preClassName =
  'max-h-64 overflow-y-auto whitespace-pre-wrap rounded bg-bg-200 p-2 font-mono text-xs'
const figureImageClassName =
  'block h-auto max-h-[16rem] w-auto max-w-full rounded-lg border border-border-200 object-contain'

// Drops a single trailing newline so streamed text doesn't render an extra blank line.
const trimTrailingNewline = (text: string): string => text.replace(/\n$/u, '')

// Stringifies a json output payload without throwing on circular/non-serializable values.
const safeJson = (data: unknown): string => {
  try {
    return JSON.stringify(data, null, 2)
  } catch {
    return String(data)
  }
}

// --- ANSI SGR -> inline style (dependency-free; XSS-safe: parsed to text tokens, never innerHTML) ---

type AnsiStyle = {
  color?: string
  backgroundColor?: string
  fontWeight?: 'bold'
  fontStyle?: 'italic'
  textDecoration?: 'underline'
  opacity?: number
}

// Standard + bright 16-color foreground palette, tuned to read on the notebook's bg on light/dark.
const ANSI_FG: Record<number, string> = {
  30: '#555555',
  31: '#d64545',
  32: '#2e9e3b',
  33: '#c08a00',
  34: '#3b82c4',
  35: '#a54ea5',
  36: '#0a9a9a',
  37: '#aaaaaa',
  90: '#888888',
  91: '#f06a6a',
  92: '#4caf50',
  93: '#d4a017',
  94: '#6aa9f0',
  95: '#d16ad1',
  96: '#3fc0c0',
  97: '#e8e8e8'
}
const ANSI_BG: Record<number, string> = {
  40: '#555555',
  41: '#d64545',
  42: '#2e9e3b',
  43: '#c08a00',
  44: '#3b82c4',
  45: '#a54ea5',
  46: '#0a9a9a',
  47: '#dddddd',
  100: '#888888',
  101: '#f06a6a',
  102: '#4caf50',
  103: '#d4a017',
  104: '#6aa9f0',
  105: '#d16ad1',
  106: '#3fc0c0',
  107: '#eeeeee'
}

// Applies one SGR sequence's codes to the running style. Reset (0/empty) clears everything.
const applySgr = (style: AnsiStyle, codes: number[]): AnsiStyle => {
  let next: AnsiStyle = { ...style }
  for (const code of codes) {
    if (code === 0) next = {}
    else if (code === 1) next.fontWeight = 'bold'
    else if (code === 2) next.opacity = 0.7
    else if (code === 3) next.fontStyle = 'italic'
    else if (code === 4) next.textDecoration = 'underline'
    else if (code === 22) {
      delete next.fontWeight
      delete next.opacity
    } else if (code === 23) delete next.fontStyle
    else if (code === 24) delete next.textDecoration
    else if (code === 39) delete next.color
    else if (code === 49) delete next.backgroundColor
    else if (ANSI_FG[code]) next.color = ANSI_FG[code]
    else if (ANSI_BG[code]) next.backgroundColor = ANSI_BG[code]
  }
  return next
}

// eslint-disable-next-line no-control-regex -- ANSI SGR escapes are literal control chars by definition
const ANSI_SGR = /\[([0-9;]*)m/g

const hasStyle = (style: AnsiStyle): boolean => Object.keys(style).length > 0

// Renders text that may contain ANSI SGR color codes as React nodes (styled spans), stripping the
// escape sequences themselves. Returns the plain string untouched when there are no escapes.
const renderAnsi = (text: string): React.ReactNode => {
  if (!text.includes('[')) return text

  const nodes: React.ReactNode[] = []
  let style: AnsiStyle = {}
  let cursor = 0
  let key = 0
  let match: RegExpExecArray | null
  ANSI_SGR.lastIndex = 0

  const push = (chunk: string): void => {
    if (!chunk) return
    nodes.push(
      hasStyle(style) ? (
        <span key={key++} style={style}>
          {chunk}
        </span>
      ) : (
        chunk
      )
    )
  }

  while ((match = ANSI_SGR.exec(text)) !== null) {
    push(text.slice(cursor, match.index))
    const codes = match[1] === '' ? [0] : match[1].split(';').map((value) => Number(value))
    style = applySgr(style, codes)
    cursor = match.index + match[0].length
  }
  push(text.slice(cursor))

  return nodes
}

// --- output rendering ---

// Renders only the textual part of a display bundle. Figure mimes have a separate, always-visible
// surface below the independently collapsible text output.
const NotebookDisplayTextOutput = ({
  data
}: {
  data: Record<string, string>
}): React.JSX.Element | null => {
  const textEntries = Object.entries(data).filter(([mime]) => !mime.startsWith('image/'))

  if (textEntries.length === 0) return null

  return (
    <>
      {textEntries.map(([mime, payload]) => (
        <pre
          key={mime}
          data-testid="notebook-output-text"
          className={`${preClassName} text-text-200`}
        >
          {renderAnsi(payload)}
        </pre>
      ))}
    </>
  )
}

// Renders one structured output entry, or null when it carries no visible content.
const renderTextOutput = (output: NotebookOutput, index: number): React.JSX.Element | null => {
  switch (output.type) {
    case 'stream': {
      const text = trimTrailingNewline(output.text)

      if (text.trim().length === 0) return null

      return (
        <pre
          key={index}
          className={`${preClassName} ${output.name === 'stderr' ? 'text-danger-000' : 'text-text-200'}`}
        >
          {renderAnsi(text)}
        </pre>
      )
    }
    case 'text': {
      const text = trimTrailingNewline(output.text)

      if (text.trim().length === 0) return null

      return (
        <pre key={index} className={`${preClassName} text-text-200`}>
          {renderAnsi(text)}
        </pre>
      )
    }
    case 'json':
      return (
        <pre key={index} className={`${preClassName} text-text-200`}>
          {renderAnsi(safeJson(output.data))}
        </pre>
      )
    case 'error': {
      // The traceback already begins with the error type/message, so render it alone; only fall back
      // to name/message when there is no traceback. Prevents a doubled "Traceback …" header (the
      // mapper sets message to the traceback's first line).
      const traceback = output.traceback?.trim() ?? ''
      const body =
        traceback.length > 0
          ? output.traceback
          : [output.name, output.message].filter(Boolean).join(': ')

      if (body.trim().length === 0) return null

      return (
        <pre key={index} className={`${preClassName} text-danger-000`}>
          {renderAnsi(body)}
        </pre>
      )
    }
    case 'display':
      return <NotebookDisplayTextOutput key={index} data={output.data} />
    default:
      return null
  }
}

// Legacy fallback for runs persisted before outputs[] existed: split stdout and diagnostics.
const LegacyTextOutput = ({ run }: { run: NotebookRunRecord }): React.JSX.Element | null => {
  const stdout = run.text.stdout
  const stderr = [run.text.stderr, run.text.traceback]
    .filter((value) => value.trim().length > 0)
    .join('\n')

  if (stdout.trim().length === 0 && stderr.trim().length === 0) return null

  return (
    <>
      {stdout.trim().length > 0 ? (
        <pre className={`${preClassName} text-text-200`}>{renderAnsi(stdout)}</pre>
      ) : null}
      {stderr.trim().length > 0 ? (
        <pre className={`${preClassName} text-danger-000`}>{renderAnsi(stderr)}</pre>
      ) : null}
    </>
  )
}

const NotebookRunTextOutputs = ({ run }: { run: NotebookRunRecord }): React.JSX.Element | null => {
  let rendered: React.JSX.Element[]

  if (run.outputs.length > 0) {
    rendered = run.outputs
      .map((output, index) => renderTextOutput(output, index))
      .filter((node): node is React.JSX.Element => node !== null)
  } else {
    const legacy = <LegacyTextOutput run={run} />
    const hasLegacyText = [run.text.stdout, run.text.stderr, run.text.traceback].some(
      (value) => value.trim().length > 0
    )
    rendered = hasLegacyText ? [legacy] : []
  }

  if (rendered.length === 0) return null

  return (
    <details open className="group mt-2" data-testid="notebook-text-output">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-xs text-text-300">
        <span aria-hidden="true" className="transition-transform group-open:rotate-90">
          ▸
        </span>
        <span className="group-open:hidden">Show output</span>
        <span className="hidden group-open:inline">Hide output</span>
      </summary>
      <div className="space-y-1 pt-1">{rendered}</div>
    </details>
  )
}

const NotebookRunFigureOutputs = ({
  run,
  align = 'center'
}: {
  run: NotebookRunRecord
  align?: 'start' | 'center'
}): React.JSX.Element | null => {
  const figures = resolveNotebookRunFigures(run)

  if (figures.length === 0) return null

  return (
    <div className="mt-2 space-y-2" data-testid="notebook-figure-outputs">
      {figures.map((figure) => (
        <div key={figure.key} data-testid="notebook-figure-output" className="w-full">
          <div
            className={`flex min-h-24 w-full items-center ${align === 'start' ? 'justify-start' : 'justify-center'}`}
          >
            <img
              data-testid="notebook-output-image"
              src={`data:${figure.mimeType};base64,${figure.payload}`}
              alt={figure.name}
              className={figureImageClassName}
              draggable={false}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

// Composes the two independent output surfaces used by the notebook panel and session dialog.
const NotebookRunOutputs = ({ run }: { run: NotebookRunRecord }): React.JSX.Element | null => {
  const hasText =
    run.outputs.some((output) => {
      if (output.type === 'stream' || output.type === 'text') return output.text.trim().length > 0
      if (output.type === 'json' || output.type === 'error') return true
      return Object.keys(output.data).some((mime) => !mime.startsWith('image/'))
    }) ||
    (run.outputs.length === 0 &&
      [run.text.stdout, run.text.stderr, run.text.traceback].some(
        (value) => value.trim().length > 0
      ))
  const hasFigures = resolveNotebookRunFigures(run).length > 0

  if (!hasText && !hasFigures) return null

  return (
    <div data-testid="notebook-run-outputs">
      <NotebookRunTextOutputs run={run} />
      <NotebookRunFigureOutputs run={run} />
    </div>
  )
}

export { NotebookRunFigureOutputs, NotebookRunOutputs }
