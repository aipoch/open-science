import { describe, expect, it } from 'vitest'

describe('window navigation policy', () => {
  it('allows only explicit external URL protocols', async () => {
    const policy = await import('./navigation-policy').catch(() => undefined)

    expect(policy).toBeDefined()
    expect(policy?.isAllowedExternalUrl('https://example.com/report')).toBe(true)
    expect(policy?.isAllowedExternalUrl('mailto:researcher@example.com')).toBe(true)
    expect(policy?.isAllowedExternalUrl('file:///Users/example/private.txt')).toBe(false)
    expect(policy?.isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
    expect(
      policy?.isAllowedExternalNavigation(
        'https://example.com/report',
        'file:///app/index.html',
        'file:///app/index.html'
      )
    ).toBe(true)
    expect(
      policy?.isAllowedExternalNavigation(
        'https://example.com/report',
        'open-science-preview://resource/report.html',
        'file:///app/index.html'
      )
    ).toBe(false)
  })

  it('keeps subframe navigation inside the managed preview protocol', async () => {
    const policy = await import('./navigation-policy').catch(() => undefined)

    expect(policy).toBeDefined()
    expect(
      policy?.isAllowedFrameNavigation('open-science-preview://resource/report.html', false)
    ).toBe(true)
    expect(policy?.isAllowedFrameNavigation('https://example.com/exfiltrate', false)).toBe(false)
    expect(
      policy?.isAllowedFrameNavigation(
        'https://app.example.com/workspace',
        true,
        'https://app.example.com/'
      )
    ).toBe(true)
    expect(
      policy?.isAllowedFrameNavigation(
        'https://example.com/exfiltrate',
        true,
        'https://app.example.com/'
      )
    ).toBe(false)
    expect(
      policy?.isAllowedFrameNavigation(
        'file://remote-host/app/index.html',
        true,
        'file:///app/index.html'
      )
    ).toBe(false)
  })
})
