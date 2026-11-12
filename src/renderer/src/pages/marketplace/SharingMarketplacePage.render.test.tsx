import { useNavigationStore } from '@/stores/navigation-store'
import { useSettingsStore } from '@/stores/settings-store'
// @vitest-environment jsdom
import { act, useState } from 'react'
import { ResourceHeading, ResourceCatalogToolbar } from './ResourceCenterModeTabs'
import { useStickyResourceFilters } from '../settings/use-resource-selection'
import { previewLeaveGuards } from '@/stores/preview-leave-guard'
import { SettingsEditorActions } from '../settings/SettingsLayout'
import { createRoot, type Root } from 'react-dom/client'
import type { SkillsView, SpecialistsView, ConnectorsView } from '@/lib/settings-navigation'
import type { SkillEditorLeaveState } from '../settings/SkillEditor'
import { fireEvent } from '@testing-library/react'
import { useSpecialistStore } from '@/stores/specialist-store'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../home/UseCaseCarousel', () => ({
  UseCaseCarousel: ({ variant }: { variant: string }) => (
    <div data-testid="use-case-carousel">
      <ResourceHeading title="Use Cases" />
      {variant}
    </div>
  )
}))

vi.mock('../settings/SkillsPanel', () => ({
  SkillsPanel: ({
    view,
    onNavigate,
    onEditorLeaveStateChange,
    onOpenSpecialist,
    onSaved
  }: {
    onSaved: () => void
    view: SkillsView
    onNavigate: (view: SkillsView) => void
    onEditorLeaveStateChange: (state: SkillEditorLeaveState) => void
    onOpenSpecialist: (usage: { id: string; name: string; kind: 'custom' }) => void
  }) => (
    <div data-testid="skills-panel">
      <ResourceHeading title="Skills" />
      Skills: {view.kind}
      <CatalogProbe onInstalled={() => onNavigate({ kind: 'list' })} />
      {view.kind === 'create' || view.kind === 'edit' ? (
        <SettingsEditorActions busy={false}>
          <button onClick={() => onNavigate({ kind: 'list' })}>Cancel</button>
          <button onClick={onSaved}>Save changes</button>
        </SettingsEditorActions>
      ) : null}
      <button onClick={() => onNavigate({ kind: 'create' })}>New skill</button>
      <button
        data-linked-specialist
        onClick={() => onOpenSpecialist({ id: 'curator', name: 'Curator', kind: 'custom' })}
      >
        Related specialist
      </button>
      <button onClick={() => onNavigate({ kind: 'detail', id: 'alpha' })}>Open skill</button>
      <button onClick={() => onNavigate({ kind: 'marketplace' })}>Browse skills</button>
      <button onClick={() => onNavigate({ kind: 'marketplace-batch' })}>
        Select marketplace skills
      </button>
      <button
        onClick={() =>
          onNavigate({
            kind: 'marketplace-detail',
            id: 'alpha',
            displayName: 'Alpha',
            snapshotId: 'snapshot'
          })
        }
      >
        Preview skill
      </button>
      <button
        onClick={() => {
          onNavigate({ kind: 'edit', id: 'alpha' })
          onEditorLeaveStateChange({ dirty: true, busy: false })
        }}
      >
        Edit skill draft
      </button>
    </div>
  )
}))

vi.mock('../settings/ConnectorResourcePanel', () => ({
  ConnectorResourcePanel: ({
    view,
    onNavigate,
    onLeaveStateChange
  }: {
    view: ConnectorsView
    onNavigate: (view: ConnectorsView) => void
    onLeaveStateChange: (state: SkillEditorLeaveState) => void
  }) => {
    const [draft, setDraft] = useState('')
    return (
      <div data-testid="connectors-panel">
        <ResourceHeading title="Connectors" />
        Connectors: {view.kind}
        {'id' in view ? <span data-testid="connector-target">{view.id}</span> : null}
        {view.kind === 'add' ? (
          <>
            <input
              aria-label="Connector draft"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            {view.credentialView === 'create' ? (
              <span>Credential editor</span>
            ) : (
              <button onClick={() => onNavigate({ ...view, credentialView: 'create' })}>
                Create credential
              </button>
            )}
            <button onClick={() => onLeaveStateChange({ dirty: true, busy: true })}>
              Save connector
            </button>
            <button onClick={() => onLeaveStateChange({ dirty: true, busy: false })}>
              Finish connector save
            </button>
          </>
        ) : null}
        <button
          onClick={() => {
            onNavigate({ kind: 'add', transport: 'remote' })
            onLeaveStateChange({ dirty: true, busy: false })
          }}
        >
          Draft connector
        </button>
        <button onClick={() => onNavigate({ kind: 'detail', id: 'openalex' })}>
          Open connector
        </button>
      </div>
    )
  }
}))

