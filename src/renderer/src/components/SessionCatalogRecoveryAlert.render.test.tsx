// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionCatalogRecoveryAlert } from './SessionCatalogRecoveryAlert'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('SessionCatalogRecoveryAlert', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('keeps an unchanged recovery dismissed but shows a newly affected file', () => {
    const render = (fileName: string): void =>
      root.render(
        <SessionCatalogRecoveryAlert
          recovery={{ kind: 'damaged-authority', affectedFiles: [{ projectId: 'p', fileName }] }}
        />
      )
    act(() => render('first.json'))
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="session-persistence-dismiss"]')!
        .click()
    )
    act(() => render('first.json'))
    expect(container.querySelector('[data-testid="session-persistence-alert"]')).toBeNull()
    act(() => render('second.json'))
    expect(container.querySelector('[data-testid="session-persistence-alert"]')).not.toBeNull()
  })

  it('presents a partial Session scan as index repair before a Project action', () => {
    const onRetry = vi.fn()
    act(() =>
      root.render(
        <SessionCatalogRecoveryAlert
          recovery={{ kind: 'repairable', reason: 'session-scan' }}
          onRetry={onRetry}
        />
      )
    )

    expect(container.textContent).toContain('Project index needs repair')
    expect(container.textContent).toContain('Repair the index before archiving projects')
    const repair = container.querySelector<HTMLButtonElement>(
      '[data-testid="session-persistence-retry"]'
    )
    expect(repair?.textContent).toBe('Repair index')
    expect(container.querySelector('[data-testid="session-persistence-dismiss"]')).not.toBeNull()
    act(() => repair?.click())
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('explains blocked Compute dispatch and offers a recheck without promising repair', () => {
    const onRetry = vi.fn()
    act(() =>
      root.render(
        <SessionCatalogRecoveryAlert
          recovery={{
            kind: 'damaged-authority',
            affectedFiles: [{ projectId: 'project-a', fileName: 'session-1.json' }]
          }}
          onRetry={onRetry}
        />
      )
    )

    expect(container.textContent).toContain('Project archive needs attention')
    expect(container.textContent).toContain('A damaged saved conversation was moved aside')
    expect(container.textContent).toContain(
      'You can still permanently delete the affected project data'
    )
    expect(container.textContent).toContain('Compute jobs in affected Sessions may remain queued')
    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="session-persistence-retry"]'
    )
    expect(retry?.textContent).toBe('Recheck saved conversations')
    act(() => retry?.click())
    expect(onRetry).toHaveBeenCalledOnce()
    const dismiss = container.querySelector<HTMLButtonElement>(
      '[data-testid="session-persistence-dismiss"]'
    )
    expect(dismiss?.getAttribute('aria-label')).toBe('Dismiss storage warning')
    act(() => dismiss?.click())
    expect(container.querySelector('[data-testid="session-persistence-alert"]')).toBeNull()
  })

  it('shows the affected Session file identities on request', () => {
    const openRecoveryFolder = vi.fn().mockResolvedValue(undefined)
    act(() =>
      root.render(
        <SessionCatalogRecoveryAlert
          recovery={{
            kind: 'damaged-authority',
            affectedFiles: [
              { projectId: 'project-a', fileName: 'session-1.json' },
              { projectId: 'project-b', fileName: 'session-2.json' }
            ]
          }}
          onOpenRecoveryFolder={openRecoveryFolder}
        />
      )
    )

    const details = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'View affected conversations'
    )
    expect(details?.textContent).toBe('View affected conversations')
    act(() => details?.click())
    expect(document.body.textContent).toContain('session-1.json')
    expect(document.body.textContent).toContain('project-a')
    expect(document.body.textContent).toContain('session-2.json')
    expect(document.body.textContent).toContain('project-b')
    const openFolder = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Open recovery folder'
    )
    expect(openFolder).toBeDefined()
    act(() => openFolder?.click())
    expect(openRecoveryFolder).toHaveBeenCalledWith({ projectId: 'project-a' })
  })

  it('reports when a recovery folder cannot be opened', async () => {
    const openFailure = Promise.reject(new Error('access denied'))
    void openFailure.catch(() => undefined)
    const openRecoveryFolder = vi.fn().mockReturnValue(openFailure)
    act(() =>
      root.render(
        <SessionCatalogRecoveryAlert
          recovery={{
            kind: 'damaged-authority',
            affectedFiles: [{ projectId: 'project-a', fileName: 'session-1.json' }]
          }}
          onOpenRecoveryFolder={openRecoveryFolder}
        />
      )
    )

    const details = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'View affected conversations'
    )
    act(() => details?.click())
    const openFolder = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Open recovery folder'
    )
    await act(async () => {
      openFolder?.click()
      await openFailure.catch(() => undefined)
    })

    expect(
      [...document.body.querySelectorAll('[role="alert"]')].some((alert) =>
        alert.textContent?.includes('Could not open that folder.')
      )
    ).toBe(true)
  })

  it('does not offer overlay dismissal on the Settings archive reminder', () => {
    act(() =>
      root.render(
        <SessionCatalogRecoveryAlert
          inline
          recovery={{
            kind: 'damaged-authority',
            affectedFiles: [{ projectId: 'project-a', fileName: 'session-1.json' }]
          }}
        />
      )
    )

    expect(container.textContent).toContain('Project archive needs attention')
    expect(container.querySelector('[data-testid="session-persistence-dismiss"]')).toBeNull()
  })

  it('requires an app update without offering a destructive repair for future Session files', () => {
    act(() =>
      root.render(
        <SessionCatalogRecoveryAlert
          recovery={{ kind: 'unsupported-version', affectedFileCount: 1 }}
          onRetry={vi.fn()}
        />
      )
    )

    expect(container.textContent).toContain('Open-Science update required')
    expect(container.textContent).toContain(
      'A saved conversation requires a newer version of Open-Science'
    )
    expect(container.textContent).toContain('files stay unchanged')
    expect(container.querySelector('[data-testid="session-persistence-retry"]')).toBeNull()
  })

  it('keeps oversized Session files in place and offers their recovery folders', () => {
    const openRecoveryFolder = vi.fn().mockResolvedValue(undefined)
    act(() =>
      root.render(
        <SessionCatalogRecoveryAlert
          recovery={{
            kind: 'oversized-authority',
            affectedFiles: [{ projectId: 'project-a', fileName: 'session-1.json' }]
          }}
          onOpenRecoveryFolder={openRecoveryFolder}
        />
      )
    )

    expect(container.textContent).toContain('Conversation storage limit reached')
    expect(container.textContent).toContain('They were left unchanged and cannot be opened')
    const details = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'View affected conversations'
    )
    act(() => details?.click())
    expect(document.body.textContent).toContain('session-1.json')
    expect(document.body.textContent).toContain('Move them out of the Session folder')
  })

  it('keeps unfinished Project deletion recovery distinct from index repair', () => {
    act(() =>
      root.render(
        <SessionCatalogRecoveryAlert
          recovery={{ kind: 'project-deletion-recovery' }}
          onRetry={vi.fn()}
        />
      )
    )

    expect(container.textContent).toContain('Project recovery needs attention')
    expect(container.textContent).toContain('previous project deletion')
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="session-persistence-retry"]')
        ?.textContent
    ).toBe('Retry recovery')
  })
  it('requires confirmation, blocks duplicate deletion, and keeps remaining files open after recheck', async () => {
    const pending = Promise.withResolvers<void>()
    const remove = vi.fn(() => pending.promise)
    const recheck = vi.fn()
    const files = [
      { projectId: 'project-a', fileName: 'first.json' },
      { projectId: 'project-a', fileName: 'second.json' }
    ]
    const render = (affectedFiles = files): void =>
      root.render(
        <SessionCatalogRecoveryAlert
          recovery={{ kind: 'damaged-authority', affectedFiles }}
          onDeleteRecoveryFile={remove}
          onRetry={recheck}
        />
      )
    const button = (name: string): HTMLButtonElement | undefined =>
      [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent === name
      )
    act(() => render())
    act(() => button('View affected conversations')?.click())
    act(() => button('Delete damaged file')?.click())
    expect(document.body.textContent).toContain('This cannot be undone')
    expect(document.querySelector('[data-testid="session-recovery-details-dialog"]')).toBeNull()
    expect(document.body.textContent).not.toContain('second.json')
    expect(
      document.querySelectorAll('[data-testid="session-recovery-delete-dialog"] button')
    ).toHaveLength(2)
    expect(remove).not.toHaveBeenCalled()
    act(() => button('Cancel')?.click())
    expect(button('Permanently delete')).toBeUndefined()
    act(() => button('Delete damaged file')?.click())
    act(() => {
      button('Permanently delete')?.click()
      button('Permanently delete')?.click()
    })
    expect(remove).toHaveBeenCalledExactlyOnceWith(files[0])
    expect(button('Deleting…')?.disabled).toBe(true)
    expect(button('Cancel')?.disabled).toBe(true)
    expect(button('Close')).toBeUndefined()
    await act(async () => {
      pending.resolve()
      await pending.promise
    })
    expect(recheck).toHaveBeenCalledOnce()
    act(() => render([files[1]]))
    expect(document.querySelector('[data-testid="session-recovery-details-dialog"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('first.json')
    expect(document.body.textContent).toContain('second.json')
    act(() => root.render(<SessionCatalogRecoveryAlert recovery={{ kind: 'ready' }} />))
    expect(document.querySelector('[data-testid="session-recovery-details-dialog"]')).toBeNull()
  })

  it('returns to the remaining files when rechecking resolves the confirmation target', () => {
    const files = [
      { projectId: 'p', fileName: 'first.json' },
      { projectId: 'p', fileName: 'second.json' }
    ]
    const render = (affectedFiles = files): void =>
      root.render(
        <SessionCatalogRecoveryAlert
          recovery={{ kind: 'damaged-authority', affectedFiles }}
          onDeleteRecoveryFile={vi.fn()}
        />
      )
    const button = (name: string): HTMLButtonElement | undefined =>
      [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent === name
      )
    act(() => render())
    act(() => button('View affected conversations')?.click())
    act(() => button('Delete damaged file')?.click())
    expect(document.querySelector('[data-testid="session-recovery-delete-dialog"]')).not.toBeNull()
    act(() => render([files[1]]))
    expect(document.querySelector('[data-testid="session-recovery-delete-dialog"]')).toBeNull()
    expect(document.querySelector('[data-testid="session-recovery-details-dialog"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('first.json')
    expect(document.body.textContent).toContain('second.json')
  })

  it('reports deletion failure, rechecks partial removal and permits retry', async () => {
    const remove = vi
      .fn()
      .mockRejectedValueOnce(new Error('Access denied'))
      .mockResolvedValueOnce(undefined)
    const recheck = vi.fn()
    const button = (name: string): HTMLButtonElement | undefined =>
      [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent === name
      )
    act(() =>
      root.render(
        <SessionCatalogRecoveryAlert
          recovery={{
            kind: 'damaged-authority',
            affectedFiles: [{ projectId: 'p', fileName: 'first.json' }]
          }}
          onDeleteRecoveryFile={remove}
          onRetry={recheck}
        />
      )
    )
    act(() => button('View affected conversations')?.click())
    act(() => button('Delete damaged file')?.click())
    await act(async () => button('Permanently delete')?.click())
    expect(document.body.textContent).toContain('Could not delete all recovery copies')
    expect(recheck).toHaveBeenCalledOnce()
    expect(button('Permanently delete')?.disabled).toBe(false)
    await act(async () => button('Permanently delete')?.click())
    expect(remove).toHaveBeenCalledTimes(2)
    expect(recheck).toHaveBeenCalledTimes(2)
  })

  it('explains why compute-owned recovery copies cannot be deleted', async () => {
    const remove = vi
      .fn()
      .mockRejectedValue(new Error('Session recovery files still own compute jobs.'))
    const recheck = vi.fn()
    const button = (name: string): HTMLButtonElement | undefined =>
      [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent === name
      )
    act(() =>
      root.render(
        <SessionCatalogRecoveryAlert
          recovery={{
            kind: 'damaged-authority',
            affectedFiles: [{ projectId: 'p', fileName: 'first.json' }]
          }}
          onDeleteRecoveryFile={remove}
          onRetry={recheck}
        />
      )
    )
    act(() => button('View affected conversations')?.click())
    act(() => button('Delete damaged file')?.click())
    await act(async () => button('Permanently delete')?.click())
    expect(document.body.textContent).toContain('This conversation still has compute jobs.')
    expect(document.body.textContent).toContain('Their remote files are kept.')
    expect(document.body.textContent).toContain('first.json')
    expect(recheck).toHaveBeenCalledOnce()
  })

  it('does not offer deletion for oversized files', () => {
    act(() =>
      root.render(
        <SessionCatalogRecoveryAlert
          recovery={{
            kind: 'oversized-authority',
            affectedFiles: [{ projectId: 'p', fileName: 'large.json' }]
          }}
          onDeleteRecoveryFile={vi.fn()}
        />
      )
    )
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="session-persistence-action"]')
        ?.click()
    )
    expect(document.body.textContent).not.toContain('Delete damaged file')
  })
})
