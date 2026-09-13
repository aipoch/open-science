// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillMarketplace, type SkillMarketplaceView } from './SkillMarketplace'
import { filterSkillMarketplace, type SkillMarketplaceEntry } from './skill-marketplace-model'

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
const detail = vi.fn().mockImplementation(async ({ id }) => ({
  ok: true,
  value: {
    ...marketplaceDetail,
    entry: entries.find((item) => item.id === id) ?? marketplaceEntry
  }
}))
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('api', {
    settings: {
      listSkillMarketplace: list,
      getSkillMarketplaceDetail: detail,
      installSkillMarketplace: install
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
    detail.mockResolvedValueOnce({
      ok: true,
      value: {
        ...marketplaceDetail,
        installation: { kind: 'installed', version: '1.1.0', canUpdate: false }
      }
    })
    await act(async () =>
      finish({
        ok: true,
        value: { id: 'imported-abstract-trimmer', status: 'updated', version: '1.1.0' }
      })
    )
    expect(container.textContent).toContain('Installed version: 1.1.0')
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
    ).toBe(true)
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
    expect(container.querySelector('h3')?.textContent).toBe('Skill 01')
    await act(async () => finish({ ok: true, value: { ...marketplaceDetail, entry: entries[0] } }))
    expect(container.querySelector('h3')?.textContent).toBe('Skill 01')
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

  it('renders 36 compact cards per page and retains list state across detail navigation', async () => {
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
      (button) => button.textContent === 'Next page'
    )!
    await act(async () => next.click())
    expect(container.textContent).toContain('Page 2 of 2')
    const title = container.querySelector<HTMLButtonElement>(
      '[data-slot="skill-marketplace-card"] button'
    )!
    const titleText = title.textContent
    await act(async () => title.click())
    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'marketplace-detail', displayName: titleText })
    )
    await render(onNavigate.mock.calls[0][0])
    expect(container.querySelector('[data-slot="skill-marketplace-detail"]')).not.toBeNull()
    expect(container.textContent).toContain('Updates require confirmation.')
    await render({ kind: 'marketplace' })
    expect(container.textContent).toContain('Page 2 of 2')
    expect(
      container.querySelector('[data-slot="skill-marketplace-card"] button')?.textContent
    ).toBe(titleText)
  })

  it('resets pagination when filtering and exposes an empty search result', async () => {
    await act(async () =>
      root.render(<SkillMarketplace view={{ kind: 'marketplace' }} onNavigate={vi.fn()} />)
    )
    const button = (label: string): HTMLButtonElement | undefined =>
      [...container.querySelectorAll('button')].find((el) => el.textContent?.startsWith(label))
    await act(async () => button('Next page')?.click())
    await act(async () => button('Academic writing')?.click())
    expect(container.textContent).toContain('Page 1 of')
    expect(
      [...container.querySelectorAll('[data-slot="skill-marketplace-card"]')].every((card) =>
        card.textContent?.includes('Academic writing')
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
    expect(button('Next page')?.disabled).toBe(true)
  })

  it('opens a focus tooltip only for clipped text and dismisses it with Escape', async () => {
    await act(async () =>
      root.render(<SkillMarketplace view={{ kind: 'marketplace' }} onNavigate={vi.fn()} />)
    )
    const title = container.querySelector<HTMLButtonElement>(
      '[data-slot="skill-marketplace-card"] button'
    )!
    await act(async () => title.focus())
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    await act(async () => title.blur())
    const text = title.querySelector('span')!
    Object.defineProperties(text, { clientWidth: { value: 100 }, scrollWidth: { value: 300 } })
    await act(async () => title.focus())
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(title.textContent)
    await act(async () =>
      title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
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
    expect(container.textContent).toContain('Upstream self-assessment 85/100')
    expect(container.textContent).not.toContain('Inclusion tier')
    expect(container.textContent).toContain('83.6/100')
    expect(container.textContent).not.toContain('Assessed Skill version:')
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
  })
})
