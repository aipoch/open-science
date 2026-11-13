import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'

const { reconcileNativeIonScripts } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

const source = (
  text: string,
  index: number,
  left: number,
  right: number,
  baseline: number,
  height: number
): object => ({
  text,
  rect: [left, baseline - height, right, baseline],
  baseline,
  height,
  horizontal: true,
  sourceItem: { pageNumber: 1, index, text }
})

function nativeIonCell(): ReturnType<typeof JSON.parse> {
  const sourceTokens = [
    source('Ions of N', 10, 20, 68, 40, 10),
    source('+', 11, 68, 73, 35.7, 7),
    source('3', 12, 68, 72, 42.6, 7)
  ]
  return {
    text: 'Ions of N+ 3',
    textRuns: [
      { text: 'Ions of N', position: 'normal' },
      { text: '+', position: 'superscript' },
      { text: ' ', position: 'normal' },
      { text: '3', position: 'subscript' }
    ],
    sourceTokens
  }
}

it('keeps the count and charge attached to their shared native atom', () => {
  const cell = nativeIonCell()
  const items = structuredClone(cell.sourceTokens)
  const repairs: string[] = []
  reconcileNativeIonScripts([cell], repairs)
  expect(cell.text).toBe('Ions of N3+')
  expect(cell.textRuns).toEqual([
    { text: 'Ions of N', position: 'normal' },
    { text: '3', position: 'subscript' },
    { text: '+', position: 'superscript' }
  ])
  expect(cell.sourceTokens).toEqual(items)
  expect(repairs).toEqual(['native-ion-scripts-reconciled'])
})

it.each(['detached count', 'nonadjacent owner', 'same baseline'])(
  'leaves the input alone with %s',
  (variant) => {
    const cell = nativeIonCell()
    const [, charge, count] = cell.sourceTokens
    if (variant === 'detached count') count.rect = [80, count.rect[1], 84, count.rect[3]]
    if (variant === 'nonadjacent owner') count.sourceItem.index += 2
    if (variant === 'same baseline') count.baseline = charge.baseline
    const original = structuredClone(cell)
    const repairs: string[] = []
    reconcileNativeIonScripts([cell], repairs)
    expect(cell).toEqual(original)
    expect(repairs).toEqual([])
  }
)
