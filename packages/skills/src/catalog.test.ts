import { describe, expect, it } from 'vitest'
import { mergeSkillCatalog, type BundledSkill } from '@aipoch/skills'

const skill = (overrides: Partial<BundledSkill> = {}): BundledSkill => ({
  id: 'personal-shared',
  name: 'shared',
  displayName: 'Shared',
  description: '',
  source: 'personal',
  updatedAt: '2026-02-01T00:00:00.000Z',
  sourceDir: '/unused',
  ...overrides
})

describe('mergeSkillCatalog', () => {
  it('keeps only the newest user Skill when Personal and Imported packages share a name', () => {
    const featured = skill({ id: 'featured', name: 'featured', source: 'featured' })
    const personal = skill()
    const imported = skill({
      id: 'imported-shared',
      source: 'imported',
      updatedAt: '2026-03-01T00:00:00.000Z'
    })
    expect(mergeSkillCatalog([featured], [personal, imported])).toEqual([featured, imported])
  })

  it.each(['personal', 'imported'] as const)(
    'excludes %s packages that use app-owned prefixes',
    (source) => {
      const user = ['os-private', 'mcp-private', 'ordinary'].map((name) =>
        skill({ id: `${source}-${name}`, name, source })
      )
      expect(mergeSkillCatalog([], user)).toEqual([user[2]])
    }
  )

  it.each(['personal', 'imported'] as const)(
    'protects bundled names and IDs against newer %s packages',
    (source) => {
      const featured = skill({
        id: 'bundled-id',
        name: 'bundled-name',
        source: 'featured',
        exposure: 'internal',
        updatedAt: '2026-01-01T00:00:00.000Z'
      })
      const nameCollision = skill({ id: `${source}-copy`, name: featured.name, source })
      const idCollision = skill({ id: featured.id, name: 'innocent-name', source })
      expect(mergeSkillCatalog([featured], [nameCollision, idCollision])).toEqual([featured])
    }
  )

  it('excludes every user Skill sharing an ID even when their names differ', () => {
    const personal = skill({ id: 'shared-sidecar-id', name: 'personal-package' })
    const imported = skill({ id: personal.id, name: 'imported-package', source: 'imported' })
    expect(mergeSkillCatalog([], [personal, imported])).toEqual([])
  })

  it('breaks equal timestamp ties by stable ID independently of input order', () => {
    const left = skill({ id: 'personal-a' })
    const right = skill({ id: 'personal-b' })
    expect(mergeSkillCatalog([], [left, right])).toEqual([right])
    expect(mergeSkillCatalog([], [right, left])).toEqual([right])
  })
})
