import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ spawn: vi.fn(), lines: [] as string[] }))
vi.mock('node:child_process', () => ({ spawnSync: fixture.spawn }))
vi.mock('../logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger')>()
  return {
    ...actual,
    createLogger: (scope: string) => ({
      ...actual.createLogger(scope),
      info: (message: string, data: unknown) =>
        fixture.lines.push(actual.formatLine('info', scope, message, data))
    })
  }
})

beforeEach(() => {
  vi.resetModules()
  fixture.lines.length = 0
  fixture.spawn.mockReset()
  vi.stubGlobal(
    'process',
    Object.defineProperties(Object.create(process), {
      platform: { value: 'darwin' },
      mas: { value: false }
    })
  )
})
afterEach(() => vi.unstubAllGlobals())

it.each([
  ['access-blocked', 'exists', 'Open Science (DEV)', 'legacy-identity-present'],
  ['exists', 'exists', 'Open-Science (DEV)', 'preferred-identity-present'],
  ['exists', 'access-blocked', 'Open-Science (DEV)', 'preferred-identity-present'],
  ['not-found', 'exists', 'Open Science (DEV)', 'legacy-identity-present'],
  ['not-found', 'not-found', 'Open-Science (DEV)', 'no-identity-confirmed'],
  ['error', 'unsupported', 'Open-Science (DEV)', 'no-identity-confirmed']
] as const)(
  'logs only executed probes and their original results: %s / %s',
  async (current, legacy, selected, selectionReason) => {
    fixture.spawn.mockImplementation((_executable: string, args: string[]) => {
      const identity = args[0]
      const status = identity === 'Open-Science (DEV)' ? current : legacy
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify({
          schemaVersion: 1,
          platform: 'darwin',
          identity,
          status,
          reason:
            status === 'exists'
              ? 'account-metadata-found'
              : status === 'not-found'
                ? 'account-not-found'
                : 'keychain-locked',
          osStatus: status === 'not-found' ? -25300 : 0,
          secret: 'RAW-HELPER-SECRET',
          account: 'PRIVATE-ACCOUNT'
        })
      }
    })
    const { selectStartupCredentialIdentity } = await import('./bootstrap')
    expect(selectStartupCredentialIdentity({ platform: 'darwin', packaged: false })).toMatchObject({
      appName: selected,
      exists: current === 'exists' || legacy === 'exists'
    })
    const executed =
      current === 'exists'
        ? [['Open-Science (DEV)', current]]
        : [
            ['Open-Science (DEV)', current],
            ['Open Science (DEV)', legacy]
          ]
    expect(fixture.spawn.mock.calls.map(([, args]) => args)).toEqual(
      executed.map(([name]) => [name])
    )
    const records = fixture.lines.map((line) => JSON.parse(line))
    expect(records.map(({ msg }) => msg)).toEqual([
      ...executed.flatMap(() => ['identity probe started', 'identity probe completed']),
      'identity selection completed'
    ])
    for (const [i, [appName, status]] of executed.entries()) {
      expect(records[i * 2].data).toEqual({
        appName,
        service: `${appName} Safe Storage`,
        accountOrder: [`${appName} Key`, appName]
      })
      expect(records[i * 2 + 1].data).toMatchObject({ appName, status })
    }
    const summary = records.at(-1).data
    expect(summary).toMatchObject({
      outcome: 'selected',
      appName: selected,
      reason: selectionReason,
      probes: executed.map(([appName, status], i) => ({ order: i + 1, appName, status }))
    })
    if (current === 'exists')
      expect(summary.skippedProbe).toEqual({
        appName: 'Open Science (DEV)',
        reason: 'preferred-identity-present'
      })
    else expect(summary.skippedProbe).toBeUndefined()
    if (current === 'access-blocked') expect(summary.probes[0].reason).toBe('keychain-locked')
    expect(fixture.lines.join('\n')).not.toMatch(
      /RAW-HELPER-SECRET|PRIVATE-ACCOUNT|both-identities-absent/
    )
  }
)

it('filters injected diagnostics and thrown errors in the final selection log', async () => {
  const { selectCredentialIdentity } = await import('./selection')
  const probe = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error('RAW-EXCEPTION-SECRET')
    })
    .mockReturnValueOnce({ status: 'access-blocked', reason: 'RAW-PRIVATE-REASON', osStatus: 1.5 })
  expect(selectCredentialIdentity({ platform: 'darwin', packaged: true, probe })).toMatchObject({
    appName: 'Open-Science',
    exists: false
  })
  const summary = JSON.parse(fixture.lines.at(-1)!).data
  expect(summary.probes).toEqual([
    { order: 1, appName: 'Open-Science', status: 'error', reason: 'probe-exception' },
    { order: 2, appName: 'Open Science', status: 'access-blocked' }
  ])
  expect(fixture.lines.join('\n')).not.toMatch(/RAW-/)
})
