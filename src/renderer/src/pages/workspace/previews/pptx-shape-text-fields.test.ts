import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'

import type { ShapeOutline, SlideOutline } from '../../../../../shared/pptx-edit'
import {
  chartFields,
  chartOperations,
  notesEditorFor,
  shapeEditorFor,
  tableColumns,
  tableFields,
  tableOperations
} from './pptx-shape-text-fields'

const t = ((key: string, values?: Record<string, number>) =>
  key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''))) as TFunction

describe('pptx shape text fields', () => {
  it('maps ragged tables to a grid of cell fields and back', () => {
    const table = [['A', 'B', 'C'], ['D']]
    expect(tableColumns(table)).toBe(3)
    expect(tableFields(table, t).map(({ id, label }) => [id, label])).toEqual([
      ['0:0', 'Row 1, column 1'],
      ['0:1', 'Row 1, column 2'],
      ['0:2', 'Row 1, column 3'],
      ['1:0', 'Row 2, column 1']
    ])
    expect(tableOperations(256, 3, [{ id: '1:0', value: 'x\ny' }])).toEqual([
      {
        op: 'setTableCellText',
        slideId: 256,
        shapeId: 3,
        row: 1,
        col: 0,
        paragraphs: [{ runs: [{ text: 'x' }] }, { runs: [{ text: 'y' }] }]
      }
    ])
  })

  it('offers axis titles only where the chart has them', () => {
    const pie = { series: [{ categories: ['A', 'B'] }] }
    expect(chartFields(pie, t).map((field) => field.id)).toEqual([
      'title',
      'seriesName:0',
      'category:0',
      'category:1'
    ])
    const bar = { ...pie, categoryAxisTitle: 'Month', valueAxisTitle: '' }
    expect(chartFields(bar, t).map((field) => field.id)).toContain('valueAxisTitle')
  })

  it('turns chart field changes into indexed and unindexed operations', () => {
    expect(
      chartOperations(257, 5, [
        { id: 'title', value: 'Revenue' },
        { id: 'seriesName:1', value: 'South' }
      ])
    ).toEqual([
      { op: 'setChartText', slideId: 257, shapeId: 5, target: 'title', text: 'Revenue' },
      {
        op: 'setChartText',
        slideId: 257,
        shapeId: 5,
        target: 'seriesName',
        index: 1,
        text: 'South'
      }
    ])
  })

  it('picks an editor by shape kind', () => {
    const base = { shapeId: 2, name: 'Shape' }
    const text = shapeEditorFor(256, { ...base, kind: 'text', text: 'Hi' } as ShapeOutline, t)
    expect(text?.kind === 'text' && text.toOperations('Yo')).toEqual([
      { op: 'setText', slideId: 256, shapeId: 2, paragraphs: [{ runs: [{ text: 'Yo' }] }] }
    ])
    const table = shapeEditorFor(256, { ...base, kind: 'table', table: [['A']] } as ShapeOutline, t)
    expect(table).toMatchObject({ kind: 'fields', title: 'Edit table', columns: 1 })
    expect(shapeEditorFor(256, { ...base, kind: 'picture' } as ShapeOutline, t)).toBeUndefined()
    // A chart whose part could not be read has no outline to edit.
    expect(shapeEditorFor(256, { ...base, kind: 'chart' } as ShapeOutline, t)).toBeUndefined()
  })

  it('edits speaker notes as plain text', () => {
    const slide = { slideId: 256, notes: 'Hello' } as SlideOutline
    const editor = notesEditorFor(slide, t)
    expect(editor).toMatchObject({ kind: 'text', label: 'Speaker notes', value: 'Hello' })
    expect(editor.kind === 'text' && editor.toOperations('')).toEqual([
      { op: 'setNotes', slideId: 256, text: '' }
    ])
  })
})
