import { describe, expect, it } from 'vitest'
import { runtimeUpdateState } from './runtime-update-view'
import type { UpdateStatus } from '../../../shared/update'

const status = (extra: Partial<UpdateStatus>): UpdateStatus => ({
  state: 'ready',
  current: '1',
  ...extra
})
const recovery = (
  extra: Partial<NonNullable<UpdateStatus['recovery']>> = {}
): NonNullable<UpdateStatus['recovery']> => ({
  phase: 'preparing',
  runtime: 'running',
  installation: 'unchanged',
  canCancel: true,
  canRecover: false,
  canRetryInstall: false,
  ...extra
})
describe('runtime update fact projection', () => {
  it.each([
    ['controller-held', 'S06'],
    ['operation-pending', 'S34']
  ] as const)('distinguishes ownership from unfinished operations: %s', (detail, expected) => {
    expect(
      runtimeUpdateState(
        status({ reason: 'runtime-not-controlled', recovery: recovery({ detail }) })
      )
    ).toBe(expected)
  })
  it.each([
    ['other-runtime', 'S07'],
    ['occupancy-unknown', 'S33'],
    ['unsupported-channel', 'S32']
  ] as const)('does not invent an occupying service for %s', (detail, expected) => {
    expect(
      runtimeUpdateState(status({ reason: 'installation-busy', recovery: recovery({ detail }) }))
    ).toBe(expected)
  })
  it('requires clean exit and explicit install permission to continue installation', () => {
    expect(
      runtimeUpdateState(
        status({
          reason: 'runtime-stop-timeout',
          recovery: recovery({ runtime: 'stopped-clean', canRetryInstall: true })
        })
      )
    ).toBe('S10')
    expect(
      runtimeUpdateState(
        status({
          reason: 'runtime-stop-unclean',
          recovery: recovery({ runtime: 'stopped-unclean', canRetryInstall: true })
        })
      )
    ).toBe('S11')
  })
  it('never retries an unverified or incomplete installation', () => {
    for (const [installation, expected] of [
      ['unknown', 'S13'],
      ['incomplete', 'S14']
    ] as const) {
      expect(
        runtimeUpdateState(
          status({
            recovery: recovery({ runtime: 'stopped-clean', canRetryInstall: true, installation })
          })
        )
      ).toBe(expected)
    }
  })
  it.each([
    ['cancelling', 'S24'],
    ['checking', 'S29'],
    ['recovering', 'S25']
  ] as const)('projects %s', (phase, expected) => {
    expect(runtimeUpdateState(status({ recovery: recovery({ phase }) }))).toBe(expected)
  })
  it.each([
    ['cancelled', 'S15'],
    ['installed', 'S27'],
    ['recovered', 'S28']
  ] as const)('uses verified main outcome %s', (outcome, expected) => {
    expect(runtimeUpdateState(status({ outcome }))).toBe(expected)
  })
})
