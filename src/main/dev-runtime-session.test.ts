import { afterEach, expect, it, vi } from 'vitest'
import { readDevSession, relaunchWithDevSession } from './dev-runtime-session'

it('ignores inherited dev supervision metadata when the host build has not enabled it', () => {
  expect(readDevSession(false, '{invalid inherited metadata')).toBeUndefined()
  expect(() => readDevSession(true, '{invalid inherited metadata')).toThrow()
  expect(readDevSession(true, undefined)).toBeUndefined()
})

const session = {
  sessionId: '0c73434a-68b0-4f57-9bbc-098cfc385c38',
  workspaceRoot: '/dev-worktree',
  port: 12345,
  secret: 'a'.repeat(64)
}
afterEach(() => vi.unstubAllEnvs())

it.each([false, true])(
  'forwards dev ownership only during native relaunch, failure=%s',
  (fails) => {
    vi.stubEnv('OPEN_SCIENCE_DEV_SESSION', undefined)
    let inherited: unknown
    const relaunch = (): void => {
      inherited = readDevSession(true, process.env.OPEN_SCIENCE_DEV_SESSION)
      if (fails) throw new Error('native relaunch failed')
    }
    if (fails)
      expect(() => relaunchWithDevSession(session, relaunch)).toThrow('native relaunch failed')
    else relaunchWithDevSession(session, relaunch)
    expect(inherited).toEqual(session)
    expect(process.env.OPEN_SCIENCE_DEV_SESSION).toBeUndefined()
  }
)

it('preserves the existing environment and does not inject dev ownership into release relaunches', () => {
  vi.stubEnv('OPEN_SCIENCE_DEV_SESSION', 'existing-value')
  relaunchWithDevSession(session, () => {
    expect(readDevSession(true, process.env.OPEN_SCIENCE_DEV_SESSION)).toEqual(session)
  })
  expect(process.env.OPEN_SCIENCE_DEV_SESSION).toBe('existing-value')
  relaunchWithDevSession(undefined, () => {
    expect(process.env.OPEN_SCIENCE_DEV_SESSION).toBe('existing-value')
  })
})
