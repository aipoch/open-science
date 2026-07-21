import { describe, expect, it } from 'vitest'

import { isMirrorConfigured, mirrorStatusText, MIRROR_HELP_URL } from './mirror-view'

describe('isMirrorConfigured', () => {
  it('is false for undefined or all-empty', () => {
    expect(isMirrorConfigured(undefined)).toBe(false)
    expect(isMirrorConfigured({})).toBe(false)
  })
  it('is true when any field is set', () => {
    expect(isMirrorConfigured({ pypiIndex: 'https://p/simple' })).toBe(true)
  })
})

describe('mirrorStatusText', () => {
  it('shows the default public-hosts message when unconfigured', () => {
    expect(mirrorStatusText(undefined)).toBe(
      'Not configured — packages come from the public hosts (conda.anaconda.org, pypi.org)'
    )
  })
  it('summarizes the configured hosts when set', () => {
    expect(
      mirrorStatusText({ condaChannel: 'https://c', pypiIndex: 'https://p/simple' })
    ).toContain('https://c')
  })
})

describe('MIRROR_HELP_URL', () => {
  it('is a non-empty URL string', () => {
    expect(MIRROR_HELP_URL.length).toBeGreaterThan(0)
  })
})