vi.mock('../settings/SpecialistsPanel', () => ({
  SpecialistsPanel: ({
    view,
    onNavigate,
    onOpenConnectorDetail
  }: {
    view: SpecialistsView
    onNavigate: (view: SpecialistsView) => void
    onOpenConnectorDetail?: (id: string) => void
  }) => (
    <div data-testid="specialists-panel">
      <ResourceHeading title="Specialists" />
      Specialists: {view.kind}
      <button onClick={() => onOpenConnectorDetail?.('openalex')}>
        Related built-in connector
      </button>
      <button onClick={() => onOpenConnectorDetail?.('research-connector')}>
        Related custom connector
      </button>
      <CatalogProbe onInstalled={() => onNavigate({ kind: 'list' })} />
      {view.kind === 'create' ? (
        <PendingEditorActions onCancel={() => onNavigate({ kind: 'list' })} />
      ) : null}
      <button onClick={() => onNavigate({ kind: 'create' })}>New specialist</button>
      <button onClick={() => onNavigate({ kind: 'import' })}>Import specialist</button>
      <button onClick={() => onNavigate({ kind: 'edit', id: 'curator' })}>Open specialist</button>
      <button onClick={() => onNavigate({ kind: 'marketplace' })}>Browse specialists</button>
      <button onClick={() => onNavigate({ kind: 'marketplace-sources' })}>Manage sources</button>
      <button
        onClick={() =>
          onNavigate({
            kind: 'marketplace-release',
            id: 'curator',
            sourceId: 'official',
            version: '1.0.0'
          })
        }
      >
        Preview specialist
      </button>
    </div>
  )
}))

const CatalogProbe = ({ onInstalled }: { onInstalled: () => void }): React.JSX.Element => {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  return (
    <>
      <input
        aria-label="Search catalog"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <select
        aria-label="Catalog filter"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      >
        <option value="all">All</option>
        <option value="selected">Selected</option>
      </select>
      <button onClick={onInstalled}>Installed catalog</button>
    </>
  )
}

const PendingEditorActions = ({ onCancel }: { onCancel: () => void }): React.JSX.Element => {
  const [busy, setBusy] = useState(false)
  return (
    <SettingsEditorActions busy={busy}>
      <button disabled={busy} onClick={onCancel}>
        Cancel
      </button>
      <button disabled={busy} onClick={() => setBusy(true)}>
        Create specialist
      </button>
    </SettingsEditorActions>
  )
}

import { SharingMarketplacePage } from './SharingMarketplacePage'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('defaults to Skills and switches resources without leaving the Resource center', async () => {
  await act(async () => root.render(<SharingMarketplacePage />))

  expect(container.querySelector('[data-resource-center-resource="skills"]')).not.toBeNull()
  expect(container.querySelector('[data-testid="skills-panel"]')?.textContent).toContain(
    'Skills: list'
  )

  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="Skills"]')?.click()
  })
  await Promise.resolve()
  expect(container.querySelector('[data-resource-center-resource="skills"]')).not.toBeNull()
  expect(container.querySelector('[data-testid="skills-panel"]')?.textContent).toContain(
    'Skills: list'
  )

  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="Specialists"]')?.click()
  })
  await Promise.resolve()
  expect(container.querySelector('[data-resource-center-resource="specialists"]')).not.toBeNull()
  expect(container.querySelector('[data-testid="specialists-panel"]')?.textContent).toContain(
    'Specialists: list'
  )
  expect(
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Specialists"]')
      ?.getAttribute('aria-current')
  ).toBe('page')
})

const clickButton = async (label: string): Promise<void> => {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) =>
      !candidate.closest('[aria-hidden="true"]') &&
      (candidate.getAttribute('aria-label') === label || candidate.textContent === label)
  )
  expect(button).toBeDefined()
  await act(async () => button!.click())
}

