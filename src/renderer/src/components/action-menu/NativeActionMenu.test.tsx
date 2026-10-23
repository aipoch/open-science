// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Check } from 'lucide-react'
import { afterEach, expect, it, vi } from 'vitest'
import { ActionMenuDropdown } from './ActionMenuDropdown'
import type {
  NativeActionMenuRequest,
  NativeActionMenuResult
} from '../../../../shared/action-menu-overlay'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
let cleanup = (): void => {}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('opens a button menu with serializable presentation and restores focus before executing once', async () => {
  let request: NativeActionMenuRequest | undefined
  let listener: ((result: NativeActionMenuResult) => void) | undefined
  const closed: string[] = []
  const api = {
    window: {
      openActionMenu: (value: NativeActionMenuRequest) => {
        request = value
      },
      closeActionMenu: (id: string) => {
        closed.push(id)
      },
      onActionMenuClosed: (handler: typeof listener) => {
        listener = handler
        return () => {
          listener = undefined
        }
      }
    }
  }
  vi.stubGlobal('api', api)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  cleanup = () => {
    act(() => root.unmount())
    container.remove()
  }
  const selected: string[] = []
  await act(async () =>
    root.render(
      <StrictMode>
        <ActionMenuDropdown
          entries={[
            {
              kind: 'action',
              action: 'copy',
              labelKey: 'Copy',
              icon: Check,
              disabled: false,
              danger: false
            }
          ]}
          onSelect={(id) => {
            expect(document.activeElement).toBe(container.querySelector('button'))
            selected.push(id)
          }}
        >
          <button>More</button>
        </ActionMenuDropdown>
      </StrictMode>
    )
  )
  vi.spyOn(container.querySelector('button')!, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    right: 120,
    top: 50,
    bottom: 70,
    width: 20,
    height: 20,
    x: 100,
    y: 50,
    toJSON: () => ({})
  })
  await act(async () =>
    container
      .querySelector('button')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  )
  expect(request).toMatchObject({ pointer: { x: 120, y: 74 }, align: 'end', focusFirst: true })
  expect(request?.entries[0]).toMatchObject({ action: 'copy', label: 'Copy', disabled: false })
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(() => structuredClone(request)).not.toThrow()
  expect(closed.length).toBeGreaterThan(0)
  expect(request!.id).not.toBe(closed[0])
  await act(async () => listener?.({ id: closed[0], action: 'copy' }))
  await act(async () => listener?.({ id: 'stale', action: 'copy' }))
  expect(selected).toEqual([])
  const id = request!.id
  await act(async () => listener?.({ id, action: 'copy' }))
  expect(selected).toEqual(['copy'])
  expect(closed).toContain(id)
  expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
})

it('preserves right-side placement in the native request', async () => {
  let request: NativeActionMenuRequest | undefined
  const api = {
    window: {
      openActionMenu: (value: NativeActionMenuRequest) => {
        request = value
      },
      closeActionMenu: () => {},
      onActionMenuClosed: () => () => {}
    }
  }
  vi.stubGlobal('api', api)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  cleanup = () => {
    act(() => root.unmount())
    container.remove()
  }

  await act(async () =>
    root.render(
      <ActionMenuDropdown
        side="right"
        align="start"
        entries={[
          {
            kind: 'action',
            action: 'copy',
            labelKey: 'Copy',
            icon: Check,
            disabled: false,
            danger: false
          }
        ]}
        onSelect={() => {}}
      >
        <button>More</button>
      </ActionMenuDropdown>
    )
  )
  vi.spyOn(container.querySelector('button')!, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    right: 120,
    top: 50,
    bottom: 70,
    width: 20,
    height: 20,
    x: 100,
    y: 50,
    toJSON: () => ({})
  })
  await act(async () =>
    container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  )

  expect(request).toMatchObject({ side: 'right', align: 'start', pointer: { x: 124, y: 50 } })
})
