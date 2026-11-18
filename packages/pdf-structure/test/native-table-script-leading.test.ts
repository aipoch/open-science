import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { nativeTableScriptLeading } = await import(
  pathToFileURL(resolve('test/fixtures/native-table-script-leading.mjs')).href
)
const { findCaptionCandidates, captionKind } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
const { associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)

it.each(['raised', 'ordinary'])(
  'retains all table caption rows and their original rectangles with %s typography',
  (typography) => {
    const f = nativeTableScriptLeading(typography === 'ordinary' ? 'ordinary' : ''),
      before = structuredClone(f),
      captions = findCaptionCandidates([f.page], new Map([[1, f.rules]])),
      associated = associateTableCaptions(f.page, f.tables, captions, f.rules, [f.page])

    expect(captions).toHaveLength(1)
    expect(captions[0].lines).toHaveLength(4)
    expect(captions[0].lines.at(-1)).toBe('and report the final independent measurements.')
    expect(captions[0].rect).toEqual([50, 100, 500, 152])
    if (typography === 'raised') expect(captions[0].lines[1]).toContain('U²')
    expect(associated[0].caption).toEqual(captions[0])
    expect(f).toEqual(before)
  }
)

it.each(['figure', 'wide-gap', 'intervening-rule'])(
  'keeps the existing continuation boundary without complete raised table-row evidence: %s',
  (fault) => {
    const f = nativeTableScriptLeading(fault),
      before = structuredClone(f),
      captions = findCaptionCandidates([f.page], new Map([[1, f.rules]]))

    expect(captions).toHaveLength(1)
    expect(captions[0].lines).toHaveLength(2)
    expect(f).toEqual(before)
  }
)

it.each(['no-dominant-metrics', 'same-size-script'])(
  'preserves the already accepted paragraph when the ordinary grouping accepts %s',
  (fault) => {
    const f = nativeTableScriptLeading(fault),
      captions = findCaptionCandidates([f.page], new Map([[1, f.rules]]))
    expect(captions[0].lines).toHaveLength(4)
  }
)

it('retains prose-reference rejection and existing genuine Roman table labels', () => {
  const f = nativeTableScriptLeading('narrative')
  expect(findCaptionCandidates([f.page], new Map([[1, f.rules]]))).toEqual([])
  for (const text of ['TABLE I. Generic measurements.', 'TABLE II. Generic measurements.'])
    expect(captionKind(text)).toBe('table')
})