it.each([
  ['Skills', 'skill', 'skills', 'detail', 'marketplace-detail'],
  ['Specialists', 'specialist', 'specialists', 'edit', 'marketplace-release']
])(
  'opens %s details in one drawer without replacing the originating list',
  async (label, noun, resource, detail, preview) => {
    await act(async () => root.render(<SharingMarketplacePage />))
    await clickButton(label)
    const list = container.querySelector(`[data-testid="${resource}-panel"]`)
    await clickButton(`Open ${noun}`)
    expect(container.querySelector(`[data-testid="${resource}-panel"]`)).toBe(list)
    expect(list?.textContent).toContain(`${label}: list`)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(`${label}: ${detail}`)
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')!
        .click()
    )
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await clickButton(`Browse ${resource}`)
    const marketplaceList = container.querySelector(
      `[data-resource-catalog="marketplace"] [data-testid="${resource}-panel"]`
    )
    await clickButton(`Preview ${noun}`)
    expect(marketplaceList?.textContent).toContain(`${label}: marketplace`)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(`${label}: ${preview}`)
    await act(async () =>
      fireEvent.keyDown(document.querySelector('[role="dialog"]')!, { key: 'Escape' })
    )
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(marketplaceList?.textContent).toContain(`${label}: marketplace`)
  }
)

it.each([
  ['Skills', 'skill', 'skills', 'detail'],
  ['Connectors', 'connector', 'connectors', 'detail'],
  ['Specialists', 'specialist', 'specialists', 'edit']
])(
  'keeps embedded %s details inside the preview and returns to the same list',
  async (label, noun, resource, kind) => {
    await act(async () => root.render(<SharingMarketplacePage embedded />))
    const trigger = container.querySelector('[role="combobox"][aria-label="Resource type"]')!
    await act(async () => fireEvent.keyDown(trigger, { key: 'Enter' }))
    const option = [...document.querySelectorAll('[role="option"]')].find(
      (item) => item.textContent === label
    )!
    await act(async () => fireEvent.click(option))
    const list = container.querySelector(`[data-testid="${resource}-panel"]`)!
    const viewport = list.parentElement!
    viewport.scrollTop = 180
    await clickButton(`Open ${noun}`)
    const detail = container.querySelector('[data-slot="resource-inline-detail"]')!
    expect(detail.textContent).toContain(`${label}: ${kind}`)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(list.closest('main')?.getAttribute('aria-hidden')).toBe('true')
    expect(detail.querySelector('button[aria-label="Back"]')).toBe(document.activeElement)
    await act(async () =>
      detail.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!.click()
    )
    expect(container.querySelector('[data-slot="resource-inline-detail"]')).toBeNull()
    expect(container.querySelector(`[data-testid="${resource}-panel"]`)).toBe(list)
    expect(list.closest('main')?.getAttribute('aria-hidden')).toBe('false')
    expect(viewport.scrollTop).toBe(180)
  }
)

it('replaces linked resource details in one drawer and keeps complex editing on the page', async () => {
  const originalItems = useSpecialistStore.getState().items
  useSpecialistStore.setState({
    items: [
      {
        kind: 'custom',
        id: 'curator',
        name: 'Curator',
        description: '',
        systemPrompt: '',
        enabled: true,
        revision: 1,
        capabilityMode: 'selected',
        selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
        fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] }
      }
    ]
  })
  try {
    await act(async () => root.render(<SharingMarketplacePage />))
    await clickButton('Skills')
    await clickButton('Open skill')
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[role="dialog"] button[data-linked-specialist]')!
        .click()
    )
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(container.querySelector('[data-resource-center-resource="skills"]')).not.toBeNull()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Specialists: edit')
    expect(document.querySelector('[data-slot="resource-detail-footer"]')?.textContent).toContain(
      'Edit'
    )
    await act(async () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
        .find((button) => button.textContent === 'Edit')!
        .click()
    )
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelector('[data-resource-center-resource="specialists"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="specialists-panel"]')?.textContent).toContain(
      'Specialists: edit'
    )
  } finally {
    useSpecialistStore.setState({ items: originalItems })
  }
})

