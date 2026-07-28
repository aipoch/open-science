import { Database } from 'lucide-react'

import { formatByteSize, cn } from '@/lib/utils'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import {
  createNotebookInputPreviewKey,
  type NotebookInputFileSummary,
  type NotebookRunInputFile
} from '../../../../shared/notebook'
import { previewIdForNotebookInput } from './notebook-input-preview'
import { createPreviewFileItem } from './preview-file-item'

type NotebookInputDataStripProps = {
  inputFiles: readonly (NotebookRunInputFile | NotebookInputFileSummary)[]
  label?: string
  className?: string
}

const collectInputs = (
  inputFiles: readonly (NotebookRunInputFile | NotebookInputFileSummary)[]
): NotebookInputFileSummary[] => {
  const inputs = new Map<string, NotebookInputFileSummary>()
  for (const input of inputFiles) {
    const key = `${input.sourceKind}:${input.inputFileVersionId}`
    const existing = inputs.get(key)
    const publicInput = { ...input } as Partial<NotebookRunInputFile>
    delete publicInput.storageKey
    inputs.set(key, {
      ...(publicInput as NotebookInputFileSummary),
      association:
        existing?.association === 'resolver-accessed' || input.association === 'resolver-accessed'
          ? 'resolver-accessed'
          : 'turn-attached'
    })
  }
  return [...inputs.values()]
}

const NotebookInputDataStrip = ({
  inputFiles,
  label = 'Input data',
  className
}: NotebookInputDataStripProps): React.JSX.Element | null => {
  const inputs = collectInputs(inputFiles)
  const openPreview = usePreviewWorkbenchStore((state) => state.upsertAndActivateItem)
  if (inputs.length === 0) return null

  return (
    <section
      className={cn('flex items-center gap-2 overflow-x-auto', className)}
      aria-label={label}
      data-testid="notebook-input-data"
    >
      <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-text-200">
        <Database className="size-3.5" aria-hidden="true" />
        {label}
      </span>
      {inputs.map((input) => (
        <button
          key={`${input.sourceKind}:${input.inputFileVersionId}`}
          type="button"
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-bg-000 px-2 py-1 text-xs text-text-100 hover:bg-bg-200 hover:text-text-000"
          title={`${input.filename} · ${formatByteSize(input.sizeBytes)} · ${input.association}`}
          onClick={() =>
            openPreview(
              createPreviewFileItem({
                // Reuse the owning file's stable workbench identity. Selecting another immutable
                // Version refreshes the same Artifact/Upload tab instead of opening a duplicate.
                id: previewIdForNotebookInput(input),
                projectId: input.sourceProjectId,
                sessionId: input.sourceSessionId,
                path: createNotebookInputPreviewKey({
                  projectId: input.sourceProjectId,
                  sourceKind: input.sourceKind,
                  inputFileVersionId: input.inputFileVersionId
                }),
                name: input.filename,
                mimeType: input.contentType,
                source: 'notebook-input',
                size: input.sizeBytes,
                selectedVersionId: input.inputFileVersionId,
                versionNumber: input.sourceVersionNumber
              })
            )
          }
        >
          <span className="max-w-48 truncate">{input.filename}</span>
          {input.sourceVersionNumber !== undefined ? (
            <span className="font-mono text-[10px] text-text-300">
              v{input.sourceVersionNumber}
            </span>
          ) : null}
        </button>
      ))}
    </section>
  )
}

export { NotebookInputDataStrip }
