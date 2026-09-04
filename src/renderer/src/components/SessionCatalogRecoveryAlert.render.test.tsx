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

  it('does not promise automatic repair for quarantined Session authority', () => {
    act(() =>
      root.render(
        <SessionCatalogRecoveryAlert
          recovery={{
            kind: 'damaged-authority',
            affectedFiles: [{ projectId: 'project-a', fileName: 'session-1.json' }]
          }}
          onRetry={vi.fn()}
        />
      )
    )

    expect(container.textContent).toContain('Project archive needs attention')
    expect(container.textContent).toContain('A damaged saved conversation was moved aside')
    expect(container.textContent).toContain('You can still permanently delete the project')
    expect(container.querySelector('[data-testid="session-persistence-retry"]')).toBeNull()
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

    expect(container.textContent).toContain('Open Science update required')
    expect(container.textContent).toContain(
      'A saved conversation requires a newer version of Open Science'
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
})