it('keeps an edited Skill open until discard is confirmed from Back', async () => {
  await act(async () => root.render(<SharingMarketplacePage />))
  await clickButton('Skills')
  await clickButton('Edit skill draft')
  await clickButton('Back')
  expect(container.querySelector('[data-testid="skills-panel"]')?.textContent).toContain(
    'Skills: edit'
  )
  expect(document.body.textContent).toContain('Discard unsaved changes?')
  const discard = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent === 'Discard changes'
  )
  await act(async () => discard!.click())
  expect(container.querySelector('[data-testid="skills-panel"]')?.textContent).toContain(
    'Skills: list'
  )
})

it('continues Specialist import configuration on a full page', async () => {
  await act(async () => root.render(<SharingMarketplacePage />))
  await clickButton('Specialists')
  await clickButton('Import specialist')
  await clickButton('Open specialist')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(container.querySelector('[data-testid="specialists-panel"]')?.textContent).toContain(
    'Specialists: edit'
  )
})

it('moves only the active editor actions into the header and returns after a Skill save', async () => {
  await act(async () => root.render(<SharingMarketplacePage />))
  await clickButton('Skills')
  await clickButton('New skill')
  const actions = (): Element | null =>
    container.querySelector('header [data-slot="resource-editor-actions"]')
  expect(actions()?.textContent).toBe('CancelSave changes')
  await clickButton('Specialists')
  await clickButton('New specialist')
  expect(actions()?.textContent).toBe('CancelCreate specialist')
  await clickButton('Skills')
  expect(actions()?.textContent).toBe('CancelSave changes')
  await act(async () => actions()!.querySelectorAll<HTMLButtonElement>('button')[1].click())
  expect(container.querySelector('[data-testid="skills-panel"]')?.textContent).toContain(
    'Skills: list'
  )
  expect(actions()).toBeNull()
})

it('blocks Back and resource switching while the editor is saving', async () => {
  await act(async () => root.render(<SharingMarketplacePage />))
  await clickButton('Specialists')
  await clickButton('New specialist')
  await clickButton('Create specialist')
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="Back"]')?.disabled).toBe(
    true
  )
  await clickButton('Skills')
  expect(container.querySelector('[data-resource-center-resource="specialists"]')).not.toBeNull()
})

it('switches embedded resource types and guards closing an unsaved project preview', async () => {
  const scope = 'workbench:test-project:resources'
  await act(async () => root.render(<SharingMarketplacePage embedded previewScope={scope} />))
  expect(container.querySelector('aside')).toBeNull()
  expect(container.querySelector('[aria-label="Resource type"]')?.textContent).toContain('Skills')
  const selectResource = async (name: string): Promise<void> => {
    const trigger = container.querySelector(
      '[aria-hidden="false"] [role="combobox"][aria-label="Resource type"]'
    )!
    await act(async () => fireEvent.keyDown(trigger, { key: 'Enter' }))
    const option = [...document.querySelectorAll('[role="option"]')].find(
      (item) => item.textContent === name
    )!
    await act(async () => fireEvent.click(option))
  }
  await selectResource('Skills')
  expect(
    container.querySelector('[data-resource-center-resource="skills"]')?.hasAttribute('hidden')
  ).toBe(false)
  await selectResource('Specialists')
  expect(
    container.querySelector('[data-resource-center-resource="specialists"]')?.hasAttribute('hidden')
  ).toBe(false)
  await selectResource('Skills')
  await clickButton('Edit skill draft')
  const close = vi.fn()
  await act(async () => {
    expect(previewLeaveGuards.request(scope, close)).toBe(false)
  })
  expect(close).not.toHaveBeenCalled()
  const discard = [...document.querySelectorAll('[role="alertdialog"] button')].find(
    (button) => button.textContent === 'Discard changes'
  )!
  await act(async () => fireEvent.click(discard))
  expect(close).toHaveBeenCalledOnce()
})

