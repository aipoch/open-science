import { ResourceDetailActionsProvider } from '../marketplace/ResourceDetailLayout'
// @vitest-environment jsdom
import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { createTwoFilesPatch } from 'diff'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillMarketplace, type SkillMarketplaceView } from './SkillMarketplace'
import { filterSkillMarketplace, type SkillMarketplaceEntry } from './skill-marketplace-model'
import { useSettingsStore } from '@/stores/settings-store'
import type { SkillView } from '../../../../shared/settings'

import {
  marketplaceCatalog,
  marketplaceDetail,
  marketplaceEntry
} from '../../../../shared/__fixtures__/skill-marketplace'

const entries: SkillMarketplaceEntry[] = Array.from({ length: 40 }, (_, index) => ({
  ...marketplaceEntry,
  id: 'skill-' + index,
  displayName: 'Skill ' + String(index).padStart(2, '0')
}))
const list = vi.fn().mockResolvedValue({ ok: true, value: { ...marketplaceCatalog, entries } })
const install = vi.fn()
const remove = vi.fn()
const toggle = vi.fn()
const installedSkill: SkillView = {
  id: 'imported-abstract-trimmer',
  name: 'abstract-trimmer',
  displayName: 'Abstract Trimmer',
  description: 'Trim abstracts',
  source: 'imported',
  updatedAt: '2026-09-13',
  enabled: true
}
const detail = vi.fn().mockImplementation(async ({ id }) => ({
  ok: true,
  value: {
    ...marketplaceDetail,
    installation: { kind: 'not-installed' },
    entry: entries.find((item) => item.id === id) ?? marketplaceEntry
  }
}))
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  list.mockReset().mockResolvedValue({ ok: true, value: { ...marketplaceCatalog, entries } })
  install.mockReset()
  remove.mockReset()
  toggle.mockReset()
  detail.mockReset().mockImplementation(async ({ id }) => ({
    ok: true,
    value: {
      ...marketplaceDetail,
      installation: { kind: 'not-installed' },
      entry: entries.find((item) => item.id === id) ?? marketplaceEntry
    }
  }))
  useSettingsStore.setState({ skills: [] })
  vi.stubGlobal('api', {
    settings: {
      listSkillMarketplace: list,
      getSkillMarketplaceDetail: detail,
      installSkillMarketplace: install,
      getSkillMarketplaceBatch: vi.fn().mockResolvedValue(null),
      startSkillMarketplaceBatch: vi.fn(),
      stopSkillMarketplaceBatch: vi.fn(),
      deleteSkill: remove,
      setSkillEnabled: toggle
    }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('Skill Marketplace', () => {
  const detailView: SkillMarketplaceView = {
    kind: 'marketplace-detail',
    id: marketplaceEntry.id,
    displayName: marketplaceEntry.displayName,
    snapshotId: marketplaceCatalog.snapshotId
  }
  const installedDetail = {
    ...marketplaceDetail,
    installation: {
      kind: 'installed',
      version: '1.0.0',
      canUpdate: false,
      localSkillId: installedSkill.id
    }
  }
  const click = async (label: string, scope: ParentNode = container): Promise<void> => {
    const target = [
      ...scope.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
        'button:not([role="tab"]), input[type="checkbox"], [role="menuitem"]'
      )
    ].find((button) => button.textContent === label || button.getAttribute('aria-label') === label)
    expect(target, label).toBeDefined()
    await act(async () => target!.click())
  }
  const pointer = async (
    target: Element,
    type: 'pointerover' | 'pointerout',
    pointerType = 'mouse'
  ): Promise<void> => {
    const event = new MouseEvent(type, { bubbles: true })
    Object.defineProperty(event, 'pointerType', { value: pointerType })
    await act(async () => target.dispatchEvent(event))
  }
  const select = async (label: string, value: string): Promise<void> => {
    const trigger = container.querySelector<HTMLElement>(
      `[role="combobox"][aria-label="${label}"]`
    )!
    await act(async () =>
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    )
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) =>
      node.textContent?.startsWith(value)
    )
    expect(option).toBeDefined()
    await act(async () => option!.click())
    // Finish Radix's asynchronous focus restoration before the next simulated action.
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
  }
  it('keeps committed installation visible with a refresh warning and safely retries it', async () => {
    list.mockResolvedValue({
      ok: true,
      value: { ...marketplaceCatalog, entries: [entries[0]], installations: {} }
    })
    install
      .mockResolvedValueOnce({
        ok: true,
        value: {
          id: 'imported-one',
          status: 'imported',
          version: '1.0.0',
          refreshFailed: true
        }
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          id: 'imported-one',
          status: 'unchanged',
          version: '1.0.0'
        }
      })
    await act(async () => root.render(<SkillMarketplace view={detailView} onNavigate={vi.fn()} />))
    await click('Install')
    expect(container.textContent).toContain('Installed')
    expect(container.textContent).not.toContain('Skill installation failed')
    expect(container.textContent).toContain('Skills were installed, but runtime refresh failed.')
    await click('Retry')
    expect(install).toHaveBeenLastCalledWith({
      id: marketplaceEntry.id,
      snapshotId: marketplaceCatalog.snapshotId,
      expectedVersion: '1.0.0'
    })
    expect(container.textContent).not.toContain(
      'Skills were installed, but runtime refresh failed.'
    )
    expect(container.textContent).toContain('Installed')
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('reconciles drawer mutations from local receipts without resetting the list', async () => {
    list
      .mockResolvedValueOnce({
        ok: true,
        value: { ...marketplaceCatalog, entries, installations: {} }
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          ...marketplaceCatalog,
          entries,
          installations: { 'skill-0': installedDetail.installation }
        }
      })
    const onNavigate = vi.fn()
    await act(async () =>
      root.render(
        <SkillMarketplace
          view={{ kind: 'marketplace' }}
          onNavigate={onNavigate}
          localRevisionKey={0}
        />
      )
    )
    await click('Load more')
    await act(async () =>
      root.render(
        <SkillMarketplace
          view={{ kind: 'marketplace' }}
          onNavigate={onNavigate}
          localRevisionKey={1}
        />
      )
    )
    expect(list).toHaveBeenLastCalledWith({ snapshotId: marketplaceCatalog.snapshotId })
    expect(container.querySelectorAll('article')).toHaveLength(40)
    expect(container.querySelector('[data-skill-id="skill-0"]')?.textContent).toContain('Installed')
  })

  it('reconciles deletion in the retained Installed catalog without resetting browsing', async () => {
    useSettingsStore.setState({ skills: [installedSkill] })
    list
      .mockResolvedValueOnce({
        ok: true,
        value: {
          ...marketplaceCatalog,
          entries,
          installations: { 'skill-0': installedDetail.installation }
        }
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { ...marketplaceCatalog, entries, installations: {} }
      })
    await act(async () =>
      root.render(<SkillMarketplace view={{ kind: 'marketplace' }} onNavigate={vi.fn()} />)
    )
    await click('Load more')
    expect(container.querySelector('[data-skill-id="skill-0"]')?.textContent).toContain('Installed')
    await act(async () => useSettingsStore.setState({ skills: [] }))
    expect(list).toHaveBeenLastCalledWith({ snapshotId: marketplaceCatalog.snapshotId })
    expect(container.querySelectorAll('article')).toHaveLength(40)
    expect(container.querySelector('[data-skill-id="skill-0"]')?.textContent).not.toContain(
      'Installed'
    )
    expect(container.querySelector('[data-skill-id="skill-0"]')?.textContent).toContain('Install')
  })

  it('installs directly from a card without navigating and retains its details action', async () => {
    list.mockResolvedValue({
      ok: true,
      value: { ...marketplaceCatalog, entries, installations: {} }
    })
    let complete!: (result: unknown) => void
    install.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const navigate = vi.fn()
    await act(async () =>
      root.render(<SkillMarketplace view={{ kind: 'marketplace' }} onNavigate={navigate} />)
    )
    const card = container.querySelector('article')!
    const action = card.querySelector<HTMLButtonElement>('.skill-marketplace-install-action')!
    await act(async () => {
      action.click()
      action.click()
    })
    expect(install).toHaveBeenCalledExactlyOnceWith({
      id: entries[0].id,
      snapshotId: marketplaceCatalog.snapshotId,
      expectedVersion: null
    })
    expect(navigate).not.toHaveBeenCalled()
    expect(action.disabled).toBe(true)
    expect(action.textContent).toBe('Installing…')
    await act(async () =>
      complete({
        ok: true,
        value: { id: 'imported-skill-0', status: 'imported', version: '1.0.0' }
      })
    )
    expect(action.textContent).toBe('Installed')
    expect(action.disabled).toBe(false)
    expect(container.querySelector('article')).toBe(card)
    expect(list).toHaveBeenCalledTimes(1)
    await click('View details', card)
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'marketplace-detail', id: entries[0].id })
    )
  })

  it('opens details when installation state is unavailable and deduplicates its pending action', async () => {
    let complete!: (result: unknown) => void
    install.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const navigate = vi.fn()
    await act(async () =>
      root.render(<SkillMarketplace view={{ kind: 'marketplace' }} onNavigate={navigate} />)
    )
    const card = container.querySelector('article')!
    expect(card.querySelector('.skill-marketplace-install-action')).toBeNull()
    await click('View details', card)
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'marketplace-detail', id: entries[0].id })
    )
    expect(install).not.toHaveBeenCalled()
    const view = navigate.mock.lastCall![0]
    await act(async () => root.render(<SkillMarketplace view={view} onNavigate={navigate} />))
    const action = container.querySelector<HTMLButtonElement>('.skill-marketplace-install-action')!
    await act(async () => {
      action.click()
      action.click()
    })
    expect(install).toHaveBeenCalledExactlyOnceWith({
      id: entries[0].id,
      snapshotId: marketplaceCatalog.snapshotId,
      expectedVersion: null
    })
    expect(action.disabled).toBe(true)
    expect(action.textContent).toBe('Installing…')
    await act(async () =>
      complete({
        ok: true,
        value: { id: 'imported-skill-0', status: 'imported', version: '1.0.0' }
      })
    )
    expect(container.textContent).toContain('Installed version: 1.0.0')
    expect(list).toHaveBeenCalledTimes(1)
  })

  it.each(['not-installed', 'installed'] as const)(
    'keeps prerelease cards and details read-only when %s',
    async (kind) => {
      const entry = { ...marketplaceEntry, version: '2.0.0-rc.1' }
      const installation =
        kind === 'installed' ? { kind, version: '1.0.0', canUpdate: false } : { kind }
      list.mockResolvedValue({
        ok: true,
        value: {
          ...marketplaceCatalog,
          entries: [entry],
          installations: { [entry.id]: installation }
        }
      })
      detail.mockResolvedValue({ ok: true, value: { ...marketplaceDetail, entry, installation } })
      await act(async () =>
        root.render(<SkillMarketplace view={{ kind: 'marketplace' }} onNavigate={vi.fn()} />)
      )
      const card = container.querySelector('article')!
      expect(card.textContent).toContain(entry.displayName)
      expect(card.textContent).toContain('Unavailable')
      expect(card.querySelector('.skill-marketplace-install-action')).toBeNull()
      await act(async () =>
        root.render(<SkillMarketplace view={detailView} onNavigate={vi.fn()} />)
      )
      expect(container.textContent).toContain('Only stable releases can be installed.')
      expect(container.querySelector('.skill-marketplace-install-action')).toBeNull()
      expect(install).not.toHaveBeenCalled()
    }
  )

  it('excludes prereleases from batch counts and select-all while allowing stable build metadata', async () => {
    const batchEntries = entries.slice(0, 3).map((entry, index) => ({
      ...entry,
      version: ['1.0.0-beta.1', '2.0.0-rc.1', '1.0.0+build-1'][index]
    }))
    list.mockResolvedValue({
      ok: true,
      value: {
        ...marketplaceCatalog,
        entries: batchEntries,
        installations: { 'skill-1': { kind: 'installed', version: '1.0.0', canUpdate: false } }
      }
    })
    await act(async () =>
      root.render(<SkillMarketplace view={{ kind: 'marketplace-batch' }} onNavigate={vi.fn()} />)
    )
    expect(container.querySelectorAll('article')).toHaveLength(1)
    expect(container.querySelector('[data-skill-id="skill-2"]')).not.toBeNull()
    await click('Select all filtered results (1)')
    await click('Install…')
    expect(container.textContent).toContain('Review selection / 1')
    expect(container.textContent).toContain('skill-2: 1.0.0+build-1')
    expect(window.api.settings.startSkillMarketplaceBatch).not.toHaveBeenCalled()
  })
  it('shows expired verified cards immediately while revalidating in the background', async () => {
    let complete!: (result: unknown) => void
    list
      .mockResolvedValueOnce({
        ok: true,
        value: { ...marketplaceCatalog, entries, revalidate: true }
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve
          })
      )
    await act(async () =>
      root.render(<SkillMarketplace view={{ kind: 'marketplace' }} onNavigate={vi.fn()} />)
    )
    const card = container.querySelector('article')
    expect(card).not.toBeNull()
    expect(list.mock.calls.map(([request]) => request)).toEqual([undefined, { forceRefresh: true }])
    expect(container.querySelector('[data-slot="skill-marketplace-loading"]')).toBeNull()
    expect(container.textContent).not.toContain(
      'Could not refresh Marketplace. Showing the last available data.'
    )
    await act(async () => complete({ ok: true, value: { ...marketplaceCatalog, entries } }))
    expect(container.querySelector('article')).toBe(card)
  })

  it('keeps stale verified cards with a notice after failed revalidation and clears it after retry', async () => {
    const stale = { ok: true, value: { ...marketplaceCatalog, entries, revalidate: true } }
    list.mockResolvedValueOnce(stale).mockResolvedValueOnce(stale)
    await act(async () =>
      root.render(<SkillMarketplace view={{ kind: 'marketplace' }} onNavigate={vi.fn()} />)
    )
    const card = container.querySelector('article')
    expect(card).not.toBeNull()
    expect(container.textContent).toContain(
      'Could not refresh Marketplace. Showing the last available data.'
    )
    expect(list).toHaveBeenCalledTimes(2)
    await click('Refresh')
    expect(container.querySelector('article')).toBe(card)
    expect(container.textContent).not.toContain(
      'Could not refresh Marketplace. Showing the last available data.'
    )
  })

  it('keeps cards after a failed manual refresh without immediately repeating discovery', async () => {
    await act(async () =>
      root.render(<SkillMarketplace view={{ kind: 'marketplace' }} onNavigate={vi.fn()} />)
    )
    const card = container.querySelector('article')
    list.mockResolvedValueOnce({
      ok: true,
      value: { ...marketplaceCatalog, entries, revalidate: true }
    })
    await click('Refresh')
    expect(container.querySelector('article')).toBe(card)
    expect(container.textContent).toContain(
      'Could not refresh Marketplace. Showing the last available data.'
    )
    expect(list.mock.calls.map(([request]) => request)).toEqual([undefined, { forceRefresh: true }])
  })

  it('reconciles a completed batch from local state without remote discovery or replaying old job results', async () => {
    list
      .mockResolvedValueOnce({
        ok: true,
        value: { ...marketplaceCatalog, entries: [entries[0]], installations: {} }
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { ...marketplaceCatalog, entries: [entries[0]], installations: {} }
      })
    vi.mocked(window.api.settings.getSkillMarketplaceBatch).mockResolvedValue({
      id: 'old-batch',
      snapshotId: marketplaceCatalog.snapshotId,
      status: 'completed',
      items: [{ id: entries[0].id, version: '1.0.0', expectedVersion: null, status: 'succeeded' }]
    })
    await act(async () =>
      root.render(<SkillMarketplace view={{ kind: 'marketplace' }} onNavigate={vi.fn()} />)
    )
    expect(list.mock.calls.map(([request]) => request)).toEqual([
      undefined,
      { snapshotId: marketplaceCatalog.snapshotId }
    ])
    // The skill was removed after the old job finished: never replay its succeeded result.
    expect(container.querySelector('article')?.textContent).toContain('View details')
    expect(container.querySelector('article')?.textContent).not.toContain('Installed')
  })

  it('re-projects a pending detail after batch completion reconciles local installations', async () => {
    let complete!: (result: unknown) => void
    detail.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    list.mockResolvedValue({
      ok: true,
      value: {
        ...marketplaceCatalog,
        installations: { [marketplaceEntry.id]: installedDetail.installation }
      }
    })
    vi.mocked(window.api.settings.getSkillMarketplaceBatch).mockResolvedValue({
      id: 'completed-batch',
      snapshotId: marketplaceCatalog.snapshotId,
      status: 'completed',
      items: [
        { id: marketplaceEntry.id, version: '1.0.0', expectedVersion: null, status: 'succeeded' }
      ]
    })
    await act(async () => root.render(<SkillMarketplace view={detailView} onNavigate={vi.fn()} />))
    expect(list).toHaveBeenCalledWith({ snapshotId: marketplaceCatalog.snapshotId })
    await act(async () =>
      complete({
        ok: true,
        value: { ...marketplaceDetail, installation: { kind: 'not-installed' } }
      })
    )
    expect(detail).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenLastCalledWith({ snapshotId: marketplaceCatalog.snapshotId })
    expect(container.textContent).toContain('Installed version: 1.0.0')
    expect(
      [...container.querySelectorAll('button')].some((button) => button.textContent === 'Install')
    ).toBe(false)
  })

  it('re-projects local state when an installation settles during a remote refresh', async () => {
    const initial = {
      ok: true,
      value: { ...marketplaceCatalog, entries: [entries[0]], installations: {} }
    }
    let complete!: (result: unknown) => void
    list
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve
          })
      )
      .mockResolvedValueOnce({
        ok: true,
        value: {
          ...initial.value,
          installations: {
            [entries[0].id]: {
              kind: 'installed',
              version: '1.0.0',
              canUpdate: true,
              localSkillId: installedSkill.id
            }
          }
        }
      })
    install.mockResolvedValue({
      ok: true,
      value: { id: installedSkill.id, status: 'imported', version: '1.0.0' }
    })
    await act(async () =>
      root.render(<SkillMarketplace view={{ kind: 'marketplace' }} onNavigate={vi.fn()} />)
    )
    await click('Refresh')
    await act(async () =>
      root.render(
        <SkillMarketplace view={{ ...detailView, id: entries[0].id }} onNavigate={vi.fn()} />
      )
    )
    await click('Install')
    expect(container.textContent).toContain('Installed version: 1.0.0')
    await act(async () =>
      complete({
        ...initial,
        value: { ...initial.value, entries: [{ ...entries[0], version: '2.0.0' }] }
      })
    )
    expect(list).toHaveBeenLastCalledWith({ snapshotId: marketplaceCatalog.snapshotId })
    await act(async () =>
      root.render(<SkillMarketplace view={{ kind: 'marketplace' }} onNavigate={vi.fn()} />)
    )
    expect(container.querySelector('article')?.textContent).toContain('Update available')
    expect(container.querySelector('article')?.textContent).not.toContain('Installed')
  })
  it('keeps a failed first installation inside the detail and retries without a dialog', async () => {
    list.mockResolvedValueOnce({
      ok: true,
      value: { ...marketplaceCatalog, entries: [entries[0]], installations: {} }
    })
    install
      .mockResolvedValueOnce({ ok: false, error: 'network' })
      .mockResolvedValueOnce({ ok: false, error: 'integrity' })
    await act(async () => root.render(<SkillMarketplace view={detailView} onNavigate={vi.fn()} />))
    const card = container
    await click('Install', card)
    expect(card.textContent).toContain('Skill installation failed')
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    await click('Retry', card)
    expect(install).toHaveBeenCalledTimes(2)
    expect(card.textContent).toContain('integrity')
    expect(
      [...card.querySelectorAll('button')].some((button) => button.textContent === 'Refresh')
    ).toBe(true)
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('enters batch mode explicitly and restores browsing filters, loaded cards and scroll on exit', async () => {
    list.mockResolvedValue({
      ok: true,
      value: { ...marketplaceCatalog, entries, installations: {} }
    })
    container.dataset.slot = 'settings-content-scroll'
    const onNavigate = vi.fn()
    const render = async (view: SkillMarketplaceView): Promise<void> => {
      await act(async () => root.render(<SkillMarketplace view={view} onNavigate={onNavigate} />))
    }
    await render({ kind: 'marketplace' })
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect(container.textContent).not.toContain('Install selected')
    expect(container.querySelector('article button')?.textContent).toContain('Skill')
    await select('Category', 'Academic writing')
    await click('Load more')
    container.scrollTop = 840
    container.dispatchEvent(new Event('scroll'))
    await act(async () => {
      fireEvent.keyDown(container.querySelector('[aria-label="More actions"]')!, { key: 'Enter' })
    })
    await click('Batch manage', document.body)
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: 'marketplace-batch' })
    await render({ kind: 'marketplace-batch' })
    expect(container.scrollTop).toBe(0)
    const header = container.querySelector('[data-slot="resource-catalog-header"]')!
    expect(header.querySelector('h2')?.textContent).toBe('Skills')
    expect(header.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'Marketplace'
    )
    expect(header.querySelector('[aria-label="Search skills"]')).not.toBeNull()
    expect(header.querySelector('[data-slot="skill-marketplace-selection"]')).not.toBeNull()
    expect(container.querySelector('.skill-marketplace-batch-scroll')).toBeNull()
    expect(
      [...container.querySelectorAll('h2')].some((node) => node.textContent === 'Batch manage')
    ).toBe(false)
    expect(
      [...header.querySelectorAll('[data-slot="resource-filter-label"]')].map(
        (node) => node.textContent
      )
    ).toEqual(['Category', 'Sort by'])
    const modeButtons = container.querySelectorAll('[aria-label="Batch operation"] [role="radio"]')
    expect(modeButtons).toHaveLength(2)
    for (const button of modeButtons) {
      expect(button.classList.contains('min-h-7')).toBe(true)
      expect(button.classList.contains('min-h-9')).toBe(false)
    }
    expect(container.querySelectorAll('article input[type="checkbox"]')).toHaveLength(40)
    expect(container.querySelector('.skill-marketplace-card-controls')).toBeNull()
    await click('Select all filtered results (40)')
    expect(container.textContent).toContain('40 selected')
    const input = container.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'Skill 00'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelectorAll('article')).toHaveLength(1)
    expect(container.querySelector('[data-slot="skill-marketplace-batch-feedback"]')).toBeNull()
    await click('Select all filtered results (1)')
    await click('Install…')
    expect(document.querySelector('[data-testid="skill-marketplace-batch-confirm"]')).not.toBeNull()
    // Shared Settings history can leave the view while an unsubmitted draft is open.
    await render({ kind: 'marketplace' })
    expect(document.querySelector('[data-testid="skill-marketplace-batch-confirm"]')).toBeNull()
    expect(container.querySelector<HTMLInputElement>('input')?.value).toBe('')
    expect(container.querySelectorAll('article')).toHaveLength(40)
    expect(container.scrollTop).toBe(840)
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect(container.querySelector('article button')?.textContent).toContain('Skill')
    await render({ kind: 'marketplace-batch' })
    expect(container.querySelector('[data-slot="skill-marketplace-batch-feedback"]')).toBeNull()
    expect(container.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(0)
    await click('Exit selection')
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: 'marketplace' })
    expect(window.api.settings.startSkillMarketplaceBatch).not.toHaveBeenCalled()
    expect(window.api.settings.stopSkillMarketplaceBatch).not.toHaveBeenCalled()
  })
  it('selects eligible filtered entries beyond Load more and freezes a single confirmation', async () => {
    list.mockResolvedValueOnce({
      ok: true,
      value: {
        ...marketplaceCatalog,
        entries,
        installations: {
          'skill-0': { kind: 'installed', version: '1.0.0', canUpdate: false },
          'skill-1': { kind: 'installed', version: '0.9.0', canUpdate: true },
          'skill-2': { kind: 'conflict' }
        }
      }
    })
    await act(async () =>
      root.render(<SkillMarketplace view={{ kind: 'marketplace-batch' }} onNavigate={vi.fn()} />)
    )
    expect(container.querySelectorAll('article')).toHaveLength(36)
    expect(container.querySelectorAll('input[type="checkbox"]:disabled')).toHaveLength(0)
    expect(container.querySelector('[data-skill-id="skill-0"]')).toBeNull()
    expect(container.querySelector('[data-skill-id="skill-1"]')).toBeNull()
    expect(container.querySelector('[data-skill-id="skill-2"]')).toBeNull()
    expect(container.querySelector('[aria-label="Installation status"]')).toBeNull()
    await click('Select all filtered results (37)')
    await click('Install…')
    expect(window.api.settings.startSkillMarketplaceBatch).not.toHaveBeenCalled()
    let dialog = document.querySelector('[data-testid="skill-marketplace-batch-confirm"]')!
    expect(dialog.querySelector('h4')?.textContent).toBe('Review selection / 37')
    expect(dialog.querySelectorAll(':scope > p')).toHaveLength(0)
    const details = dialog.querySelector('details')!
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toBe('Details')
    expect(details.textContent).toContain('Bundled scripts are not run during installation.')
    expect(details.textContent).toContain('Quitting the app stops the queue.')
    await act(async () => details.querySelector('summary')!.click())
    expect(details.open).toBe(true)
    expect(dialog.textContent).toContain('skill-39: 1.0.0')
    await click('Cancel', dialog)
    expect(window.api.settings.startSkillMarketplaceBatch).not.toHaveBeenCalled()
    await click('Install…')
    dialog = document.querySelector('[data-testid="skill-marketplace-batch-confirm"]')!
    vi.mocked(window.api.settings.startSkillMarketplaceBatch).mockImplementationOnce(
      async (request) => ({
        ok: true,
        value: {
          ...request,
          id: 'batch',
          status: 'running',
          items: request.items.map((item) => ({ ...item, status: 'queued' }))
        }
      })
    )
    await click('Install selected', dialog)
    expect(window.api.settings.startSkillMarketplaceBatch).toHaveBeenCalledExactlyOnceWith({
      snapshotId: marketplaceCatalog.snapshotId,
      items: entries.slice(3).map(({ id, version }) => ({ id, version, expectedVersion: null }))
    })
    expect(install).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Batch installation')
    expect(container.querySelectorAll('article input[type="checkbox"]:disabled')).toHaveLength(36)
    expect(
      [...container.querySelectorAll('article button')].filter(
        (button) => button.textContent === 'Install'
      )
    ).toHaveLength(0)
  })
  it.each(['install', 'update'] as const)(
    'selects whole cards in batch %s mode and restores details on exit',
    async (mode) => {
      list.mockResolvedValue({
        ok: true,
        value: {
          ...marketplaceCatalog,
          entries: entries.slice(0, 3),
          installations: {
            'skill-1': { kind: 'installed', version: '0.9.0', canUpdate: true },
            'skill-2': { kind: 'conflict' }
          }
        }
      })
      const onNavigate = vi.fn()
      await act(async () =>
        root.render(
          <SkillMarketplace view={{ kind: 'marketplace-batch' }} onNavigate={onNavigate} />
        )
      )
      if (mode === 'update') await click('Updates1')
      const id = mode === 'update' ? 'skill-1' : 'skill-0'
      const card = container.querySelector<HTMLElement>(`[data-skill-id="${id}"]`)!
      const checkbox = card.querySelector<HTMLInputElement>('input[type="checkbox"]')!
      expect(card.querySelector('[inert]')).not.toBeNull()
      expect(card.textContent).not.toContain('View details')
      await act(async () => checkbox.closest('label')!.click())
      expect(checkbox.checked).toBe(true)
      expect(card.dataset.selected).toBe('true')
      const footer = card.querySelector('[data-slot="resource-card-footer"]')
      if (mode === 'install') expect(footer).toBeNull()
      else expect(footer?.textContent).toContain('Update available')
      await act(async () => checkbox.closest('label')!.click())
      expect(checkbox.checked).toBe(false)
      expect(onNavigate).not.toHaveBeenCalled()
      expect(detail).not.toHaveBeenCalled()
      expect(container.querySelector('[data-skill-id="skill-2"]')).toBeNull()
      await act(async () =>
        root.render(<SkillMarketplace view={{ kind: 'marketplace' }} onNavigate={onNavigate} />)
      )
      const browseCard = container.querySelector<HTMLElement>(`[data-skill-id="${id}"]`)!
      expect(browseCard.querySelector('[inert]')).toBeNull()
      expect(browseCard.querySelector('input[type="checkbox"]')).toBeNull()
      await click('View details', browseCard)
      expect(onNavigate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ kind: 'marketplace-detail', id })
      )
    }
  )
  it('confirms updates separately with the expected installed version and target version', async () => {
    list.mockResolvedValueOnce({
      ok: true,
      value: {
        ...marketplaceCatalog,
        entries,
        installations: {
          'skill-0': { kind: 'installed', version: '1.0.0', canUpdate: false },
          'skill-1': { kind: 'installed', version: '0.9.0', canUpdate: true },
          'skill-2': { kind: 'conflict' }
        }
      }
    })
    await act(async () =>
      root.render(<SkillMarketplace view={{ kind: 'marketplace-batch' }} onNavigate={vi.fn()} />)
    )
    await click('Updates1', container.querySelector('[data-slot="skill-marketplace-selection"]')!)
    await click('Select all filtered results (1)')
    await click('Update…')
    const dialog = document.querySelector('[data-testid="skill-marketplace-batch-confirm"]')!
    expect(dialog.textContent).toContain('skill-1: 0.9.0 → 1.0.0')
    expect(dialog.textContent).not.toContain('skill-0:')
    vi.mocked(window.api.settings.startSkillMarketplaceBatch).mockResolvedValueOnce({
      ok: false,
      error: 'snapshot-unavailable'
    })
    await click('Update selected', dialog)
    expect(window.api.settings.startSkillMarketplaceBatch).toHaveBeenCalledWith({
      snapshotId: marketplaceCatalog.snapshotId,
      items: [{ id: 'skill-1', version: '1.0.0', expectedVersion: '0.9.0' }]
    })
    expect(container.textContent).toContain('snapshot-unavailable')
    expect(container.textContent).toContain('1 selected')
  })
  it('separates selection from modes and preserves it only across sorting and loading more', async () => {
    list.mockResolvedValue({
      ok: true,
      value: { ...marketplaceCatalog, entries, installations: {} }
    })
    await act(async () =>
      root.render(<SkillMarketplace view={{ kind: 'marketplace-batch' }} onNavigate={vi.fn()} />)
    )
    const all = (): HTMLInputElement =>
      container.querySelector('[data-slot="skill-marketplace-selection"] input')!
    const card = (id: string): HTMLInputElement =>
      container.querySelector(`[data-skill-id="${id}"] input`)!
    expect(container.querySelector('[data-slot="skill-marketplace-batch-feedback"]')).toBeNull()
    expect(all().checked).toBe(false)
    await act(async () => card('skill-0').click())
    expect(all().indeterminate).toBe(true)
    expect(
      container.querySelector('[data-slot="skill-marketplace-selection"]')?.textContent
    ).toContain('1 selected')
    expect(
      container.querySelector('[data-skill-id="skill-0"]')?.getAttribute('data-selected')
    ).toBe('true')
    await select('Sort by', 'Catalog order')
    expect(card('skill-0').checked).toBe(true)
    await click('Load more')
    expect(card('skill-0').checked).toBe(true)
    expect(document.activeElement).toBe(card('skill-36'))
    await click('Select all filtered results (40)')
    expect(all().checked).toBe(true)
    expect(all().indeterminate).toBe(false)
    await act(async () => card('skill-0').click())
    expect(all().indeterminate).toBe(true)
    await click('Clear selection')
    expect(document.activeElement).toBe(all())
    expect(container.querySelector('[data-slot="skill-marketplace-batch-feedback"]')).toBeNull()
    await click('Select all filtered results (40)')
    await select('Category', 'Academic writing')
    expect(all().checked).toBe(false)
    expect(container.querySelector('[data-slot="skill-marketplace-batch-feedback"]')).toBeNull()
    expect(list).toHaveBeenCalledTimes(1)
  })
  it('locks filters during an inline review and restores action focus on cancel', async () => {
    list.mockResolvedValue({
      ok: true,
      value: { ...marketplaceCatalog, entries, installations: {} }
    })
    await act(async () =>
      root.render(<SkillMarketplace view={{ kind: 'marketplace-batch' }} onNavigate={vi.fn()} />)
    )
    await click('Select all filtered results (40)')
    await click('Install…')
    const review = container.querySelector('[data-testid="skill-marketplace-batch-confirm"]')!
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(document.activeElement).toBe(review.querySelector('h4'))
    expect(container.querySelector<HTMLInputElement>('input[type="search"]')?.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Refresh"]')?.disabled).toBe(
      true
    )
    expect(container.querySelector('[aria-label="Refresh"] .animate-spin')).toBeNull()
    expect(container.querySelector('fieldset')?.disabled).toBe(true)
    expect(container.querySelectorAll('article input:disabled')).toHaveLength(36)
    const lockedCard = container.querySelector<HTMLInputElement>('article input')!
    await act(async () => lockedCard.closest('label')!.click())
    expect(lockedCard.checked).toBe(true)
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      )
    )
    expect(container.querySelector('[data-testid="skill-marketplace-batch-confirm"]')).toBeNull()
    expect(document.activeElement?.textContent).toBe('Install…')
    expect(container.querySelector<HTMLInputElement>('input[type="search"]')?.disabled).toBe(false)
    expect(window.api.settings.startSkillMarketplaceBatch).not.toHaveBeenCalled()
    await click('Updates0')
    expect(container.querySelectorAll('article')).toHaveLength(0)
    expect(container.querySelector('[data-slot="skill-marketplace-batch-feedback"]')).toBeNull()
    expect(container.textContent).toContain('No skills match your search.')
  })
  it.each([false, true])(
    'confirms uninstall and returns to install after success (card=%s)',
    async (compact) => {
      useSettingsStore.setState({ skills: [installedSkill] })
      detail.mockResolvedValueOnce({ ok: true, value: installedDetail })
      list.mockResolvedValue({
        ok: true,
        value: {
          ...marketplaceCatalog,
          entries: [marketplaceEntry],
          installations: { [marketplaceEntry.id]: installedDetail.installation }
        }
      })
      const onNavigate = vi.fn()
      await act(async () =>
        root.render(
          <SkillMarketplace
            view={compact ? { kind: 'marketplace' } : detailView}
            onNavigate={onNavigate}
          />
        )
      )
      if (!compact)
        expect(
          container
            .querySelector('details[data-slot="skill-marketplace-sources"]')
            ?.hasAttribute('open')
        ).toBe(false)
      const action = container.querySelector('.skill-marketplace-install-action')!
      expect(action.textContent).toBe('Installed')
      await pointer(action, 'pointerover')
      expect(action.textContent).toBe('Uninstall')
      await pointer(action, 'pointerout')
      expect(action.textContent).toBe('Installed')
      await pointer(action, 'pointerover')
      await click('Uninstall')
      expect(remove).not.toHaveBeenCalled()
      await click('Cancel', document.querySelector('[role="alertdialog"]')!)
      expect(remove).not.toHaveBeenCalled()
      await pointer(action, 'pointerover')
      await click('Uninstall')
      let finish!: (value: SkillView[]) => void
      remove.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      const dialog = document.querySelector('[role="alertdialog"]')!
      await click('Uninstall', dialog)
      expect(remove).toHaveBeenCalledExactlyOnceWith({ id: installedSkill.id })
      expect([...dialog.querySelectorAll('button')].every((button) => button.disabled)).toBe(true)
      expect(container.textContent).not.toContain('Installing…')
      list.mockResolvedValue({
        ok: true,
        value: { ...marketplaceCatalog, entries: [marketplaceEntry], installations: {} }
      })
      await act(async () => finish([]))
      expect(useSettingsStore.getState().skills).toEqual([])
      await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Install'))
      expect(detail).toHaveBeenCalledTimes(compact ? 0 : 1)
      expect(onNavigate).not.toHaveBeenCalled()
      expect(list).toHaveBeenLastCalledWith({ snapshotId: marketplaceCatalog.snapshotId })
      expect(container.textContent).not.toContain('Installed version:')
      expect(
        [...container.querySelectorAll('button')].some((button) => button.textContent === 'Install')
      ).toBe(true)
    }
  )
  it('preserves a protected installation and displays the deletion guard reason', async () => {
    useSettingsStore.setState({ skills: [installedSkill] })
    detail.mockResolvedValueOnce({ ok: true, value: installedDetail })
    remove.mockRejectedValueOnce(
      new Error('Used by Reviewer. Remove this Skill from that Specialist before deleting it.')
    )
    await act(async () => root.render(<SkillMarketplace view={detailView} onNavigate={vi.fn()} />))
    await pointer(container.querySelector('.skill-marketplace-install-action')!, 'pointerover')
    await click('Uninstall')
    await click('Uninstall', document.querySelector('[role="alertdialog"]')!)
    expect(container.textContent).toContain('Used by Reviewer.')
    expect(container.textContent).toContain('Installed version: 1.0.0')
    expect(useSettingsStore.getState().skills).toEqual([installedSkill])
  })
  it.each([false, true])(
    'keeps the primary action stable while enablement is pending (update=%s)',
    async (canUpdate) => {
      useSettingsStore.setState({ skills: [installedSkill] })
      detail.mockResolvedValueOnce({
        ok: true,
        value: { ...installedDetail, installation: { ...installedDetail.installation, canUpdate } }
      })
      let finish!: (value: SkillView[]) => void
      toggle.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      await act(async () =>
        root.render(<SkillMarketplace view={detailView} onNavigate={vi.fn()} />)
      )
      const primary = container.querySelector<HTMLButtonElement>(
        '.skill-marketplace-install-action'
      )!
      const enableSwitch = container.querySelector<HTMLButtonElement>('[role="switch"]')!
      const content = primary.innerHTML
      const installedStyle = primary.dataset.installed
      await act(async () => enableSwitch.click())
      expect(primary.textContent).toBe(canUpdate ? 'Update' : 'Installed')
      expect(primary.innerHTML).toBe(content)
      expect(primary.dataset.installed).toBe(installedStyle)
      expect(primary.disabled).toBe(false)
      expect(primary.getAttribute('aria-disabled')).toBe('true')
      expect(enableSwitch.disabled).toBe(true)
      expect(enableSwitch.getAttribute('aria-busy')).toBe('true')
      await act(async () => {
        primary.click()
        enableSwitch.click()
      })
      expect(toggle).toHaveBeenCalledTimes(1)
      expect(remove).not.toHaveBeenCalled()
      expect(install).not.toHaveBeenCalled()
      expect(document.querySelector('[role="alertdialog"]')).toBeNull()
      await act(async () => finish([{ ...installedSkill, enabled: false }]))
      expect(primary.innerHTML).toBe(content)
      expect(primary.dataset.installed).toBe(installedStyle)
      expect(enableSwitch.getAttribute('aria-checked')).toBe('false')
      expect(enableSwitch.disabled).toBe(false)
      expect(list).toHaveBeenCalledTimes(1)
      expect(detail).toHaveBeenCalledTimes(1)
    }
  )
  it('reuses enablement commands and restores the toggle when the command fails', async () => {
    useSettingsStore.setState({ skills: [installedSkill] })
    detail.mockResolvedValueOnce({ ok: true, value: installedDetail })
    toggle.mockRejectedValueOnce(new Error('Cannot change enablement'))
    await act(async () => root.render(<SkillMarketplace view={detailView} onNavigate={vi.fn()} />))
    const actions = container.querySelector('[data-slot="resource-detail-actions"]')!
    expect(actions).not.toBeNull()
    expect(actions.closest('details')).toBeNull()
    expect(actions.querySelector('.skill-marketplace-install-action')?.textContent).toBe(
      'Installed'
    )
    expect(actions.textContent).not.toContain('Uninstall')
    const enableSwitch = actions.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(
      [...actions.querySelectorAll('button')].map(
        (button) => button.getAttribute('aria-label') ?? button.textContent
      )
    ).toEqual(['Enable', 'Installed'])
    expect(enableSwitch.getAttribute('aria-checked')).toBe('true')
    expect(
      [...container.querySelectorAll('summary')].some((summary) => summary.textContent === 'Manage')
    ).toBe(false)
    await act(async () => enableSwitch.click())
    expect(toggle).toHaveBeenCalledWith({ id: installedSkill.id, enabled: false })
    expect(container.textContent).toContain('Cannot change enablement')
    expect(useSettingsStore.getState().skills[0].enabled).toBe(true)
    expect(enableSwitch.getAttribute('aria-checked')).toBe('true')
    toggle.mockResolvedValueOnce([{ ...installedSkill, enabled: false }])
    await act(async () => enableSwitch.click())
    expect(useSettingsStore.getState().skills[0].enabled).toBe(false)
    expect(enableSwitch.getAttribute('aria-checked')).toBe('false')
    toggle.mockResolvedValueOnce([installedSkill])
    await act(async () => enableSwitch.click())
    expect(toggle).toHaveBeenLastCalledWith({ id: installedSkill.id, enabled: true })
    expect(enableSwitch.getAttribute('aria-checked')).toBe('true')
  })
  it('keeps enablement left and update last in the detail footer', async () => {
    useSettingsStore.setState({ skills: [installedSkill] })
    detail.mockResolvedValueOnce({
      ok: true,
      value: {
        ...installedDetail,
        installation: { ...installedDetail.installation, canUpdate: true }
      }
    })
    const footer = document.createElement('div')
    document.body.appendChild(footer)
    await act(async () =>
      root.render(
        <ResourceDetailActionsProvider value={{ container: footer, onClose: vi.fn() }}>
          <SkillMarketplace view={detailView} onNavigate={vi.fn()} />
        </ResourceDetailActionsProvider>
      )
    )
    // Root owns the scrolling body; the action target is separate from it.
    expect(
      container.querySelector(
        '[data-slot="skill-marketplace-detail"] [data-slot="resource-detail-actions"]'
      )
    ).toBeNull()

    const actions = footer.querySelector('[data-slot="resource-detail-actions"]')!
    expect(
      [...actions.querySelectorAll('button')].map(
        (button) => button.getAttribute('aria-label') ?? button.textContent
      )
    ).toEqual(['Enable', 'Close', 'Uninstall', 'Update'])
    const primary = actions.querySelector('.skill-marketplace-install-action')!
    await pointer(primary, 'pointerover')
    expect(primary.textContent).toBe('Update')
    expect(actions.querySelector('[role="switch"]')).not.toBeNull()
    expect(
      [...actions.querySelectorAll('button')].filter((button) => button.textContent === 'Uninstall')
    ).toHaveLength(1)
    footer.remove()
  })
  it('filters receipt-backed installations and updates without treating a conflict as installed', async () => {
    list.mockResolvedValueOnce({
      ok: true,
      value: {
        ...marketplaceCatalog,
        entries,
        installations: {
          'skill-0': { kind: 'installed', version: '1.0.0', canUpdate: false },
          'skill-1': { kind: 'installed', version: '0.9.0', canUpdate: true },
          'skill-2': { kind: 'conflict' }
        }
      }
    })
    await act(async () =>
      root.render(<SkillMarketplace view={{ kind: 'marketplace' }} onNavigate={vi.fn()} />)
    )
    await select('Installation status', 'Installed')
    expect(container.querySelectorAll('article')).toHaveLength(2)
    await select('Installation status', 'Update available')
    expect(container.querySelectorAll('article')).toHaveLength(1)
    expect(container.querySelector('article')?.textContent).toContain('Skill 01')
    expect(container.querySelector('article')?.textContent).toContain('Update available')
    expect(container.querySelector('.skill-marketplace-install-action')?.textContent).toBe('Update')
    await select('Installation status', 'All')
    expect(container.querySelector('[data-skill-id="skill-0"]')?.textContent).toContain('Installed')
    expect(container.querySelector('[data-skill-id="skill-2"]')?.textContent).toContain(
      'Local conflict'
    )
    expect(install).not.toHaveBeenCalled()
  })

  it('requires confirmation, binds the old version, and prevents duplicate update submissions', async () => {
    detail.mockResolvedValueOnce({
      ok: true,
      value: {
        ...marketplaceDetail,
        entry: { ...marketplaceEntry, version: '1.1.0' },
        installation: { kind: 'installed', version: '1.0.0', canUpdate: true }
      }
    })
    let finish!: (value: unknown) => void
    install.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await act(async () =>
      root.render(
        <SkillMarketplace
          view={{
            kind: 'marketplace-detail',
            id: marketplaceEntry.id,
            displayName: marketplaceEntry.displayName,
            snapshotId: marketplaceCatalog.snapshotId
          }}
          onNavigate={vi.fn()}
        />
      )
    )
    const update = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Update'
    )!
    await act(async () => update.click())
    expect(install).not.toHaveBeenCalled()
    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('Update Skill from 1.0.0 to 1.1.0?')
    const confirm = [...dialog.querySelectorAll('button')].find(
      (button) => button.textContent === 'Update'
    )!
    await act(async () => {
      confirm.click()
      confirm.click()
    })
    expect(install).toHaveBeenCalledExactlyOnceWith({
      id: marketplaceEntry.id,
      snapshotId: marketplaceCatalog.snapshotId,
      expectedVersion: '1.0.0'
    })
    expect(confirm.disabled).toBe(true)
    await act(async () =>
      finish({
        ok: true,
        value: { id: 'imported-abstract-trimmer', status: 'updated', version: '1.1.0' }
      })
    )
    expect(container.textContent).toContain('Installed version: 1.1.0')
  })

  it('opens conflict details from the browse card without attempting installation', async () => {
    list.mockResolvedValueOnce({
      ok: true,
      value: {
        ...marketplaceCatalog,
        entries: [marketplaceEntry],
        installations: { [marketplaceEntry.id]: { kind: 'conflict' } }
      }
    })
    const onNavigate = vi.fn()
    await act(async () =>
      root.render(<SkillMarketplace view={{ kind: 'marketplace' }} onNavigate={onNavigate} />)
    )
    const card = container.querySelector('article')!
    expect(card.textContent).toContain('Local conflict')
    await click('View details', card)
    expect(onNavigate).toHaveBeenCalledWith(detailView)
    expect(install).not.toHaveBeenCalled()
  })

  it('reports a failed attempt when installation discovers a new conflict', async () => {
    detail.mockResolvedValueOnce({
      ok: true,
      value: { ...marketplaceDetail, installation: { kind: 'not-installed' } }
    })
    install.mockResolvedValueOnce({ ok: false, error: 'conflict' })
    await act(async () =>
      root.render(
        <SkillMarketplace view={detailView} onNavigate={vi.fn()} onManageLocal={vi.fn()} />
      )
    )
    await click('Install')
    expect(install).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Skill installation failed'
    )
    expect(container.textContent).not.toContain('Skill installation blocked')
    expect(
      [...container.querySelectorAll('button')].some((button) => button.textContent === 'Install')
    ).toBe(false)
  })

  it('does not report an installation failure before any installation attempt', async () => {
    detail.mockResolvedValueOnce({
      ok: true,
      value: { ...marketplaceDetail, installation: { kind: 'conflict' } }
    })
    await act(async () =>
      root.render(
        <SkillMarketplace view={detailView} onNavigate={vi.fn()} onManageLocal={vi.fn()} />
      )
    )
    expect(install).not.toHaveBeenCalled()
    expect(container.textContent).toContain('No files were replaced.')
    expect(container.textContent).not.toContain('Skill installation failed')
  })

  it('locates the exact conflicting Skill and requires a reviewed token before replacing it', async () => {
    const blocked = {
      ...marketplaceDetail,
      installation: { kind: 'conflict', reason: 'name-taken', localSkillId: 'personal-existing' }
    }
    const preview = {
      token: '11111111-1111-4111-8111-111111111111',
      localSkillId: 'personal-existing',
      displayName: 'Existing Skill',
      source: 'personal',
      installedVersion: '0.1.0',
      localChanges: 'unknown',
      mainEnabled: true,
      specialists: [{ id: 'research', name: 'Research Specialist' }],
      added: ['references/new.md'],
      modified: ['SKILL.md'],
      removed: ['old.txt'],
      differences: [
        {
          path: 'SKILL.md',
          patch: createTwoFilesPatch(
            'SKILL.md',
            'SKILL.md',
            'old instructions\n',
            'new instructions\n'
          )
        }
      ]
    }
    detail.mockImplementation(async (request) => ({
      ok: true,
      value: request.previewUpdate ? { ...blocked, updatePreview: preview } : blocked
    }))
    const onManageLocal = vi.fn()
    await act(async () =>
      root.render(
        <SkillMarketplace view={detailView} onNavigate={vi.fn()} onManageLocal={onManageLocal} />
      )
    )
    await click('View installed Skill')
    expect(onManageLocal).toHaveBeenCalledExactlyOnceWith('personal-existing')
    await click('Review Skill update')
    expect(install).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Research Specialist')
    expect(document.body.textContent).toContain('Local changes cannot be determined.')
    expect(document.querySelector('[data-diff-kind=added] code')?.textContent).toContain(
      'new instructions'
    )
    expect(document.querySelector('[data-diff-kind=removed] code')?.textContent).toContain(
      'old instructions'
    )
    await click('Cancel', document)
    expect(install).not.toHaveBeenCalled()
    await click('Review Skill update')
    install.mockResolvedValueOnce({ ok: false, error: 'conflict', reason: 'version-changed' })
    await click('Update existing Skill', document)
    expect(install).toHaveBeenCalledExactlyOnceWith({
      id: marketplaceEntry.id,
      snapshotId: marketplaceCatalog.snapshotId,
      expectedVersion: null,
      updateToken: preview.token
    })
    expect(
      document.querySelector<HTMLButtonElement>('[role="dialog"] button:last-child')?.disabled
    ).toBe(true)
    expect(document.body.textContent).toContain('Close this preview')
    await click('Cancel', document)
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('does not offer an install action when the detail reports a local conflict', async () => {
    detail.mockResolvedValueOnce({
      ok: true,
      value: { ...marketplaceDetail, installation: { kind: 'conflict' } }
    })
    await act(async () =>
      root.render(
        <SkillMarketplace view={detailView} onNavigate={vi.fn()} onManageLocal={vi.fn()} />
      )
    )
    expect(install).not.toHaveBeenCalled()
    expect(
      [...container.querySelectorAll('button')].map((button) => button.textContent)
    ).not.toContain('Install')
  })

  it('opens local management and refreshes a blocked installation without installing', async () => {
    detail.mockResolvedValueOnce({
      ok: true,
      value: { ...marketplaceDetail, installation: { kind: 'conflict' } }
    })
    const onManageLocal = vi.fn()
    await act(async () =>
      root.render(
        <SkillMarketplace view={detailView} onNavigate={vi.fn()} onManageLocal={onManageLocal} />
      )
    )
    expect(container.textContent).toContain('Skill installation blocked')
    const diagnostics = [...container.querySelectorAll('details')].find(
      (node) => node.querySelector('summary')?.textContent === 'Details'
    )!
    expect(diagnostics.open).toBe(false)
    await click('Manage local skills')
    expect(onManageLocal).toHaveBeenCalledOnce()
    detail.mockResolvedValueOnce({
      ok: true,
      value: { ...marketplaceDetail, installation: { kind: 'not-installed' } }
    })
    await click('Refresh')
    expect(container.textContent).not.toContain('Skill installation blocked')
    expect(
      [...container.querySelectorAll('button')].some((button) => button.textContent === 'Install')
    ).toBe(true)
    expect(install).not.toHaveBeenCalled()
  })

  it('keeps conflicting local installations read-only', async () => {
    detail.mockResolvedValueOnce({
      ok: true,
      value: { ...marketplaceDetail, installation: { kind: 'conflict' } }
    })
    await act(async () =>
      root.render(
        <SkillMarketplace
          view={{
            kind: 'marketplace-detail',
            id: marketplaceEntry.id,
            displayName: marketplaceEntry.displayName,
            snapshotId: marketplaceCatalog.snapshotId
          }}
          onNavigate={vi.fn()}
        />
      )
    )
    expect(container.textContent).toContain('No files were replaced.')
    expect(
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'Install')
        ?.disabled
    ).toBeUndefined()
    expect(install).not.toHaveBeenCalled()
  })
  it('shows loading, empty catalogs and retryable integrity failures without falling back to mock data', async () => {
    let finish!: (value: unknown) => void
    list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await act(async () =>
      root.render(<SkillMarketplace view={{ kind: 'marketplace' }} onNavigate={vi.fn()} />)
    )
    expect(container.textContent).toContain('Loading…')
    expect(
      container.querySelector('[data-slot="skill-marketplace-loading"]')?.getAttribute('aria-busy')
    ).toBe('true')
    expect(container.querySelectorAll('article')).toHaveLength(0)
    await act(async () => finish({ ok: false, error: 'integrity' }))
    expect(container.textContent).toContain('Marketplace verification failed')
    expect(container.querySelectorAll('article')).toHaveLength(0)
    list.mockResolvedValueOnce({ ok: true, value: { ...marketplaceCatalog, entries: [] } })
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Retry')
        ?.click()
    )
    expect(container.textContent).toContain('Results: 0 / 0')
    expect(container.textContent).not.toContain('584')
  })

  it('discards late detail responses and recovers an expired snapshot through the catalog', async () => {
    let finish!: (value: unknown) => void
    detail.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const onNavigate = vi.fn()
    const render = async (id: string): Promise<void> => {
      await act(async () =>
        root.render(
          <SkillMarketplace
            view={{
              kind: 'marketplace-detail',
              id,
              displayName: id,
              snapshotId: marketplaceCatalog.snapshotId
            }}
            onNavigate={onNavigate}
          />
        )
      )
    }
    await render('skill-0')
    expect(container.textContent).toContain('Loading…')
    await render('skill-1')
    expect(container.querySelector('[data-slot="resource-detail-header"] h2')?.textContent).toBe(
      'Skill 01'
    )
    await act(async () => finish({ ok: true, value: { ...marketplaceDetail, entry: entries[0] } }))
    expect(container.querySelector('[data-slot="resource-detail-header"] h2')?.textContent).toBe(
      'Skill 01'
    )
    detail.mockResolvedValueOnce({ ok: false, error: 'snapshot-unavailable' })
    await render('expired')
    expect(container.textContent).toContain('Marketplace snapshot is no longer available')
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Back to Marketplace')
        ?.click()
    )
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'marketplace' })
  })

  it('maps transport rejection to a retryable network error', async () => {
    list.mockRejectedValueOnce(new Error('RPC unavailable'))
    await act(async () =>
      root.render(<SkillMarketplace view={{ kind: 'marketplace' }} onNavigate={vi.fn()} />)
    )
    expect(container.textContent).toContain('Unable to load Marketplace')
    expect(container.querySelectorAll('article')).toHaveLength(0)
  })

  it('searches IDs and filters by category without mutating the catalog', () => {
    const first = entries[0]
    const result = filterSkillMarketplace(
      entries,
      ` ${first.id.toUpperCase()} `,
      first.category,
      'name',
      'en'
    )
    expect(result).toEqual([first])
    expect(filterSkillMarketplace(entries, 'no-such-skill-xyz', 'all', 'name', 'en')).toEqual([])
    expect(filterSkillMarketplace(entries, '', 'all', 'manifest', 'en')[0]).toBe(first)
  })

  it.each(['NVIDIA-BioNeMo', 'google-deepmind', 'Yuan1z0825'])(
    'shows the upstream owner %s on cards when authors are absent',
    async (owner) => {
      const entry = {
        ...marketplaceEntry,
        authors: undefined,
        source: { ...marketplaceEntry.source, repository: `https://github.com/${owner}/skills` }
      }
      list.mockResolvedValue({ ok: true, value: { ...marketplaceCatalog, entries: [entry] } })
      await act(async () =>
        root.render(<SkillMarketplace view={{ kind: 'marketplace' }} onNavigate={vi.fn()} />)
      )
      const card = container.querySelector('[data-slot="skill-marketplace-card"]')!
      expect(card.querySelector(`[title="${owner}"]`)?.textContent).toBe(owner)
      expect(card.textContent).not.toContain('AIPOCH')
      expect(entry.authors).toBeUndefined()
    }
  )

  it('preserves declared authors while making their upstream organization searchable', async () => {
    const entry = {
      ...marketplaceEntry,
      authors: [{ name: 'Ada' }, { name: 'Grace' }],
      source: {
        ...marketplaceEntry.source,
        repository: 'https://github.com/NVIDIA-BioNeMo/skills'
      }
    }
    list.mockResolvedValue({ ok: true, value: { ...marketplaceCatalog, entries: [entry] } })
    await act(async () =>
      root.render(<SkillMarketplace view={{ kind: 'marketplace' }} onNavigate={vi.fn()} />)
    )
    expect(container.querySelector('[title="Ada, Grace"]')?.textContent).toBe('Ada, Grace')
    for (const authors of [entry.authors, undefined, []]) {
      const candidate = { ...entry, authors }
      expect(filterSkillMarketplace([candidate], ' NVIDIA ', 'all', 'name', 'en')).toEqual([
        candidate
      ])
      expect(filterSkillMarketplace([candidate], 'AIPOCH', 'all', 'name', 'en')).toEqual([])
    }
    expect(filterSkillMarketplace([entry], 'Grace', 'all', 'name', 'en')).toEqual([entry])
    expect(filterSkillMarketplace([entry], 'NVIDIA', 'Other', 'name', 'en')).toEqual([])
  })

  it('labels missing-author detail attribution as upstream source, retaining the package publisher', async () => {
    const entry = {
      ...marketplaceEntry,
      authors: undefined,
      source: {
        ...marketplaceEntry.source,
        repository: 'https://github.com/NVIDIA-BioNeMo/skills'
      }
    }
    detail.mockResolvedValue({ ok: true, value: { ...marketplaceDetail, entry } })
    await act(async () => root.render(<SkillMarketplace view={detailView} onNavigate={vi.fn()} />))
    expect(container.textContent).toContain('Upstream source: NVIDIA-BioNeMo')
    expect(container.textContent).not.toContain('Author:')
    const publisher = [...container.querySelectorAll('dt')].find(
      (node) => node.textContent === 'Package publisher'
    )!
    expect(publisher.nextElementSibling?.textContent).toBe('AIPOCH')
  })

  it('appends cards and retains loaded results and scroll position across detail navigation', async () => {
    container.dataset.slot = 'settings-content-scroll'
    const onNavigate = vi.fn()
    const render = async (view: SkillMarketplaceView): Promise<void> => {
      await act(async () => root.render(<SkillMarketplace view={view} onNavigate={onNavigate} />))
    }
    await render({ kind: 'marketplace' })
    expect(container.querySelectorAll('[data-slot="skill-marketplace-card"]')).toHaveLength(36)
    expect(container.textContent).toContain('Results: 40 / 40')
    expect(container.textContent).not.toMatch(/preview|mock|584/i)
    expect(container.querySelector('[aria-label="Inclusion tier"]')).toBeNull()
    expect(container.textContent).not.toMatch(
      /mvp-candidate|sandbox-beta|catalog-candidate|restricted-index/
    )
    const next = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Load more'
    )!
    const loadMore = container.querySelector('[data-slot="skill-marketplace-load-more"]')!
    expect(loadMore.querySelectorAll(':scope > span[aria-hidden="true"]')).toHaveLength(2)
    expect(next.dataset.variant).toBe('secondary')
    expect(next.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
    expect(loadMore.querySelectorAll('button')).toHaveLength(1)
    const catalogCalls = list.mock.calls.length
    await act(async () => next.click())
    expect(list).toHaveBeenCalledTimes(catalogCalls)
    expect(container.querySelectorAll('[data-slot="skill-marketplace-card"]')).toHaveLength(40)
    expect(container.querySelector('[data-slot="skill-marketplace-load-more"]')).toBeNull()
    expect(container.textContent).not.toContain('Load more')
    expect(document.activeElement?.textContent).toBe('Skill 36')
    expect(container.textContent).not.toMatch(/Self-assessed|Previous page|Next page/)
    container.scrollTop = 840
    container.dispatchEvent(new Event('scroll'))
    const title = container.querySelector<HTMLButtonElement>(
      '[data-slot="skill-marketplace-card"] button'
    )!
    const titleText = title.textContent
    await act(async () => title.click())
    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'marketplace-detail', displayName: titleText })
    )
    await render(onNavigate.mock.calls[0][0])
    expect(container.scrollTop).toBe(0)
    expect(container.querySelector('[data-slot="skill-marketplace-detail"]')).not.toBeNull()
    expect(container.textContent).toContain('Updates require confirmation.')
    await render({ kind: 'marketplace' })
    expect(container.querySelectorAll('[data-slot="skill-marketplace-card"]')).toHaveLength(40)
    expect(container.scrollTop).toBe(840)
    expect(
      container.querySelector('[data-slot="skill-marketplace-card"] button')?.textContent
    ).toBe(titleText)
  })

  it('resets the loaded count when filtering and exposes an empty search result', async () => {
    await act(async () =>
      root.render(<SkillMarketplace view={{ kind: 'marketplace' }} onNavigate={vi.fn()} />)
    )
    const button = (label: string): HTMLButtonElement | undefined =>
      [...container.querySelectorAll('button')].find((el) => el.textContent?.startsWith(label))
    await act(async () => button('Load more')?.click())
    await select('Category', 'Academic writing')
    expect(container.querySelectorAll('[data-slot="skill-marketplace-card"]')).toHaveLength(36)
    expect(button('Load more')).toBeDefined()
    expect(
      [...container.querySelectorAll('[data-slot="skill-marketplace-card"]')].every((card) =>
        card.textContent?.includes('Skill')
      )
    ).toBe(true)
    const input = container.querySelector('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'no-such-skill-xyz'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelectorAll('[data-slot="skill-marketplace-card"]')).toHaveLength(0)
    expect(container.textContent).toContain('No skills match your search.')
    expect(button('Load more')).toBeUndefined()
  })

  it('shows evidence only when provided and keeps source and publisher separate', async () => {
    await act(async () =>
      root.render(
        <SkillMarketplace
          view={{
            kind: 'marketplace-detail',
            id: 'abstract-trimmer',
            snapshotId: marketplaceCatalog.snapshotId,
            displayName: 'Example'
          }}
          onNavigate={vi.fn()}
        />
      )
    )
    const score = container.querySelector(
      '[data-slot="skill-marketplace-detail"] header [data-slot="skill-marketplace-score"]'
    )
    expect(score?.textContent).toBe('85/100')
    const categoryBadge = container.querySelector(
      '[data-slot="skill-marketplace-detail-category"]'
    )!
    expect(categoryBadge.textContent).toBe('Academic writing')
    expect(score?.getAttribute('aria-label')).toBe('Upstream self-assessment 85/100')
    expect(
      container.querySelector('[data-slot="skill-marketplace-assessment"] summary')?.textContent
    ).toBe('Assessment report')
    expect(container.textContent).not.toContain('Inclusion tier')
    expect(container.textContent).toContain('83.6/100')
    expect(container.textContent).not.toContain('Assessed Skill version')
    const sourceTable = container.querySelector('[data-slot="skill-marketplace-sources"] dl')!
    const assessmentTable = container.querySelector(
      '[data-slot="skill-marketplace-assessment"] dl'
    )!
    expect(assessmentTable.className).toBe(sourceTable.className)
    expect([...assessmentTable.querySelectorAll('dt')].map((node) => node.textContent)).toContain(
      'Dynamic score'
    )
    expect(assessmentTable.querySelector('dt')?.nextElementSibling?.tagName).toBe('DD')
    const links = [...container.querySelectorAll('a')].map((a) => a.href)
    expect(links).toContain('https://aipoch.com/agent-skills')
    expect(links).toContain('https://github.com/aipoch/openscience-skill-marketplace')
    expect(links.some((url) => url.includes('/Academic%20Writing/abstract-trimmer'))).toBe(true)
    expect(container.textContent).toContain('License evidence')
    detail.mockResolvedValueOnce({
      ok: true,
      value: { ...marketplaceDetail, entry: { ...marketplaceEntry, evaluation: undefined } }
    })
    await act(async () =>
      root.render(
        <SkillMarketplace
          view={{
            kind: 'marketplace-detail',
            id: 'unscored',
            displayName: 'Example',
            snapshotId: marketplaceCatalog.snapshotId
          }}
          onNavigate={vi.fn()}
        />
      )
    )
    expect(container.querySelector('[data-slot="skill-marketplace-assessment"]')).toBeNull()
    expect(container.querySelector('[data-slot="skill-marketplace-score"]')).toBeNull()
  })
})
