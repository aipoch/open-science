import { cn } from '@/lib/utils'

import type { ToolDiffSection } from './workspace-tool-activity-details'

type WorkspaceToolDiffBlockProps = {
  section: ToolDiffSection
}

type DiffLine = {
  type: 'added' | 'removed'
  text: string
}

// Splits a text block into lines while preserving intentional blank lines.
const toLines = (value: string): string[] => value.replace(/\n$/u, '').split('\n')

// Builds a compact before/after diff: removed old lines followed by added new lines.
const buildDiffLines = (oldText: string | null, newText: string): DiffLine[] => {
  const removed: DiffLine[] = oldText
    ? toLines(oldText).map((text) => ({ type: 'removed', text }))
    : []
  const added: DiffLine[] = newText ? toLines(newText).map((text) => ({ type: 'added', text })) : []

  return [...removed, ...added]
}

// Renders a file edit as gutter-marked added/removed lines without a full LCS diff.
const WorkspaceToolDiffBlock = ({ section }: WorkspaceToolDiffBlockProps): React.JSX.Element => {
  const lines = buildDiffLines(section.oldText, section.newText)

  return (
    <pre
      data-testid="tool-diff-block"
      className="max-h-[320px] overflow-auto rounded-md border border-border-200 bg-bg-000 py-2.5 font-mono text-[12px] leading-relaxed"
    >
      <code className="block whitespace-pre">
        {lines.map((line, index) => (
          <span
            key={index}
            className={cn(
              'block px-3',
              line.type === 'added'
                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                : 'bg-rose-500/10 text-rose-700 dark:text-rose-400'
            )}
          >
            <span aria-hidden="true" className="mr-2 select-none opacity-70">
              {line.type === 'added' ? '+' : '−'}
            </span>
            {line.text || ' '}
          </span>
        ))}
      </code>
    </pre>
  )
}

export { WorkspaceToolDiffBlock }
