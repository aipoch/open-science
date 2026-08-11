import type { NotebookRunRecord } from '../../../../shared/notebook'

type CapturedNotebookFigure = {
  source: 'captured'
  key: string
  mimeType: string
  payload: string
  name: string
}

type NotebookRunFigure = CapturedNotebookFigure

// Notebook figures are kernel-captured cell output. Saved working files belong to the Artifact
// workflow and remain mutable paths, so rendering them here would both duplicate captured plots and
// let historical cells drift when a later run overwrites the file.
const resolveNotebookRunFigures = (run: NotebookRunRecord): NotebookRunFigure[] => {
  const captured: CapturedNotebookFigure[] = []

  run.outputs.forEach((output, outputIndex) => {
    if (output.type !== 'display') return

    Object.entries(output.data).forEach(([mimeType, payload], mimeIndex) => {
      if (!mimeType.startsWith('image/')) return

      captured.push({
        source: 'captured',
        key: `captured-${outputIndex}-${mimeIndex}`,
        mimeType,
        payload,
        name: `Figure ${captured.length + 1}`
      })
    })
  })

  return captured
}

const formatNotebookRunFigureMeta = (run: NotebookRunRecord): string | undefined => {
  const figureCount = resolveNotebookRunFigures(run).length

  if (figureCount === 0) return undefined

  return `${figureCount} figure${figureCount === 1 ? '' : 's'}`
}

export { formatNotebookRunFigureMeta, resolveNotebookRunFigures }
export type { NotebookRunFigure }
