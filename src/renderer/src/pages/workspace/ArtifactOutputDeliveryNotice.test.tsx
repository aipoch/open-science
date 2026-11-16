// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactOutputDeliveryNotice } from './ArtifactOutputDeliveryNotice'
import type { ArtifactOutputDeliveryStatus } from '../../../../shared/managed-file-versions'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const identity = { source: 'artifact' as const, projectId: 'project-1', fileId: 'artifact-1' }
const pending: ArtifactOutputDeliveryStatus = {
  state: 'pending',
  versionId: 'version-2',
  relativePath: 'artifacts/project-1/session-1/report.md',
  canRetry: true
}
let container: HTMLDivElement
let root: Root
const retry = vi.fn()
const updated = vi.fn()
const render = async (delivery = pending): Promise<void> => {
  await act(async () =>
    root.render(
      <ArtifactOutputDeliveryNotice identity={identity} delivery={delivery} onUpdated={updated} />
    )
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { managedFileVersions: { retryOutputDelivery: retry } }
  })
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('Artifact ordinary project-file delivery', () => {
  it('distinguishes saved version from missing file and retries that exact version once', async () => {
    let finish!: (value: unknown) => void
    retry.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    await render()
    expect(container.textContent).toContain('Version saved; project file needs attention')
    expect(container.textContent).toContain(pending.relativePath)
    const button = container.querySelector('button')!
    await act(async () => {
      button.click()
      button.click()
    })
    expect(retry).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledWith({ ...identity, versionId: 'version-2' })
    expect(button.disabled).toBe(true)
    await act(async () => finish({ ok: true, value: { ...pending, state: 'delivered' } }))
    expect(updated).toHaveBeenCalledTimes(1)
  })
  it('shows external conflict without claiming the internal version failed', async () => {
    await render({ ...pending, state: 'conflict' })
    expect(container.textContent).toContain('changed outside the app')
    expect(container.textContent).toContain('Version saved')
  })
  it('retains explicit retry after an IPC failure without creating another version', async () => {
    retry.mockResolvedValue({
      ok: false,
      error: { code: 'STORAGE_UNAVAILABLE', message: 'disk detail' }
    })
    await render()
    await act(async () => container.querySelector('button')!.click())
    expect(container.textContent).toContain('The saved version is still available')
    expect(container.textContent).not.toContain('disk detail')
    expect(updated).not.toHaveBeenCalled()
    expect(container.querySelector('button')!.disabled).toBe(false)
  })
  it('does not expose the desktop-only retry on a browser without that capability', async () => {
    Object.defineProperty(window, 'api', { configurable: true, value: { managedFileVersions: {} } })
    await render()
    expect(container.textContent).toContain('Version saved')
    expect(container.querySelector('button')).toBeNull()
  })
  it('does not offer writes for completed or cancelled delivery', async () => {
    await render({ ...pending, state: 'delivered' })
    expect(container.textContent).toBe('')
    await render({ ...pending, state: 'cancelled', canRetry: false })
    expect(container.textContent).toBe('')
    expect(retry).not.toHaveBeenCalled()
  })
  it('does not refresh a different preview after its owner unmounts', async () => {
    let finish!: (value: unknown) => void
    retry.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    await render()
    await act(async () => container.querySelector('button')!.click())
    await act(async () => root.render(null))
    await act(async () => finish({ ok: true, value: pending }))
    expect(updated).not.toHaveBeenCalled()
  })
})
