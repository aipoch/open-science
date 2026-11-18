import type { TFunction } from 'i18next'

import type {
  ChartOutline,
  PptxOperation,
  ShapeOutline,
  SlideOutline
} from '../../../../../shared/pptx-edit'
import type { PptxShapeEditorState } from './PptxShapeEditor'
import type { PptxTextField } from './PptxTextFieldsEditor'

type Paragraphs = Extract<PptxOperation, { op: 'setText' }>['paragraphs']
type FieldChange = { id: string; value: string }
type ChartTarget = Extract<PptxOperation, { op: 'setChartText' }>['target']

const textToParagraphs = (text: string): Paragraphs =>
  text.split('\n').map((line) => ({ runs: [{ text: line }] }))

const tableColumns = (table: readonly (readonly string[])[]): number =>
  Math.max(1, ...table.map((row) => row.length))

const tableFields = (table: readonly (readonly string[])[], t: TFunction): PptxTextField[] =>
  table.flatMap((row, r) =>
    row.map((value, c) => ({
      id: `${r}:${c}`,
      label: t('Row {{row}}, column {{column}}', { row: r + 1, column: c + 1 }),
      value
    }))
  )

const tableOperations = (
  slideId: number,
  shapeId: number,
  changed: readonly FieldChange[]
): PptxOperation[] =>
  changed.map(({ id, value }) => {
    const [row, col] = id.split(':').map(Number)
    return {
      op: 'setTableCellText',
      slideId,
      shapeId,
      row,
      col,
      paragraphs: textToParagraphs(value)
    }
  })

// Axis titles are offered only where the chart already has one: a chart without that axis
// (a pie, for example) would reject the edit.
const chartFields = (chart: ChartOutline, t: TFunction): PptxTextField[] => [
  { id: 'title', label: t('Chart title'), value: chart.title ?? '' },
  ...(chart.categoryAxisTitle !== undefined
    ? [{ id: 'categoryAxisTitle', label: t('Category axis title'), value: chart.categoryAxisTitle }]
    : []),
  ...(chart.valueAxisTitle !== undefined
    ? [{ id: 'valueAxisTitle', label: t('Value axis title'), value: chart.valueAxisTitle }]
    : []),
  ...chart.series.map((series, index) => ({
    id: `seriesName:${index}`,
    label: t('Series {{number}} name', { number: index + 1 }),
    value: series.name ?? ''
  })),
  // Categories are shared across series, so the first series lists them once.
  ...(chart.series[0]?.categories ?? []).map((value, index) => ({
    id: `category:${index}`,
    label: t('Category {{number}}', { number: index + 1 }),
    value
  }))
]

const chartOperations = (
  slideId: number,
  shapeId: number,
  changed: readonly FieldChange[]
): PptxOperation[] =>
  changed.map(({ id, value }) => {
    const [target, index] = id.split(':') as [ChartTarget, string | undefined]
    return {
      op: 'setChartText',
      slideId,
      shapeId,
      target,
      ...(index !== undefined ? { index: Number(index) } : {}),
      text: value
    }
  })

const shapeEditorFor = (
  slideId: number,
  shape: ShapeOutline,
  t: TFunction
): PptxShapeEditorState | undefined => {
  const { shapeId } = shape
  if (shape.kind === 'table' && shape.table) {
    return {
      kind: 'fields',
      title: t('Edit table'),
      fields: tableFields(shape.table, t),
      columns: tableColumns(shape.table),
      toOperations: (changed) => tableOperations(slideId, shapeId, changed)
    }
  }
  if (shape.kind === 'chart' && shape.chart) {
    return {
      kind: 'fields',
      title: t('Edit chart labels'),
      fields: chartFields(shape.chart, t),
      notice: t('Only the labels shown on the slide change. The chart data stays the same.'),
      toOperations: (changed) => chartOperations(slideId, shapeId, changed)
    }
  }
  if (shape.kind !== 'text') return undefined
  return {
    kind: 'text',
    label: t('Shape text'),
    value: shape.text ?? '',
    paragraphs: shape.paragraphs ?? textToParagraphs(shape.text ?? ''),
    toOperations: (value, paragraphs) => [
      { op: 'setText', slideId, shapeId, paragraphs: paragraphs ?? textToParagraphs(value) }
    ]
  }
}

const notesEditorFor = (slide: SlideOutline, t: TFunction): PptxShapeEditorState => ({
  kind: 'text',
  label: t('Speaker notes'),
  value: slide.notes,
  toOperations: (text) => [{ op: 'setNotes', slideId: slide.slideId, text }]
})

export {
  chartFields,
  chartOperations,
  notesEditorFor,
  shapeEditorFor,
  tableColumns,
  tableFields,
  tableOperations,
  textToParagraphs
}
