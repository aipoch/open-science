// @vitest-environment jsdom
import { act, type PropsWithChildren } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SpecialistSubmenu } from './SpecialistSubmenu'
import { useSpecialistStore } from '@/stores/specialist-store'
import { useSettingsStore } from '@/stores/settings-store'
import type { SpecialistListItem } from '../../../../shared/specialist'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Mock dropdown-menu to avoid Portal/open-state issues in jsdom.
// Submenus render inline so tests can assert on data-testid attributes without
// needing to drive Radix pointer hover to open the submenu.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>,
  DropdownMenuContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div data-testid="dd-content">{children}</div>
  ),
  DropdownMenuSub: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>,
  DropdownMenuSubTrigger: ({
    children,
    ...rest
  }: PropsWithChildren<Record<string, unknown>>): React.JSX.Element => (
    <div {...rest}>{children}</div>
  ),
  DropdownMenuSubContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div data-testid="dd-subcontent">{children}</div>
  ),
  DropdownMenuSeparator: (): React.JSX.Element => <hr />,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
    ...rest
  }: PropsWithChildren<{
    disabled?: boolean
    onSelect?: (event: { preventDefault: () => void }) => void
    [key: string]: unknown
  }>): React.JSX.Element => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        onSelect?.({ preventDefault: () => undefined })
      }}
      {...rest}
    >
      {children}
    </button>
  )
}))

vi.mock('@/stores/specialist-store', () => ({
  useSpecialistStore: vi.fn()
}))

vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: vi.fn()
}))

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' ')
}))

// window.api stub for the catalog-change subscription.
Object.defineProperty(globalThis, 'window', {
  writable: true,
  value: {
    ...globalThis.window,
    api: {
      specialist: {
        onCatalogChanged: vi.fn(() => vi.fn())
      }
    }
  }
})

const makeSpecialist = (
  id: string,
  name: string,
  enabled = true
): SpecialistListItem & { kind: 'custom' } => ({
  kind: 'custom',
  id,
  name,
  description: '',
  systemPrompt: 'You are...',
  enabled,
  capabilityMode: 'full',
  fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
  selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
  revision: 1
})

const makeBuiltin = (enabled = true): SpecialistListItem => ({
  ...makeSpecialist('builtin-curator', 'BUILTIN_CURATOR', enabled),
  kind: 'builtin',
  readonly: true,
  version: '1.0.0',
  revision: 0
})

const mockStore = (
  items: SpecialistListItem[],
  overrides: { isLoaded?: boolean; load?: () => Promise<void> } = {}
): void => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(useSpecialistStore as any).mockImplementation(
    (
      selector: (s: {
        items: SpecialistListItem[]
        isLoaded: boolean
        load: () => Promise<void>
      }) => unknown
    ) =>
      selector({
        items,
        isLoaded: overrides.isLoaded ?? true,
        load: overrides.load ?? vi.fn().mockResolvedValue(undefined)
      })
  )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(useSettingsStore as any).mockImplementation(
    (selector: (s: { openSettingsToPanel: (panel: string) => void }) => unknown) =>
      selector({ openSettingsToPanel: vi.fn() })
  )
}

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
  vi.clearAllMocks()
})

const renderSubmenu = (props: React.ComponentProps<typeof SpecialistSubmenu>): void => {
  act(() => {
    root.render(<SpecialistSubmenu {...props} />)
  })
}

