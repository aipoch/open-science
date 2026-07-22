// Dark terminal output box for job stdout/stderr (design.md §6 JobTerminalOutput).
// Background #0d1117 and color #c9d1d9 are component-local — not in global CSS tokens.
type JobTerminalOutputProps = {
  content: string | undefined
  emptyMessage?: string
}

// Renders the tail of stdout or stderr in a dark terminal-style box.
// Shows a dim empty-state prompt when no content is available.
export function JobTerminalOutput({
  content,
  emptyMessage = 'No output yet.'
}: JobTerminalOutputProps): React.JSX.Element {
  if (!content || content.trim().length === 0) {
    return (
      <div
        data-testid="job-terminal-empty"
        style={{
          background: '#0d1117',
          borderRadius: '8px',
          padding: '28px 16px',
          minHeight: '120px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '12px',
          color: '#3a3a50',
          textAlign: 'center'
        }}
      >
        {emptyMessage}
      </div>
    )
  }

  return (
    <pre
      data-testid="job-terminal-output"
      style={{
        background: '#0d1117',
        color: '#c9d1d9',
        borderRadius: '8px',
        padding: '12px 16px',
        fontFamily: "'SF Mono', 'Menlo', monospace",
        fontSize: '11.5px',
        lineHeight: 1.7,
        whiteSpace: 'pre',
        overflowX: 'auto',
        minHeight: '80px'
      }}
    >
      {content}
    </pre>
  )
}
