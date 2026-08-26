import { describe, expect, it } from 'vitest'

import { isMirrorConfigured, mirrorStatusText, MIRROR_HELP_URL } from './mirror-view'
import { i18next } from '@/i18n'

// Pin English so the wording assertions stay stable regardless of the ambient locale.
const t = i18next.getFixedT('en')

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
    expect(mirrorStatusText(undefined, t)).toBe(
      'Not configured — packages come from the public hosts (conda.anaconda.org, pypi.org)'
    )
  })
  it('summarizes the configured hosts when set', () => {
    expect(
      mirrorStatusText({ condaChannel: 'https://c', pypiIndex: 'https://p/simple' }, t)
    ).toContain('https://c')
  })
  it('translates the sentence but keeps the host values verbatim', () => {
    const zh = i18next.getFixedT('zh-Hans')
    expect(mirrorStatusText(undefined, zh)).toContain('未配置')
    expect(mirrorStatusText({ condaChannel: 'https://c' }, zh)).toBe('正在从 https://c 获取软件包')
  })
})

describe('MIRROR_HELP_URL', () => {
  it('is a non-empty URL string', () => {
    expect(MIRROR_HELP_URL.length).toBeGreaterThan(0)
  })
})
