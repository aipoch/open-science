import type { NotebookRunRecord } from '../../../../shared/notebook'

// Groups the non-success terminal states rendered with a diagnostic error badge.
const isProblemRunStatus = (status: NotebookRunRecord['status']): boolean =>
  status === 'failed' || status === 'timeout' || status === 'interrupted'

// Best-effort 1-based error line, parsed from the user-code frames of a Python traceback. The
// executor compiles cells as "<cell>" (runtime errors) and ast.parse reports "<unknown>" (syntax
// errors); match only those, ignoring bridge "<string>" and importlib "<frozen ...>" frames, and
// keep the innermost. Returns undefined when none is present; presentational, never throws.
const deriveErrorLine = (traceback: string): number | undefined => {
  const pattern = /File "<(?:cell|unknown)>", line (\d+)/g
  let match: RegExpExecArray | null
  let line: number | undefined

  while ((match = pattern.exec(traceback)) !== null) {
    line = Number(match[1])
  }

  return line
}

type CellLanguage = 'python' | 'r' | 'bash'

// Heuristic language label for a cell. The runtime executes Python, but agents sometimes paste R or
// shell code, so surface the obvious cases instead of always labeling "python". Only strong signals
// switch the label; anything ambiguous stays "python".
const detectCellLanguage = (code: string): CellLanguage => {
  const text = code.trim()

  // The <- assignment operator and library() are strong R signals absent from idiomatic Python.
  if (/<-|\blibrary\s*\(/.test(text)) return 'r'

  // A shebang or a line beginning with a common shell command marks a bash cell.
  if (
    /^#!\s*\/\S*\b(?:sh|bash|zsh)\b/m.test(text) ||
    /^(?:ls|cd|pwd|echo|cat|grep|sed|awk|pip3?|npm|node|apt(?:-get)?|brew|export|mkdir|rm|cp|mv|curl|wget|git|conda|Rscript)\b/m.test(
      text
    )
  ) {
    return 'bash'
  }

  return 'python'
}

export { deriveErrorLine, detectCellLanguage, isProblemRunStatus }
export type { CellLanguage }