describe('SpecialistSubmenu — trigger', () => {
  it('does not load the catalog when the specialist list API is unavailable', () => {
    const load = vi.fn().mockResolvedValue(undefined)
    mockStore([], { isLoaded: false, load })

    renderSubmenu({ selectedId: undefined, onChange: vi.fn() })

    expect(load).not.toHaveBeenCalled()
  })

  it('renders a submenu trigger', () => {
    mockStore([])
    renderSubmenu({ selectedId: undefined, onChange: vi.fn() })
    expect(container.querySelector('[data-testid="specialist-submenu-trigger"]')).toBeTruthy()
  })

  it('shows "None" in the capsule when nothing is selected', () => {
    mockStore([])
    renderSubmenu({ selectedId: undefined, onChange: vi.fn() })
    const trigger = container.querySelector('[data-testid="specialist-submenu-trigger"]')!
    expect(trigger.textContent).toContain('None')
    expect(trigger.textContent).not.toContain('Bind a personal specialist to this conversation.')
  })

  it('shows the specialist name in the capsule when one is selected', () => {
    const sp = makeSpecialist('uuid-1', 'RNA-seq Reviewer')
    mockStore([sp])
    renderSubmenu({ selectedId: 'uuid-1', onChange: vi.fn() })
    const trigger = container.querySelector('[data-testid="specialist-submenu-trigger"]')!
    expect(trigger.textContent).toContain('RNA-seq Reviewer')
  })

  it('shows "Unavailable" in the capsule when unavailable prop is true', () => {
    mockStore([])
    renderSubmenu({ selectedId: 'stale-id', onChange: vi.fn(), unavailable: true })
    const trigger = container.querySelector('[data-testid="specialist-submenu-trigger"]')!
    expect(trigger.textContent).toContain('Unavailable')
  })

  it('keeps a bound session specialist visible but disables the trigger and hides options', () => {
    const sp = makeSpecialist('uuid-1', 'RNA-seq Reviewer')
    mockStore([sp])
    renderSubmenu({ selectedId: 'uuid-1', onChange: vi.fn(), readOnly: true })
    const trigger = container.querySelector<HTMLElement>(
      '[data-testid="specialist-submenu-trigger"]'
    )!
    expect(trigger.textContent).toContain('RNA-seq Reviewer')
    expect(trigger.hasAttribute('disabled')).toBe(true)
    // No mutable submenu content is offered for a bound session.
    expect(container.querySelector('[data-testid="dd-subcontent"]')).toBeNull()
    expect(container.querySelector('[data-testid="specialist-option-none"]')).toBeNull()
  })
})

describe('SpecialistSubmenu — submenu contents', () => {
  it('includes None option', () => {
    mockStore([makeSpecialist('uuid-1', 'RNA-seq Reviewer')])
    renderSubmenu({ selectedId: undefined, onChange: vi.fn() })
    expect(
      container.querySelector('[data-testid="specialist-option-none"]') ??
        document.body.querySelector('[data-testid="specialist-option-none"]')
    ).toBeTruthy()
  })

  it('lists enabled specialists', () => {
    const sp = makeSpecialist('uuid-1', 'RNA-seq Reviewer')
    mockStore([sp])
    renderSubmenu({ selectedId: undefined, onChange: vi.fn() })
    expect(container.querySelector('[data-testid="specialist-option-uuid-1"]')).toBeTruthy()
  })

  it('lists enabled runnable builtins and persists their stable id through selection', () => {
    const onChange = vi.fn()
    mockStore([makeBuiltin()])
    renderSubmenu({ selectedId: undefined, onChange })

    const option = container.querySelector<HTMLButtonElement>(
      '[data-testid="specialist-option-builtin-curator"]'
    )
    expect(option).toBeTruthy()
    act(() => option?.click())
    expect(onChange).toHaveBeenCalledWith('builtin-curator')
  })

  it('does NOT list disabled specialists', () => {
    const disabled = makeSpecialist('uuid-disabled', 'Disabled Bot', false)
    mockStore([disabled])
    renderSubmenu({ selectedId: undefined, onChange: vi.fn() })
    expect(container.querySelector('[data-testid="specialist-option-uuid-disabled"]')).toBeNull()
  })

  it('does NOT list Reviewer entry', () => {
    const items: SpecialistListItem[] = [{ kind: 'reviewer', id: 'reviewer' }]
    mockStore(items)
    renderSubmenu({ selectedId: undefined, onChange: vi.fn() })
    expect(container.querySelector('[data-testid="specialist-option-reviewer"]')).toBeNull()
  })

  it('includes Create new… option', () => {
    mockStore([])
    renderSubmenu({ selectedId: undefined, onChange: vi.fn() })
    expect(container.querySelector('[data-testid="specialist-option-create"]')).toBeTruthy()
  })
})

