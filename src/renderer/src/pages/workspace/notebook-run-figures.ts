import type { TFunction } from 'i18next'

import type { NotebookRunRecord } from '../../../../shared/notebook'

type CapturedNotebookFigure = {
  source: 'captured'
  key: string
  mimeType: string
  payload: string
  name: string
  index: number
  extension: string
}

type NotebookRunFigure = CapturedNotebookFigure

const imageExtensionForMimeType = (mimeType: string): string => {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/svg+xml':
      return 'svg'
    default:
      return mimeType.split('/')[1]?.replace(/\+xml$/u, '') || 'image'
  }
}

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
        name: `Figure ${captured.length + 1}`,
        index: captured.length + 1,
        extension: imageExtensionForMimeType(mimeType)
      })
    })
  })

  return captured
}

const countTextLines = (text: string): number => {
  const trimmed = text.trimEnd()
  return trimmed.trim().length > 0 ? trimmed.split(/\r?\n/u).length : 0
}

const countNotebookRunOutputLines = (run: NotebookRunRecord): number => {
  if (run.outputs.length === 0) {
    return [run.text.stdout, run.text.stderr, run.text.traceback, ...run.text.plain].reduce(
      (count, text) => count + countTextLines(text),
      0
    )
  }

  return run.outputs.reduce((count, output) => {
    switch (output.type) {
      case 'stream':
      case 'text':
        return count + countTextLines(output.text)
      case 'error':
        return count + countTextLines(output.traceback || [output.name, output.message].join(': '))
      case 'json': {
        try {
          return count + countTextLines(JSON.stringify(output.data, null, 2))
        } catch {
          return count + countTextLines(String(output.data))
        }
      }
      case 'display':
        return (
          count +
          Object.entries(output.data).reduce(
            (displayCount, [mimeType, payload]) =>
              mimeType.startsWith('image/') ? displayCount : displayCount + countTextLines(payload),
            0
          )
        )
    }
  }, 0)
}

const formatNotebookFigureFilename = (figure: NotebookRunFigure, t: TFunction): string =>
  `${t('Figure {{index}}', { index: figure.index })}.${figure.extension}`

const formatNotebookRunFigureMeta = (run: NotebookRunRecord, t: TFunction): string | undefined => {
  const figureCount = resolveNotebookRunFigures(run).length

  if (figureCount === 0) return undefined

  return t('{{count}} figures', { count: figureCount, defaultValue_one: '{{count}} figure' })
}

const formatNotebookRunOutputLineMeta = (
  run: NotebookRunRecord,
  t: TFunction
): string | undefined => {
  const lineCount = countNotebookRunOutputLines(run)

  if (lineCount === 0) return undefined

  return t('{{count}} lines of output', {
    count: lineCount,
    defaultValue_one: '{{count}} line of output'
  })
}

export {
  formatNotebookFigureFilename,
  formatNotebookRunFigureMeta,
  formatNotebookRunOutputLineMeta,
  resolveNotebookRunFigures
}
export type { NotebookRunFigure }
