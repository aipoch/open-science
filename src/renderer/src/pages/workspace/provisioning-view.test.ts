import { describe, expect, it } from 'vitest'

import type { ProvisionStatus } from '../../../../shared/notebook-env'
import { deriveProvisionUi, notebookGated } from './provisioning-view'

const status = (o: Partial<ProvisionStatus> = {}): ProvisionStatus => ({
  pythonReady: false,
  rReady: false,
  version: 0,
  provisioning: false,
  ...o
})

describe('deriveProvisionUi', () => {
  it('is ready when python is provisioned and nothing is in flight', () => {
    expect(
      deriveProvisionUi(status({ pythonReady: true }), undefined, undefined, undefined)
    ).toEqual({
      kind: 'ready'
    })
  })

  it('reports first-run python preparation (no env yet) with progress passthrough', () => {
    const ui = deriveProvisionUi(
      status({ provisioning: true }),
      'python',
      { phase: 'materialize', message: 'Preparing Python environment…', progress: 0.4 },
      undefined
    )
    expect(ui).toEqual({
      kind: 'preparing',
      scope: 'python',
      phase: 'materialize',
      message: 'Preparing Python environment…',
      progress: 0.4
    })
  })

  it('infers the upgrade scope when python is already ready but provisioning runs (auto upgrade)', () => {
    const ui = deriveProvisionUi(
      status({ pythonReady: true, provisioning: true }),
      undefined,
      undefined,
      undefined
    )
    expect(ui).toEqual({ kind: 'preparing', scope: 'upgrade', phase: '', message: '', progress: 0 })
  })

  it('reports R preparation with progress message passthrough when scope is r', () => {
    const ui = deriveProvisionUi(
      status({ pythonReady: true, provisioning: true }),
      'r',
      { phase: 'download', message: 'x', progress: 0.1 },
      undefined
    )
    expect(ui).toMatchObject({ kind: 'preparing', scope: 'r', message: 'x', progress: 0.1 })
  })

  it('surfaces an error when python is not ready and a provision attempt failed', () => {
    expect(
      deriveProvisionUi(status({ provisioning: false }), 'python', undefined, 'network unreachable')
    ).toEqual({ kind: 'error', message: 'network unreachable' })
  })

  it('stays ready (non-blocking) when an R attempt failed but python is ready', () => {
    expect(deriveProvisionUi(status({ pythonReady: true }), 'r', undefined, 'boom')).toEqual({
      kind: 'ready'
    })
  })
})

describe('notebookGated', () => {
  it('gates while python is not ready', () => {
    const s = status({ provisioning: true })
    expect(notebookGated(s, deriveProvisionUi(s, 'python', undefined, undefined))).toBe(true)
  })

  it('gates during an additive upgrade even though python is ready', () => {
    const s = status({ pythonReady: true, provisioning: true })
    expect(notebookGated(s, deriveProvisionUi(s, undefined, undefined, undefined))).toBe(true)
  })

  it('does NOT gate while only R is preparing (Python stays usable)', () => {
    const s = status({ pythonReady: true, provisioning: true })
    expect(notebookGated(s, deriveProvisionUi(s, 'r', undefined, undefined))).toBe(false)
  })

  it('does not gate when ready', () => {
    const s = status({ pythonReady: true })
    expect(notebookGated(s, deriveProvisionUi(s, undefined, undefined, undefined))).toBe(false)
  })
})
