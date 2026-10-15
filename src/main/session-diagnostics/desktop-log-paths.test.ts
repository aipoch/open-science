import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { resolveDesktopLogPaths } from './desktop-log-paths'

describe('desktop log path resolution', () => {
  it('returns the current and pre-split Desktop log locations of the profile', () => {
    const profile = join('/', 'profiles', 'one')
    expect(
      resolveDesktopLogPaths({
        configRoot: '/config',
        packaged: true,
        homePath: '/home/u',
        env: { OPEN_SCIENCE_USER_DATA: profile }
      })
    ).toEqual({
      desktopLogPath: join(profile, 'desktop-logs', 'main.log'),
      legacyDesktopLogPath: join(profile, 'logs', 'main.log')
    })
  })
  it('omits Desktop logs instead of throwing for an unusable profile', () => {
    expect(
      resolveDesktopLogPaths({
        configRoot: '/config',
        packaged: true,
        homePath: '/home/u',
        env: { OPEN_SCIENCE_USER_DATA: 'relative/path' }
      })
    ).toEqual({})
  })
})