describe('SpecialistSubmenu — selection', () => {
  it('calls onChange with undefined when None is selected', () => {
    const sp = makeSpecialist('uuid-1', 'RNA-seq Reviewer')
    const onChange = vi.fn()
    mockStore([sp])
    renderSubmenu({ selectedId: 'uuid-1', onChange })
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="specialist-option-none"]')?.click()
    })
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it('calls onChange with specialist id when specialist is selected', () => {
    const sp = makeSpecialist('uuid-1', 'RNA-seq Reviewer')
    const onChange = vi.fn()
    mockStore([sp])
    renderSubmenu({ selectedId: undefined, onChange })
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="specialist-option-uuid-1"]')
        ?.click()
    })
    expect(onChange).toHaveBeenCalledWith('uuid-1')
  })

  it('opens settings to specialists panel when Create new… is clicked', () => {
    const openSettingsToPanel = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(useSpecialistStore as any).mockImplementation(
      (
        selector: (s: {
          items: SpecialistListItem[]
          isLoaded: boolean
          load: () => Promise<void>
        }) => unknown
      ) => selector({ items: [], isLoaded: true, load: vi.fn().mockResolvedValue(undefined) })
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(useSettingsStore as any).mockImplementation(
      (selector: (s: { openSettingsToPanel: (panel: string) => void }) => unknown) =>
        selector({ openSettingsToPanel })
    )
    renderSubmenu({ selectedId: undefined, onChange: vi.fn() })
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="specialist-option-create"]')
        ?.click()
    })
    expect(openSettingsToPanel).toHaveBeenCalledWith('specialists')
  })
})

// ---------------------------------------------------------------------------
// Tests: unavailable-session switching behavior (issue 07)
// ---------------------------------------------------------------------------

describe('SpecialistSubmenu — unavailable bound specialist', () => {
  it('shows the unavailable bound specialist struck-through and not selectable', () => {
    // Simulates a catalog that has the specialist as disabled (after setEnabled(false)).
    const disabledSp = makeSpecialist('uuid-disabled', 'DEBUGGER', false)
    mockStore([disabledSp])
    renderSubmenu({ selectedId: 'uuid-disabled', onChange: vi.fn(), unavailable: true })
    // The unavailable item is rendered as a non-interactive div (not a button).
    const item = container.querySelector('[data-testid="specialist-option-uuid-disabled"]')
    expect(item).toBeTruthy()
    expect(item?.tagName).not.toBe('BUTTON')
    expect(item?.textContent).toContain('DEBUGGER')
    expect(item?.textContent).toContain('Unavailable')
    // Should have line-through class.
    expect(item?.innerHTML).toContain('line-through')
  })

  it('still shows enabled specialists alongside the unavailable one', () => {
    const disabledSp = makeSpecialist('uuid-disabled', 'DEBUGGER', false)
    const enabledSp = makeSpecialist('uuid-other', 'RESEARCHER', true)
    mockStore([disabledSp, enabledSp])
    renderSubmenu({ selectedId: 'uuid-disabled', onChange: vi.fn(), unavailable: true })
    expect(container.querySelector('[data-testid="specialist-option-uuid-disabled"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="specialist-option-uuid-other"]')).toBeTruthy()
  })

  it('does NOT render an unavailable item for a session with no current specialist', () => {
    // A different disabled specialist should not appear for a session that never had it bound.
    const disabledSp = makeSpecialist('uuid-other', 'OTHER', false)
    mockStore([disabledSp])
    // selectedId is undefined and unavailable is false — no bound specialist.
    renderSubmenu({ selectedId: undefined, onChange: vi.fn(), unavailable: false })
    expect(container.querySelector('[data-testid="specialist-option-uuid-other"]')).toBeNull()
  })

  it('does NOT render the unavailable item if the specialist was already removed from catalog', () => {
    // UUID not in the catalog at all (e.g. deleted, not just disabled).
    mockStore([]) // empty catalog
    renderSubmenu({ selectedId: 'uuid-gone', onChange: vi.fn(), unavailable: true })
    // The unavailable item can only appear when the profile is in the store.
    // When it's fully gone the item is absent — the banner/capsule still says Unavailable.
    const item = container.querySelector('[data-testid="specialist-option-uuid-gone"]')
    expect(item).toBeNull()
    // But the trigger should still show "Unavailable" in the capsule.
    const trigger = container.querySelector('[data-testid="specialist-submenu-trigger"]')!
    expect(trigger.textContent).toContain('Unavailable')
  })
})