it('keeps Skill usage in the drawer footer and opens personal editing on the page', async () => {
  const originalSkills = useSettingsStore.getState().skills
  useSettingsStore.setState({
    skills: [
      {
        id: 'alpha',
        name: 'alpha',
        displayName: 'Alpha',
        description: '',
        source: 'personal',
        updatedAt: '2026-01-01',
        enabled: true
      }
    ]
  })
  try {
    await act(async () => root.render(<SharingMarketplacePage />))
    await clickButton('Skills')
    await clickButton('Open skill')
    const footer = document.querySelector('[data-slot="resource-detail-footer"]')!
    expect(footer.textContent).toContain('Used by')
    const edit = [...footer.querySelectorAll('button')].find(
      (button) => button.textContent === 'Edit'
    )!
    await act(async () => edit.click())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(container.textContent).toContain('Skills: edit')
  } finally {
    useSettingsStore.setState({ skills: originalSkills })
  }
})

it('orders resources consistently and protects connector drafts before switching resources', async () => {
  await act(async () => root.render(<SharingMarketplacePage />))
  expect(
    Array.from(container.querySelectorAll('aside nav button')).map((button) =>
      button.getAttribute('aria-label')
    )
  ).toEqual(['Skills', 'Connectors', 'Specialists', 'Use Cases'])
  await clickButton('Connectors')
  await clickButton('Open connector')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Connectors: detail')
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')!.click()
  )
  await clickButton('Draft connector')
  await clickButton('Skills')
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    'Discard unsaved changes?'
  )
  await act(async () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'))
      .find((button) => button.textContent === 'Discard changes')!
      .click()
  )
  await clickButton('Connectors')
  expect(container.querySelector('[data-testid="connectors-panel"]')?.textContent).toContain(
    'Connectors: list'
  )
})

it('measures the sticky offset after child toolbar layout settles', async () => {
  const measure = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      return new DOMRect(0, 0, 420, this.querySelector('select') ? 96 : 32)
    })
  const Catalog = (): React.JSX.Element => {
    const { panelRef, filterRef } = useStickyResourceFilters()
    return (
      <div ref={panelRef} data-testid="sticky-catalog">
        <div ref={filterRef}>
          <ResourceCatalogToolbar search={<input aria-label="Search resources" />}>
            <select aria-label="Resource filter">
              <option>All</option>
            </select>
          </ResourceCatalogToolbar>
        </div>
      </div>
    )
  }
  try {
    await act(async () => root.render(<Catalog />))
    expect(container.querySelector('select')).toBeNull()
    expect(
      container
        .querySelector<HTMLElement>('[data-testid="sticky-catalog"]')
        ?.style.getPropertyValue('--resource-filter-height')
    ).toBe('32px')
  } finally {
    measure.mockRestore()
  }
})

it('measures filters before the first paint and retains values across resizing', async () => {
  const measure = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(0, 0, 420, 32))
  const originalObserver = globalThis.ResizeObserver
  let resize: ResizeObserverCallback | undefined
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      resize = callback
    }
    observe = vi.fn()
    disconnect = vi.fn()
    unobserve = vi.fn()
  }
  const Toolbar = (): React.JSX.Element => {
    const [value, setValue] = useState('all')
    return (
      <ResourceCatalogToolbar
        search={<input aria-label="Search resources" defaultValue="protein" />}
        onResetFilters={() => setValue('all')}
        activeFilterCount={Number(value !== 'all')}
      >
        <select
          aria-label="Resource filter"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        >
          <option value="all">All</option>
          <option value="installed">Installed</option>
        </select>
      </ResourceCatalogToolbar>
    )
  }
  try {
    await act(async () => root.render(<Toolbar />))
    // ResizeObserver delivers after layout; the first rendered frame must already fit.
    expect(container.querySelector('select')).toBeNull()
    expect(container.querySelector('button[aria-label="Filters"]')).not.toBeNull()
    const entry = (width: number): ResizeObserverEntry => ({
      target: container,
      contentRect: new DOMRect(0, 0, width, 40),
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: []
    })
    const observer = new originalObserver(() => {})
    const resizeToolbar = resize!
    await act(async () => resizeToolbar([entry(420)], observer))
    expect(container.querySelector('select')).toBeNull()
    await clickButton('Filters')
    expect(document.querySelector<HTMLButtonElement>('button:disabled')?.textContent).toBe(
      'Reset filters'
    )
    await act(async () =>
      fireEvent.change(document.querySelector('select')!, { target: { value: 'installed' } })
    )
    expect(container.querySelector('button[aria-label="Filters"]')?.textContent).toContain('1')
    const reset = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Reset filters'
    )!
    await act(async () => reset.click())
    expect(document.querySelector('select')?.value).toBe('all')
    expect(reset.disabled).toBe(true)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(container.querySelector('input')?.value).toBe('protein')
    await act(async () =>
      fireEvent.change(document.querySelector('select')!, { target: { value: 'installed' } })
    )
    await act(async () => resizeToolbar([entry(1200)], observer))
    expect(container.querySelector('select')?.value).toBe('installed')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await clickButton('Reset filters')
    expect(container.querySelector('select')?.value).toBe('all')
    expect(container.querySelector('input')?.value).toBe('protein')
    measure.mockReturnValue(new DOMRect(0, 0, 1200, 32))
    await act(async () => root.render(<Toolbar key="wide" />))
    expect(container.querySelector('select')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Filters"]')).toBeNull()
  } finally {
    globalThis.ResizeObserver = originalObserver
    measure.mockRestore()
  }
})

