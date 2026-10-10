import { describe, expect, it } from 'vitest'
import { ordinaryDraftKey, researchDraftKey, sameResearch } from './research-draft-identity'

const source = {
  sourceProjectId: 'p',
  sourceSessionId: 's',
  sourceImportId: 'i',
  sourceTitle: 'Study'
}

describe('research draft identity', () => {
  it('isolates ordinary drafts, other studies and separate imports of the same archive', () => {
    const keys = [
      ordinaryDraftKey('p'),
      researchDraftKey(source),
      researchDraftKey({ ...source, sourceSessionId: 's2' }),
      researchDraftKey({ ...source, sourceImportId: 'i2' }),
      researchDraftKey({ ...source, sourceProjectId: 'p2' })
    ]
    expect(new Set(keys).size).toBe(keys.length)
    expect(ordinaryDraftKey('p')).toBe('new:p')
  })
  it('retains draft identity across source renames', () => {
    expect(researchDraftKey({ ...source, sourceTitle: 'Renamed' })).toBe(researchDraftKey(source))
    expect(sameResearch(source, { ...source, sourceTitle: 'Renamed' })).toBe(true)
  })
  it('does not conflate identifiers containing separators', () => {
    expect(researchDraftKey({ ...source, sourceProjectId: 'p:s', sourceSessionId: 'i' })).not.toBe(
      researchDraftKey({ ...source, sourceProjectId: 'p', sourceSessionId: 's:i' })
    )
  })
})
