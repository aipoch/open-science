import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { NotebookRunRecord } from '../../../../shared/notebook'
import { NotebookCodeBlock } from './notebook-code'
import { NotebookRunEvidence } from './NotebookRunEvidence'
import { NotebookRunOutputs } from './NotebookRunOutputs'
import { NotebookInputDataStrip } from './NotebookInputDataStrip'
import {
  isProblemRunStatus,
  kernelOriginLabel,
  notebookRunStatusLabel,
  resolveRunErrorLine,
  resolveRunKernelKind
} from './notebook-cell-utils'

// One persisted run rendered as a notebook cell: header badges, code, and split stdout/stderr. The
// zero-based index is the cell number shown in [n], aligning the display with a notebook's cells.
export const NotebookRecordCell = ({
  run,
  index,
  showInputData = false,
  showEnvironmentCaptureWarning = true,
  code = run.script,
  showResult = true,
  children
}: {
  run: NotebookRunRecord
  index: number
  showInputData?: boolean
  showEnvironmentCaptureWarning?: boolean
  code?: string
  showResult?: boolean
  children?: ReactNode
}): React.JSX.Element => {
  const { t } = useTranslation()
  const isProblem = showResult && isProblemRunStatus(run.status)
  const statusLabel = showResult ? notebookRunStatusLabel(run.status) : undefined
  const errorLine = isProblem ? resolveRunErrorLine(run) : undefined
  const kind = resolveRunKernelKind(run)
  const originLabel = kernelOriginLabel(kind)

  return (
    <div className="px-4 py-3" data-testid="session-notebook-cell">
      <div className="mb-2 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span className="font-mono text-text-300">[{index}]</span>
          <span className="rounded bg-bg-300 px-1.5 py-0.5 text-text-200">{kind}</span>
          {isProblem ? (
            errorLine ? (
              <span className="rounded bg-danger-000 px-1.5 py-0.5 font-medium text-white">
                {t('error (line {{line}})', { line: errorLine })}
              </span>
            ) : (
              <span className="rounded bg-danger-900 px-1.5 py-0.5 text-danger-000">
                {t('error')}
              </span>
            )
          ) : statusLabel ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
              {t(statusLabel)}
            </span>
          ) : null}
        </div>
        {originLabel ? (
          <span className="font-mono text-text-300" data-testid="session-notebook-cell-origin">
            {originLabel}
          </span>
        ) : null}
      </div>
      {showInputData ? (
        <NotebookInputDataStrip
          inputFiles={run.inputFiles ?? []}
          className="mb-2 rounded-md border border-border bg-muted px-2 py-1.5"
        />
      ) : null}
      <NotebookCodeBlock
        code={code}
        language={kind === 'repl' ? 'javascript' : kind}
        highlightLine={errorLine}
      />
      {showResult ? (
        children !== undefined ? (
          children
        ) : (
          <>
            <NotebookRunOutputs run={run} />
            <NotebookRunEvidence
              run={run}
              showEnvironmentCaptureWarning={showEnvironmentCaptureWarning}
            />
          </>
        )
      ) : null}
    </div>
  )
}
