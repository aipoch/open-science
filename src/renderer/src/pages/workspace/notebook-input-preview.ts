import type { NotebookInputFileSummary } from '../../../../shared/notebook'

const previewIdForNotebookInput = (
  input: Pick<NotebookInputFileSummary, 'sourceKind' | 'sourceFileId'>
): string =>
  input.sourceKind === 'artifact-version' ? input.sourceFileId : `upload:${input.sourceFileId}`

export { previewIdForNotebookInput }
