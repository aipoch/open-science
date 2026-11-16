import type { TFunction } from 'i18next'

import type { ManagedFileVersionDescriptor } from '../../../../../shared/managed-file-versions'
import type { PptxOperation, PptxSlideChange } from '../../../../../shared/pptx-edit'

const changeLabel = (change: PptxSlideChange, t: TFunction): string => {
  switch (change) {
    case 'text':
      return t('Text')
    case 'notes':
      return t('Speaker notes')
    case 'layout':
      return t('Layout')
    case 'geometry':
      return t('Position and size')
    case 'image':
      return t('Image')
    case 'table':
      return t('Table')
    case 'chart':
      return t('Chart')
    case 'shapes':
      return t('Shapes')
  }
}

const OPERATION_CHANGES: Record<PptxOperation['op'], PptxSlideChange | 'slides'> = {
  setText: 'text',
  setFrame: 'geometry',
  addTextbox: 'shapes',
  deleteShape: 'shapes',
  addSlide: 'slides',
  deleteSlide: 'slides',
  moveSlide: 'slides',
  duplicateSlide: 'slides',
  replaceImage: 'image',
  setNotes: 'notes',
  setTableCellText: 'table',
  setChartText: 'chart'
}

const authorLabel = (
  author: ManagedFileVersionDescriptor['author'],
  t: TFunction
): string | undefined =>
  author === 'agent' ? t('Agent') : author === 'user' ? t('You') : undefined

const isOperationName = (name: string): name is PptxOperation['op'] =>
  Object.hasOwn(OPERATION_CHANGES, name)

// Turns the stored operation summary (for example "setText x2, addSlide") into readable labels.
const versionSummaryLabel = (summary: string | undefined, t: TFunction): string | undefined => {
  if (!summary) return undefined
  if (summary === 'restore') return t('Restored an earlier version')
  const kinds = new Set(
    summary
      .split(', ')
      .map((part) => part.replace(/ x\d+$/, ''))
      .filter(isOperationName)
      .map((name) => OPERATION_CHANGES[name])
  )
  const labels = [...kinds].map((kind) => (kind === 'slides' ? t('Slides') : changeLabel(kind, t)))
  return labels.length ? labels.join(', ') : undefined
}

export { authorLabel, changeLabel, versionSummaryLabel }
