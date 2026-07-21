import { describe, expect, it } from 'vitest'

import { effectiveMirror, resolveMirror } from './mirror'

describe('resolveMirror', () => {
  it('returns CN mirror endpoints for a Chinese locale', () => {
    const m = resolveMirror('zh-CN')
    expect(m.condaChannel).toMatch(/tuna|ustc|aliyun/i)
    expect(m.pypiIndex).toMatch(/tuna|ustc|aliyun/i)
  })

  it('is region-agnostic for zh without a region and still selects the CN default', () => {
    expect(resolveMirror('zh').condaChannel).toBeDefined()
  })

  it('returns public hosts (empty overrides) for a non-CN locale', () => {
    expect(resolveMirror('en-US')).toEqual({})
  })

  it('includes a CN cranMirror for a CN locale (Plan C R install fallback consumes it)', () => {
    expect(resolveMirror('zh-CN').cranMirror).toMatch(/tuna|ustc/i)
  })
})

describe('effectiveMirror', () => {
  it('prefers any user-configured field over the region default', () => {
    const configured = { pypiIndex: 'https://corp/pypi/simple' }
    expect(effectiveMirror(configured, 'zh-CN')).toEqual(configured)
  })

  it('falls back to the region default when nothing is configured', () => {
    expect(effectiveMirror(undefined, 'zh-CN')).toEqual(resolveMirror('zh-CN'))
    expect(effectiveMirror({}, 'zh-CN')).toEqual(resolveMirror('zh-CN'))
  })

  it('treats a user-configured cranMirror as an override too', () => {
    const configured = { cranMirror: 'https://corp/cran' }
    expect(effectiveMirror(configured, 'zh-CN')).toEqual(configured)
  })
})
