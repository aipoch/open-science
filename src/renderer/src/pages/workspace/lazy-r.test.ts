import { describe, expect, it } from 'vitest'

import type { ProvisionStatus } from '../../../../shared/notebook-env'
import { shouldProvisionR } from './lazy-r'

const status = (o: Partial<ProvisionStatus> = {}): ProvisionStatus => ({
  pythonReady: true,
  rReady: false,
  version: 3,
  provisioning: false,
  ...o
})

describe('shouldProvisionR', () => {
  it('triggers when R is requested and not yet materialized', () => {
    expect(shouldProvisionR(status(), 'r')).toBe(true)
  })
  it('does not trigger for python', () => {
    expect(shouldProvisionR(status(), 'python')).toBe(false)
  })
  it('does not trigger when R is already ready', () => {
    expect(shouldProvisionR(status({ rReady: true }), 'r')).toBe(false)
  })
  it('does not double-trigger while provisioning is already running', () => {
    expect(shouldProvisionR(status({ provisioning: true }), 'r')).toBe(false)
  })
})
