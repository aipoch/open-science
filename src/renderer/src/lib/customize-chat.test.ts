// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { docToSkillIds, docToText, emptyDoc } from '@/pages/workspace/composer/composer-doc'

import {
  buildCustomizePrefillDoc,
  CUSTOMIZE_PREFILL_TEXT,
  CUSTOMIZE_SKILL_PREFILL_TEXT,
  CUSTOMIZE_SKILL_REF
} from './customize-chat'

// The `/customize` prefill is a navigation/prefill intent only: a real picked-Skill node plus editable
// text, never an executable string or mutation approval. These tests pin the exact ComposerDoc shape
// and serialization so the Settings-to-composer journey matches the approved issue 01 prototype.
describe('customize-chat prefill doc', () => {
  it('exposes the customize skill reference as a real picked-Skill identity', () => {
    expect(CUSTOMIZE_SKILL_REF.id).toBe('customize')
    expect(CUSTOMIZE_SKILL_REF.name).toBe('Customize')
  })

  it('uses the two-space gap before the editable sentence', () => {
    expect(CUSTOMIZE_PREFILL_TEXT).toBe('  Help me create a new specialist.')
  })

  it('builds a doc with a real skill chip followed by the editable text node', () => {
    const doc = buildCustomizePrefillDoc()

    expect(doc.nodes).toHaveLength(2)
    expect(doc.nodes[0]).toEqual({ type: 'skill', id: 'customize', name: 'Customize' })
    expect(doc.nodes[1]).toEqual({ type: 'text', text: '  Help me create a new specialist.' })
  })

  it('serializes exactly to the requested composer text', () => {
    expect(docToText(buildCustomizePrefillDoc())).toBe(
      '/Customize  Help me create a new specialist.'
    )
  })

  it('builds the Skill Creator entry with the same Customize chip', () => {
    expect(CUSTOMIZE_SKILL_PREFILL_TEXT).toBe('  Help me create a new skill.')
    expect(docToText(buildCustomizePrefillDoc('skill'))).toBe(
      '/Customize  Help me create a new skill.'
    )
    expect(docToSkillIds(buildCustomizePrefillDoc('skill'))).toEqual(['customize'])
  })

  it('reports the customize skill id through the normal picked-Skill mechanism', () => {
    expect(docToSkillIds(buildCustomizePrefillDoc())).toEqual(['customize'])
  })

  it('never produces the empty doc', () => {
    expect(buildCustomizePrefillDoc()).not.toEqual(emptyDoc)
  })
})
