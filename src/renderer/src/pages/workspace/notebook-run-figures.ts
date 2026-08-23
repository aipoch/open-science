import type { TFunction } from 'i18next'

import type { NotebookRunRecord } from '../../../../shared/notebook'

type CapturedNotebookFigure = {
  source: 'captured'
  key: string
  mimeType: string
  payload: string
  name: string
  filename?: string
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

const FIGURE_FILE_EXTENSIONS = new Set([
  'bmp',
  'gif',
  'jpeg',
  'jpg',
  'pdf',
  'png',
  'svg',
  'tif',
  'tiff',
  'webp'
])

const getWorkingFigureFilename = (relativePath: string): string | undefined => {
  const filename = relativePath.split(/[\\/]/u).at(-1)?.trim()
  const extension = filename?.split('.').at(-1)?.toLowerCase()
  return filename && extension && FIGURE_FILE_EXTENSIONS.has(extension) ? filename : undefined
}

const normalizeFigureExtension = (extension: string): string => {
  if (extension === 'jpeg') return 'jpg'
  if (extension === 'tif') return 'tiff'
  return extension
}

// Notebook figures remain the immutable kernel-captured payload. A single captured figure and a
// single saved visual file form the only unambiguous association available in persisted run data.
// Multiple candidates keep fallbacks rather than guessing from unrelated array order.
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

  const filenames = run.workingFiles.flatMap((file) => {
    const filename = getWorkingFigureFilename(file.relativePath)
    return filename ? [filename] : []
  })

  const savedExtension = filenames[0]?.split('.').at(-1)?.toLowerCase()
  const hasCompatibleFilename =
    captured.length === 1 &&
    filenames.length === 1 &&
    savedExtension !== undefined &&
    normalizeFigureExtension(savedExtension) === normalizeFigureExtension(captured[0].extension)

  return hasCompatibleFilename ? [{ ...captured[0], filename: filenames[0] }] : captured
}

const countTextLines = (text: string): number => {
  const trimmed = text.trimEnd()
  return trimmed.trim().length > 0 ? trimmed.split(/\r?\n/u).length : 0
}

const countNotebookRunOutputLines = (run: NotebookRunRecord): number => {
  const stdout = run.text.stdout.trimEnd()
  const stderr = run.text.stderr.trimEnd()
  const traceback = run.text.traceback.trimEnd()
  const streamParts = [stdout, stderr, stderr.includes(traceback) ? '' : traceback].filter(Boolean)
  const streamText = streamParts.join('\n')
  const displayParts = run.outputs.flatMap((output) => {
    if (output.type === 'text') return [output.text.trimEnd()]
    if (output.type === 'json') {
      try {
        const serialized = JSON.stringify(output.data, null, 2)
        return serialized ? [serialized] : []
      } catch {
        return []
      }
    }
    if (output.type === 'display') {
      return Object.entries(output.data).flatMap(([mimeType, payload]) =>
        mimeType.startsWith('image/') ? [] : [payload.trimEnd()]
      )
    }
    return []
  })
  const visibleParts = [
    ...streamParts,
    ...displayParts.filter((part) => part.trim().length > 0 && !streamText.includes(part))
  ]

  return countTextLines(visibleParts.join('\n'))
}

const formatNotebookFigureFilename = (figure: NotebookRunFigure, t: TFunction): string =>
  figure.filename ?? `${t('Figure {{index}}', { index: figure.index })}.${figure.extension}`

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
