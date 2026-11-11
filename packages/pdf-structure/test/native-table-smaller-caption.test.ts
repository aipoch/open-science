import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { anonymousSmallerTableCaption } = await import(
  pathToFileURL(resolve('test/fixtures/smaller-table-caption.mjs')).href
)
const { findCaptionCandidates, applyRuledCaptionRecovery } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
const { associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { nativePageTextPacketInventory } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)

it('retains the complete smaller-font paragraph above a closed native numeric table', async () => {
  const f = await anonymousSmallerTableCaption()
  try {
    expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeDefined()
    const before = structuredClone({ page: f.page, tokens: f.tokens, rules: f.rules })
    const captions = findCaptionCandidates([f.page], new Map([[1, f.rules]]))
    applyRuledCaptionRecovery(
      captions,
      structuredClone(captions),
      f.page,
      f.rules,
      f.tokens,
      f.context
    )
    expect(captions[0].lines).toEqual(f.caption)
    expect(
      associateTableCaptions(f.page, [{ rect: [143, 107, 463, 205] }], captions, f.rules, [
        f.page
      ])[0].caption?.lines
    ).toEqual(f.caption)
    expect({ page: f.page, tokens: f.tokens, rules: f.rules }).toEqual(before)
  } finally {
    await f.cleanup()
  }
})

it.each([
  'narrative',
  'closed-lead',
  'unclosed-tail',
  'missing-rail',
  'mismatched-rail',
  'foreign-text',
  'foreign-paint',
  'interior-rule',
  'prose-body'
])('does not attach a smaller paragraph without complete independent proof: %s', async (fault) => {
  const f = await anonymousSmallerTableCaption(fault)
  try {
    const captions = findCaptionCandidates([f.page], new Map([[1, f.rules]]))
    const before = structuredClone(captions)
    applyRuledCaptionRecovery(
      captions,
      structuredClone(captions),
      f.page,
      f.rules,
      f.tokens,
      f.context
    )
    expect(captions).toEqual(before)
  } finally {
    await f.cleanup()
  }
})

it.each(['foreign-paint', 'interior-rule'])(
  'does not hide original paint by omitting the current page inventory: %s',
  async (fault) => {
    const f = await anonymousSmallerTableCaption(fault)
    try {
      f.page.graphicsBounds = []
      if (fault === 'interior-rule') f.rules = f.rules.filter((r) => r[1] !== 90)
      expect(nativePageTextPacketInventory(f.page, f.tokens, f.context, true)).toBeDefined()
      const captions = findCaptionCandidates([f.page], new Map([[1, f.rules]]))
      const before = structuredClone(captions)
      applyRuledCaptionRecovery(
        captions,
        structuredClone(captions),
        f.page,
        f.rules,
        f.tokens,
        f.context
      )
      expect(captions).toEqual(before)
    } finally {
      await f.cleanup()
    }
  }
)

it.each([
  'missing-context',
  'source-text',
  'source-index',
  'source-page',
  'native-font-name',
  'font-baseline',
  'font-height',
  'font-horizontal',
  'font-rect',
  'native-row-width',
  'native-row-font',
  'duplicate-caption',
  'forged-rails',
  'changed-operator'
])('keeps authentic current native carriers bound: %s', async (fault) => {
  const f = await anonymousSmallerTableCaption()
  try {
    if (fault === 'source-text') f.tokens[1].sourceItem.text = 'Changed original.'
    if (fault === 'source-index') f.tokens[1].sourceItem.index++
    if (fault === 'source-page') f.tokens[1].sourceItem.pageNumber++
    if (fault === 'native-font-name')
      f.context.content.items[f.tokens[1].sourceItem.index].fontName = 'Changed font'
    if (fault === 'font-baseline') f.tokens[1].baseline += 0.1
    if (fault === 'font-height') f.tokens[1].height += 0.1
    if (fault === 'font-horizontal') f.tokens[1].horizontal = false
    if (fault === 'font-rect') f.tokens[1].rect[2] -= 0.1
    if (fault === 'native-row-width') f.page.lines[1].width -= 0.1
    if (fault === 'native-row-font') f.page.lines[1].fontSize += 0.1
    if (fault === 'forged-rails')
      for (const r of f.rules) {
        r[1]++
        r[3]++
      }
    if (fault === 'changed-operator') {
      const at = f.context.operators.argsArray.findIndex(
        (a) => typeof a?.[0]?.[0]?.unicode === 'string'
      )
      f.context.operators.argsArray[at][0][0].unicode = 'Changed'
    }
    const captions = findCaptionCandidates([f.page], new Map([[1, f.rules]]))
    if (fault === 'duplicate-caption') captions.push(structuredClone(captions[0]))
    const before = structuredClone(captions)
    applyRuledCaptionRecovery(
      captions,
      structuredClone(captions),
      f.page,
      f.rules,
      f.tokens,
      fault === 'missing-context' ? undefined : f.context
    )
    expect(captions).toEqual(before)
  } finally {
    await f.cleanup()
  }
})