it('honors connector recovery links while the Resource center is already open', async () => {
  await act(async () => root.render(<SharingMarketplacePage />))
  await clickButton('Skills')
  await act(async () =>
    useNavigationStore.getState().openResourceCenter('user', {
      resource: 'connectors',
      view: { kind: 'edit', id: 'custom-connector' }
    })
  )
  expect(container.querySelector('[data-resource-center-resource="connectors"]')).not.toBeNull()
  expect(container.querySelector('[data-testid="connectors-panel"]')?.textContent).toContain(
    'Connectors: edit'
  )
  expect(useNavigationStore.getState().resourceCenterIntent).toBeUndefined()
})

it('keeps Marketplace selection in the catalog without secondary navigation', async () => {
  await act(async () => root.render(<SharingMarketplacePage />))
  const click = async (text: string): Promise<void> => {
    const button = [...container.querySelectorAll('button')].find(
      (node) => !node.closest('[aria-hidden="true"]') && node.textContent === text
    )!
    await act(async () => button.click())
  }
  await click('Skills')
  await click('Browse skills')
  await click('Select marketplace skills')
  expect(
    container.querySelector('[data-resource-catalog="marketplace"] [data-testid="skills-panel"]')
      ?.textContent
  ).toContain('Skills: marketplace-batch')
  expect(container.querySelector('[aria-label="Back to Marketplace"]')).toBeNull()
  expect(container.querySelector('nav[aria-label="Navigation"]')).toBeNull()
})

it('keeps source management over the catalog without secondary navigation', async () => {
  await act(async () => root.render(<SharingMarketplacePage />))
  for (const text of ['Specialists', 'Browse specialists', 'Manage sources']) {
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((node) => !node.closest('[aria-hidden="true"]') && node.textContent === text)!
        .click()
    )
  }
  expect(
    container.querySelector(
      '[data-resource-catalog="marketplace"] [data-testid="specialists-panel"]'
    )?.textContent
  ).toContain('Specialists: marketplace-sources')
  expect(container.querySelector('nav[aria-label="Navigation"]')).toBeNull()
})

it.each([
  ['skills', false],
  ['specialists', false],
  ['skills', true],
  ['specialists', true]
] as const)(
  'retains independent %s catalog browsing with embedded=%s',
  async (resource, embedded) => {
    await act(async () => root.render(<SharingMarketplacePage embedded={embedded} />))
    if (resource === 'specialists') {
      if (embedded) {
        const trigger = container.querySelector('[role="combobox"][aria-label="Resource type"]')!
        await act(async () => fireEvent.keyDown(trigger, { key: 'Enter' }))
        await act(async () =>
          fireEvent.click(
            [...document.querySelectorAll('[role="option"]')].find(
              (node) => node.textContent === 'Specialists'
            )!
          )
        )
      } else await clickButton('Specialists')
    }
    const viewport = (mode: string): HTMLElement =>
      container.querySelector(
        `[data-resource-catalog="${mode}"]:has([data-testid="${resource}-panel"])`
      )!
    const setBrowse = async (
      mode: string,
      query: string,
      filter: string,
      top: number
    ): Promise<void> => {
      const pane = viewport(mode)
      await act(async () => {
        fireEvent.change(pane.querySelector('input')!, { target: { value: query } })
        fireEvent.change(pane.querySelector('select')!, { target: { value: filter } })
      })
      Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 600 })
      pane.scrollTop = top
      await act(async () => fireEvent.scroll(pane))
    }
    await setBrowse('installed', 'local query', 'selected', 180)
    const installed = viewport('installed')
    await clickButton(`Browse ${resource}`)
    await setBrowse('marketplace', 'market query', 'all', 420)
    const marketplace = viewport('marketplace')
    await clickButton('Installed catalog')
    expect(viewport('installed')).toBe(installed)
    expect(installed.getAttribute('aria-hidden')).toBe('false')
    expect(installed.querySelector('input')?.value).toBe('local query')
    expect(installed.querySelector('select')?.value).toBe('selected')
    expect(installed.scrollTop).toBe(180)
    await clickButton(`Browse ${resource}`)
    expect(viewport('marketplace')).toBe(marketplace)
    expect(marketplace.getAttribute('aria-hidden')).toBe('false')
    expect(marketplace.querySelector('input')?.value).toBe('market query')
    expect(marketplace.querySelector('select')?.value).toBe('all')
    expect(marketplace.scrollTop).toBe(420)
  }
)

