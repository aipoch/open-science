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
      {
        phase: 'fetch-python',
        event: { code: 'preparing-packages', environment: 'default-python' },
        progress: 0.4
      },
      undefined
    )
    expect(ui).toEqual({
      kind: 'preparing',
      scope: 'python',
      phase: 'fetch-python',
      event: { code: 'preparing-packages', environment: 'default-python' },
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
    expect(ui).toEqual({ kind: 'preparing', scope: 'upgrade', phase: '', progress: 0 })
  })

  it('reports R preparation with progress message passthrough when scope is r', () => {
    const ui = deriveProvisionUi(
      status({ pythonReady: true, provisioning: true }),
      'r',
      { phase: 'fetch-r', event: { code: 'downloading-r-runtime' }, progress: 0.1 },
      undefined
    )
    expect(ui).toMatchObject({ kind: 'preparing', scope: 'r', progress: 0.1 })
  })

  it('uses the broadcast scope for automatic R provisioning', () => {
    const ui = deriveProvisionUi(
      status({ pythonReady: true, provisioning: true }),
      undefined,
      {
        phase: 'fetch-r',
        event: { code: 'downloading-r-runtime' },
        progress: 0.4,
        scope: 'r',
        sessionId: 'session-a'
      },
      undefined
    )

    expect(ui).toMatchObject({ kind: 'preparing', scope: 'r', sessionId: 'session-a' })
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

  it('keeps the gate closed when an active upgrade status refresh fails', () => {
    const s = status({ pythonReady: true, provisioning: true })
    expect(notebookGated(s, { kind: 'error', message: 'status unavailable' })).toBe(true)
  })

  it('gates an upgrade-scoped status error before the cached status observes provisioning', () => {
    const s = status({ pythonReady: true, provisioning: false })
    expect(
      notebookGated(s, { kind: 'error', message: 'status unavailable', scope: 'upgrade' })
    ).toBe(true)
  })

  it('does not gate Python while an R-only status refresh error is shown', () => {
    const s = status({ pythonReady: true, provisioning: true })
    expect(notebookGated(s, { kind: 'error', message: 'status unavailable', scope: 'r' })).toBe(
      false
    )
  })

  it('limits a session-scoped status refresh error to its owning notebook', () => {
    const s = status({ pythonReady: true, provisioning: true })
    const ui = {
      kind: 'error' as const,
      message: 'status unavailable',
      scope: 'python' as const,
      sessionId: 'session-a'
    }

    expect(notebookGated(s, ui, 'session-a')).toBe(true)
    expect(notebookGated(s, ui, 'session-b')).toBe(false)
  })

  it('does NOT gate while only R is preparing (Python stays usable)', () => {
    const s = status({ pythonReady: true, provisioning: true })
    expect(notebookGated(s, deriveProvisionUi(s, 'r', undefined, undefined))).toBe(false)
  })

  it('does not gate a different session during session-scoped Python preparation', () => {
    const s = status({ provisioning: true })
    const ui = deriveProvisionUi(
      s,
      undefined,
      {
        phase: 'fetch-python',
        event: { code: 'downloading-python-runtime' },
        progress: 0.2,
        scope: 'python',
        sessionId: 'session-a'
      },
      undefined
    )

    expect(notebookGated(s, ui, 'session-a')).toBe(true)
    expect(notebookGated(s, ui, 'session-b')).toBe(false)
  })

  it('does not gate a different session after session-scoped Python preparation fails', () => {
    const s = status({ provisioning: false })
    const ui = deriveProvisionUi(
      s,
      undefined,
      {
        phase: 'error',
        diagnostic: 'Python download failed',
        progress: 0,
        scope: 'python',
        sessionId: 'session-a'
      },
      'Python download failed'
    )

    expect(ui).toMatchObject({ kind: 'error', scope: 'python', sessionId: 'session-a' })
    expect(notebookGated(s, ui, 'session-a')).toBe(true)
    expect(notebookGated(s, ui, 'session-b')).toBe(false)
  })

  it('does not gate when ready', () => {
    const s = status({ pythonReady: true })
    expect(notebookGated(s, deriveProvisionUi(s, undefined, undefined, undefined))).toBe(false)
  })
})
