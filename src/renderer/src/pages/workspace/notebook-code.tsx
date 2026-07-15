import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { cn } from '@/lib/utils'

const pythonKeywords = new Set([
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'False',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'None',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'True',
  'try',
  'while',
  'with',
  'yield'
])

const pythonBuiltins = new Set([
  'dict',
  'enumerate',
  'float',
  'int',
  'len',
  'list',
  'open',
  'print',
  'range',
  'set',
  'str',
  'sum',
  'tuple',
  'zip'
])

const codeTokenPattern =
  /#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b|\s+|./g

// Provides lightweight Python token coloring without introducing a full Markdown/code editor.
// Distinct hues (keyword blue, string green, number purple, builtin the brand teal) keep tokens
// visually apart instead of collapsing onto one accent color.
const highlightPythonCode = (code: string): React.ReactNode[] => {
  const tokens = code.match(codeTokenPattern) ?? []

  return tokens.map((token, index) => {
    const className = token.startsWith('#')
      ? 'text-text-300'
      : token.startsWith('"') || token.startsWith("'")
        ? 'text-syntax-string'
        : /^\d/.test(token)
          ? 'text-syntax-number'
          : pythonKeywords.has(token)
            ? 'font-semibold text-syntax-keyword'
            : pythonBuiltins.has(token)
              ? 'text-primary'
              : 'text-text-000'

    return (
      <span key={`${token}-${index}`} className={className}>
        {token}
      </span>
    )
  })
}

// Renders code with stable line numbers while keeping text selectable. An optional 1-based
// highlightLine paints one row (the derived error line) with a danger background.
const LineNumberedCode = ({
  code,
  highlightLine
}: {
  code: string
  highlightLine?: number
}): React.JSX.Element => {
  const lines = code.length > 0 ? code.split('\n') : ['']
  const lineNumberWidth = String(lines.length).length + 1

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {lines.map((line, index) => (
        <div
          key={`${index}-${line}`}
          className={cn('flex min-w-max', highlightLine === index + 1 && 'bg-danger-900')}
        >
          <span
            className="inline-block select-none pr-4 text-right text-text-300"
            style={{ minWidth: `${lineNumberWidth + 1}ch` }}
          >
            {index + 1}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre">{highlightPythonCode(line)}</span>
        </div>
      ))}
    </div>
  )
}

// Read-only code block: line-numbered source with the error line highlighted, plus a copy button.
// The button lives in a non-scrolling wrapper so it stays pinned to the visible top-right even when
// the code scrolls horizontally (an absolute button inside the scroll container would drift off with
// wide lines and become unclickable).
const NotebookCodeBlock = ({
  code,
  highlightLine
}: {
  code: string
  highlightLine?: number
}): React.JSX.Element => {
  const [copied, setCopied] = useState(false)

  const copyCode = (): void => {
    if (!navigator.clipboard?.writeText) return

    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="group relative w-full bg-bg-200">
      <button
        type="button"
        className="absolute right-2 top-2 z-10 rounded bg-bg-300/80 p-1.5 text-text-300 opacity-60 backdrop-blur-sm transition-all duration-150 hover:bg-bg-300 hover:text-text-100 focus-visible:opacity-100 group-hover:opacity-100"
        aria-label={copied ? 'Copied' : 'Copy to clipboard'}
        onClick={copyCode}
      >
        {copied ? (
          <Check className="size-3.5" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
      </button>
      <div className="overflow-auto">
        <pre className="m-0 w-max min-w-full p-4 font-mono text-[13px] leading-[1.5]">
          <code>
            <LineNumberedCode code={code} highlightLine={highlightLine} />
          </code>
        </pre>
      </div>
    </div>
  )
}

export { LineNumberedCode, NotebookCodeBlock }
