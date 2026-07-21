import type { NotebookKernelKind, NotebookRunRecord } from '../../../../shared/notebook'

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

// Tab chip text for the per-kernel notebook switcher.
const kernelKindLabel = (kind: NotebookKernelKind): string => {
  switch (kind) {
    case 'python':
      return 'Python'
    case 'r':
      return 'R'
    case 'repl':
      return 'Agent SDK'
    case 'bash':
      return 'Bash'
  }
}

// Right-aligned per-cell origin label: blank for the analysis kernels (python/r cells look like
// ordinary notebook cells), and the kernel name for the control-plane kernels (repl/bash), which
// share the run history but did not originate from a notebook cell.
const kernelOriginLabel = (kind: NotebookKernelKind): string => {
  switch (kind) {
    case 'repl':
      return 'repl'
    case 'bash':
      return 'bash'
    default:
      return ''
  }
}

// The kernel that produced a run, for both the language chip and the per-kernel tab grouping.
// kernelKind is populated for every run since I1/I2; the detectCellLanguage heuristic is only a
// fallback for runs persisted before that field existed.
const resolveRunKernelKind = (run: NotebookRunRecord): NotebookKernelKind =>
  run.kernelKind ?? detectCellLanguage(run.script)

// The named env that produced a run, for the per-env selector (design D6). python/r runs default to
// their language's canonical env when `environment` is absent (legacy runs, pre-named-envs); repl/bash
// are not env-scoped.
const resolveRunEnvironment = (run: NotebookRunRecord): string | undefined => {
  const kind = resolveRunKernelKind(run)

  if (kind !== 'python' && kind !== 'r') return undefined

  return run.environment ?? (kind === 'r' ? 'default-r' : 'default-python')
}

// Display label for an env name: the canonical default envs read as "default"; named envs show as-is.
const environmentLabel = (name: string): string =>
  name === 'default-python' || name === 'default-r' ? 'default' : name

// 1-based error line for a run's badge. Prefers the line the kernel attributed to the failing
// statement (the R loop reports it on the error output), falling back to parsing a Python traceback.
const resolveRunErrorLine = (run: NotebookRunRecord): number | undefined => {
  for (const output of run.outputs) {
    if (output.type === 'error' && typeof output.line === 'number') return output.line
  }

  return deriveErrorLine(run.text.traceback)
}

export {
  deriveErrorLine,
  detectCellLanguage,
  environmentLabel,
  isProblemRunStatus,
  kernelKindLabel,
  kernelOriginLabel,
  resolveRunErrorLine,
  resolveRunEnvironment,
  resolveRunKernelKind
}
export type { CellLanguage }
