import type { NotebookRunRecord } from '../../../../shared/notebook'
import { getFileExtension, getImageMimeTypeForExtension, getPreviewFormat } from './preview-support'

type CapturedNotebookFigure = {
  source: 'captured'
  key: string
  mimeType: string
  payload: string
  name: string
}

type WorkingFileNotebookFigure = {
  source: 'working-file'
  key: string
  path: string
  name: string
  previewKind: 'image' | 'tiff' | 'pdf'
  mimeType: string
  size?: number
  mtimeMs?: number
}

type NotebookRunFigure = CapturedNotebookFigure | WorkingFileNotebookFigure

const getWorkingFileName = (relativePath: string, path: string): string => {
  const candidate = relativePath || path
  return candidate.split(/[\\/]/u).pop() || candidate
}

const getWorkingFileFigurePreview = (
  name: string
): Pick<WorkingFileNotebookFigure, 'previewKind' | 'mimeType'> | undefined => {
  const extension = getFileExtension(name)
  const format = getPreviewFormat(extension)

  if (format === 'tiff') return { previewKind: 'tiff', mimeType: 'image/tiff' }
  if (format === 'pdf') return { previewKind: 'pdf', mimeType: 'application/pdf' }
  if (format !== 'image') return undefined

  const mimeType = getImageMimeTypeForExtension(extension)
  return mimeType ? { previewKind: 'image', mimeType } : undefined
}

const resolveWorkingFileFigures = (run: NotebookRunRecord): WorkingFileNotebookFigure[] =>
  run.workingFiles.flatMap((file, index, files): WorkingFileNotebookFigure[] => {
    const name = getWorkingFileName(file.relativePath, file.path)
    const preview = getWorkingFileFigurePreview(name)

    if (!preview || files.findIndex((candidate) => candidate.path === file.path) !== index)
      return []

    return [
      {
        source: 'working-file',
        key: `working-file-${index}-${file.path}`,
        path: file.path,
        name,
        ...preview,
        size: file.size,
        mtimeMs: file.mtimeMs
      }
    ]
  })

// Captured figures and saved files are distinct run outputs, so preserve both. Every captured
// occurrence remains visible even when two plots happen to have identical bytes. Saved files only
// deduplicate repeated paths because those entries point to the same final file. Do not guess that a
// saved file is equivalent to a captured figure: proving that would require pulling saved image
// bytes into transcript state. The renderer keeps both sources UI-only instead.
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

  return [...captured, ...resolveWorkingFileFigures(run)]
}

const formatNotebookRunFigureMeta = (run: NotebookRunRecord): string | undefined => {
  const figureCount = resolveNotebookRunFigures(run).length

  if (figureCount === 0) return undefined

  const savedNames = resolveWorkingFileFigures(run).map((figure) => figure.name)
  const parts = [`${figureCount} figure${figureCount === 1 ? '' : 's'}`]

  if (savedNames.length > 0) parts.push(`Saved: ${savedNames.join(', ')}`)

  return parts.join(' · ')
}

export { formatNotebookRunFigureMeta, resolveNotebookRunFigures }
export type { NotebookRunFigure, WorkingFileNotebookFigure }
