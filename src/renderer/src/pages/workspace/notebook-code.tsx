import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

import { HighlightedCodeLines } from './HighlightedCodeLines'

const NotebookCodeBlock = ({
  code,
  language,
  highlightLine
}: {
  code: string
  language?: string
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
            <HighlightedCodeLines
              code={code}
              language={language}
              highlightLine={highlightLine}
              rowClassName="flex min-w-max"
              lineNumberClassName="inline-block pr-4"
              contentClassName="min-w-0 flex-1 whitespace-pre break-normal"
            />
          </code>
        </pre>
      </div>
    </div>
  )
}

export { NotebookCodeBlock }
