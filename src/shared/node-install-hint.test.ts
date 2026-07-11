import { describe, expect, it } from 'vitest'

import { getNodeInstallHint } from './settings'

describe('getNodeInstallHint', () => {
  it('uses winget on Windows', () => {
    const hint = getNodeInstallHint('win32')

    expect(hint.command).toBe('winget install OpenJS.NodeJS.LTS')
    expect(hint.url).toContain('nodejs.org')
  })

  it('uses Homebrew on macOS', () => {
    expect(getNodeInstallHint('darwin').command).toBe('brew install node')
  })

  it('offers only the download page on Linux (no single command)', () => {
    const hint = getNodeInstallHint('linux')

    expect(hint.command).toBeUndefined()
    expect(hint.url).toContain('nodejs.org')
  })
})
