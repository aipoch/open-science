import { describe, it, expect } from 'vitest'
import { buildSpecialistIdentityAppend, buildSpecialistIdentityPrefix } from './identity'
import type { SpecialistProfileView } from '../../shared/specialist'
import { emptyFullAccessConfig, emptySelectedConfig } from '../../shared/specialist'

const makeProfile = (overrides: Partial<SpecialistProfileView> = {}): SpecialistProfileView => ({
  id: 'uuid-1',
  name: 'RNA-seq Reviewer',
  description: 'Reviews RNA-seq analysis quality.',
  systemPrompt: 'You are RNA-seq Reviewer. Focus on batch effects and QC.',
  enabled: true,
  capabilityMode: 'full',
  fullAccess: emptyFullAccessConfig(),
  selectedCapabilities: emptySelectedConfig(),
  revision: 1,
  ...overrides
})

describe('buildSpecialistIdentityAppend', () => {
  it('produces non-empty text for a profile with a systemPrompt', () => {
    const text = buildSpecialistIdentityAppend(makeProfile())
    expect(text.length).toBeGreaterThan(0)
  })

  it('includes the specialist name', () => {
    const text = buildSpecialistIdentityAppend(makeProfile())
    expect(text).toContain('Current Specialist: RNA-seq Reviewer')
  })

  it('revokes every earlier Specialist identity and behavior', () => {
    const text = buildSpecialistIdentityAppend(makeProfile())
    expect(text).toContain('supersedes and revokes every earlier Specialist identity')
    expect(text).toContain('Specialist-specific behavior')
  })

  it('includes the systemPrompt content verbatim', () => {
    const text = buildSpecialistIdentityAppend(makeProfile())
    expect(text).toContain('You are RNA-seq Reviewer. Focus on batch effects and QC.')
  })

  it('states that it specializes the common Open Science Agent identity', () => {
    const text = buildSpecialistIdentityAppend(makeProfile())
    expect(text).toContain('specializes the Open Science Agent')
  })

  it('closes the identity boundary and preserves app-owned constraints', () => {
    const text = buildSpecialistIdentityAppend(makeProfile())
    expect(text).toContain('<open_science_specialist_identity>')
    expect(text).toContain('</open_science_specialist_identity>')
    expect(text).toContain('does not grant capabilities or permissions')
    expect(text).toContain('provider/model safety')
    expect(text).toContain('tool, workflow, provenance, and exact-output rules')
  })

  it('returns empty string when systemPrompt is empty', () => {
    const text = buildSpecialistIdentityAppend(makeProfile({ systemPrompt: '' }))
    expect(text).toBe('')
  })

  it('returns empty string when systemPrompt is whitespace only', () => {
    const text = buildSpecialistIdentityAppend(makeProfile({ systemPrompt: '   ' }))
    expect(text).toBe('')
  })
})

describe('buildSpecialistIdentityPrefix', () => {
  it('produces non-empty text for a profile with a systemPrompt', () => {
    const text = buildSpecialistIdentityPrefix(makeProfile())
    expect(text.length).toBeGreaterThan(0)
  })

  it('includes the name', () => {
    const text = buildSpecialistIdentityPrefix(makeProfile())
    expect(text).toContain('RNA-seq Reviewer')
  })

  it('includes the systemPrompt content', () => {
    const text = buildSpecialistIdentityPrefix(makeProfile())
    expect(text).toContain('You are RNA-seq Reviewer. Focus on batch effects and QC.')
  })

  it('uses the same bounded content for append and per-turn prefix delivery', () => {
    const profile = makeProfile()
    expect(buildSpecialistIdentityPrefix(profile)).toBe(buildSpecialistIdentityAppend(profile))
  })

  it('returns empty string when systemPrompt is empty', () => {
    const text = buildSpecialistIdentityPrefix(makeProfile({ systemPrompt: '' }))
    expect(text).toBe('')
  })
})
