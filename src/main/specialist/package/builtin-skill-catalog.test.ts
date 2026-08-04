import { describe, expect, it } from 'vitest'

import { composeBuiltinSkillCatalog } from './builtin-skill-catalog'

describe('composeBuiltinSkillCatalog', () => {
  it('keeps content compatibility stable across application versions', () => {
    const skill = {
      id: 'document-reader',
      source: 'featured' as const,
      compatibility: `sha256:${'a'.repeat(64)}`
    }

    expect(composeBuiltinSkillCatalog('0.9.2', [skill])).toEqual([
      { id: 'document-reader', appVersion: '0.9.2', compatibility: skill.compatibility }
    ])
    expect(composeBuiltinSkillCatalog('0.9.3', [skill])).toEqual([
      { id: 'document-reader', appVersion: '0.9.3', compatibility: skill.compatibility }
    ])
  })

  it('changes compatibility when bundled Skill content changes', () => {
    const before = composeBuiltinSkillCatalog('0.9.2', [
      { id: 'document-reader', source: 'featured', compatibility: `sha256:${'a'.repeat(64)}` }
    ])
    const after = composeBuiltinSkillCatalog('0.9.3', [
      { id: 'document-reader', source: 'featured', compatibility: `sha256:${'b'.repeat(64)}` }
    ])

    expect(after[0]?.compatibility).not.toBe(before[0]?.compatibility)
  })
})
