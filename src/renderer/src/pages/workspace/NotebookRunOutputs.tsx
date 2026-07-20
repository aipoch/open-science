import type { NotebookOutput, NotebookRunRecord } from '../../../../shared/notebook'

// Shared "cell output" area for the notebook panel and the session dialog. Renders the structured
// run.outputs[] — text streams and echoed results as text, figures inline as images — so repl echoes
// (display text/plain) and plots (display image/png) show instead of only text.stdout/stderr. Older
// runs persisted before outputs[] existed fall back to the flattened text streams. Text bodies render
// ANSI SGR color codes as styled spans (terminal-like) rather than raw escape characters.

const preClassName =
  'max-h-64 overflow-y-auto whitespace-pre-wrap rounded bg-bg-200 p-2 font-mono text-xs'

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

// Renders one display bundle: each image mime inline, every other (text) mime as a text block.
const NotebookDisplayOutput = ({ data }: { data: Record<string, string> }): React.JSX.Element => (
  <>
    {Object.entries(data).map(([mime, payload], index) =>
      mime.startsWith('image/') ? (
        <img
          key={index}
          data-testid="notebook-output-image"
          src={`data:${mime};base64,${payload}`}
          alt="Figure output"
          className="max-h-80 max-w-full rounded border border-border-200 object-contain"
          draggable={false}
        />
      ) : (
        <pre
          key={index}
          data-testid="notebook-output-text"
          className={`${preClassName} text-text-200`}
        >
          {renderAnsi(payload)}
        </pre>
      )
    )}
  </>
)

// Renders one structured output entry, or null when it carries no visible content.
const renderOutput = (output: NotebookOutput, index: number): React.JSX.Element | null => {
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
      return <NotebookDisplayOutput key={index} data={output.data} />
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
    <div className="mt-2 space-y-1" data-testid="notebook-run-outputs">
      {stdout.trim().length > 0 ? (
        <pre className={`${preClassName} text-text-200`}>{renderAnsi(stdout)}</pre>
      ) : null}
      {stderr.trim().length > 0 ? (
        <pre className={`${preClassName} text-danger-000`}>{renderAnsi(stderr)}</pre>
      ) : null}
    </div>
  )
}

// Renders the captured output for one run, preferring structured outputs and falling back to text.
const NotebookRunOutputs = ({ run }: { run: NotebookRunRecord }): React.JSX.Element | null => {
  if (run.outputs.length > 0) {
    const rendered = run.outputs
      .map((output, index) => renderOutput(output, index))
      .filter((node): node is React.JSX.Element => node !== null)

    if (rendered.length === 0) return null

    return (
      <div className="mt-2 space-y-1" data-testid="notebook-run-outputs">
        {rendered}
      </div>
    )
  }

  return <LegacyTextOutput run={run} />
}

export { NotebookRunOutputs }