it('returns from Connector credentials to the same draft and guards leaving while dirty or saving', async () => {
  await act(async () => root.render(<SharingMarketplacePage />))
  await clickButton('Connectors')
  await clickButton('Draft connector')
  const draft = (): HTMLInputElement => container.querySelector('[aria-label="Connector draft"]')!
  await act(async () => fireEvent.change(draft(), { target: { value: 'Research server' } }))
  await clickButton('Create credential')
  expect(container.textContent).toContain('Credential editor')
  await clickButton('Back')
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  expect(container.textContent).not.toContain('Credential editor')
  expect(draft().value).toBe('Research server')

  await clickButton('Back')
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find((button) => button.textContent === 'Keep editing')!
      .click()
  )
  expect(draft().value).toBe('Research server')
  await clickButton('Save connector')
  await clickButton('Skills')
  expect(
    container
      .querySelector('[data-resource-center-resource="connectors"]')
      ?.getAttribute('aria-hidden')
  ).toBe('false')
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  await clickButton('Finish connector save')
  await clickButton('Back')
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find((button) => button.textContent === 'Discard changes')!
      .click()
  )
  expect(container.querySelector('[data-testid="connectors-panel"]')?.textContent).toContain(
    'Connectors: list'
  )
})

it('reveals repeated Skill requests inline and keeps the list on Back', async () => {
  const render = async (): Promise<void> => {
    await act(async () =>
      root.render(<SharingMarketplacePage embedded skillDetailRequest={{ skillId: 'alpha' }} />)
    )
  }
  await render()
  const list = container.querySelector('[data-resource-catalog="installed"]')!
  for (let i = 0; i < 2; i++) {
    expect(container.querySelector('[data-slot="resource-inline-detail"]')?.textContent).toContain(
      'Skills: detail'
    )
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-slot="resource-inline-detail"] button[aria-label="Back"]'
        )!
        .click()
    )
    expect(container.querySelector('[data-slot="resource-inline-detail"]')).toBeNull()
    expect(container.querySelector('[data-resource-catalog="installed"]')).toBe(list)
    if (i === 0) await render()
  }
})

it.each(['built-in', 'custom'] as const)(
  'opens the referenced %s Connector from a Specialist',
  async (kind) => {
    useSettingsStore.setState({
      customServers: [
        {
          id: 'custom-record',
          name: 'research-connector',
          displayName: 'Research',
          transport: 'stdio',
          enabled: true
        }
      ]
    })
    await act(async () => root.render(<SharingMarketplacePage />))
    await clickButton('Specialists')
    await clickButton('Open specialist')
    const detail = document.querySelector('[role="dialog"]')!
    const link = [...detail.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === `Related ${kind} connector`
    )!
    await act(async () => link.click())
    expect(document.querySelector('[data-testid="connector-target"]')?.textContent).toBe(
      kind === 'custom' ? 'custom-record' : 'openalex'
    )
    expect(document.body.textContent).toContain(
      `Connectors: ${kind === 'custom' ? 'edit' : 'detail'}`
    )
    useSettingsStore.setState({ customServers: [] })
  }
)
