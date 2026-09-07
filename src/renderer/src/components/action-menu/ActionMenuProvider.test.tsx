// @vitest-environment jsdom
import { Check } from 'lucide-react'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

import {
  ActionMenuItems,
  ActionMenuProvider,
  ActionMenuTarget,
  useActionMenu,
  useActionMenuTarget,
  type ActionMenuBinding,
  type ActionMenuDefinition
} from './index'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type TestActionId = 'copy'
type MessageInvocation =
  | { kind: 'selection'; messageId: string; text: string }
  | { kind: 'message'; messageId: string; text: string }

const catalog: Record<TestActionId, ActionMenuDefinition> = {
  copy: { labelKey: 'Copy', icon: Check }
}
const recipe = [{ kind: 'action' as const, action: 'copy' as const }]

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
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const render = async (element: React.ReactNode): Promise<void> => {
  await act(async () => {
    root.render(element)
    await Promise.resolve()
  })
}

const openContextMenu = async (
  target: Element,
  pointer = { x: 37, y: 51 }
): Promise<MouseEvent> => {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: pointer.x,
    clientY: pointer.y
  })
  await act(async () => {
    target.dispatchEvent(event)
    await Promise.resolve()
  })
  return event
}

const clickAction = async (): Promise<void> => {
  const action = document.body.querySelector<HTMLElement>('[data-action-id="copy"]')
  if (!action) throw new Error('Copy action did not render')
  await act(async () => {
    action.click()
    await Promise.resolve()
  })
}

describe('ActionMenuProvider and ActionMenuTarget', () => {
  it('uses asChild and opens one pointer menu at the event viewport coordinates', async () => {
    await render(
      <ActionMenuProvider testId="target-menu">
        <ActionMenuTarget
          targetId="message-1"
          identityKey="message-1:v1"
          catalog={catalog}
          recipe={recipe}
          bindings={{ copy: { execute: () => undefined } }}
          invocation={{ kind: 'message', messageId: 'message-1', text: 'Full message' }}
          asChild
        >
          <button type="button">Message</button>
        </ActionMenuTarget>
      </ActionMenuProvider>
    )

    const target = container.querySelector('button')!
    expect(target.parentElement).toBe(container)
    const event = await openContextMenu(target)

    expect(event.defaultPrevented).toBe(true)
    expect(document.body.querySelector('[data-testid="target-menu"]')).not.toBeNull()
    expect(document.body.querySelector('[data-action-id="copy"]')).not.toBeNull()
    const anchor = document.body.querySelector<HTMLElement>('[data-testid="target-menu-anchor"]')
    expect(anchor?.style.cssText).toContain('left: 37px; top: 51px')
  })

  it('does not open or prevent the native menu when the invocation resolver returns null', async () => {
    await render(
      <ActionMenuProvider>
        <ActionMenuTarget
          targetId="message-1"
          identityKey="message-1:v1"
          catalog={catalog}
          recipe={recipe}
          bindings={{ copy: { execute: () => undefined } }}
          invocation={{ kind: 'message', messageId: 'message-1', text: 'Full message' }}
          resolveInvocation={() => null}
          asChild
        >
          <button type="button">Message</button>
        </ActionMenuTarget>
      </ActionMenuProvider>
    )

    const event = await openContextMenu(container.querySelector('button')!)

    expect(event.defaultPrevented).toBe(false)
    expect(document.body.querySelector('[data-action-id="copy"]')).toBeNull()
  })

  it('snapshots an open menu and uses current data on later opens with the same identity', async () => {
    const copied: string[] = []
    const SnapshotHarness = (): React.JSX.Element => {
      const [version, setVersion] = useState(1)
      const invocation: MessageInvocation =
        version === 1
          ? { kind: 'selection', messageId: 'message-1', text: 'Selected snapshot' }
          : { kind: 'message', messageId: 'message-1', text: 'Current message' }
      return (
        <ActionMenuProvider>
          <ActionMenuTarget
            targetId="message-1"
            identityKey="message-1:v1"
            catalog={catalog}
            recipe={version === 3 ? [] : recipe}
            bindings={{
              copy: {
                execute: (captured) => {
                  copied.push(`v${version}:${captured.text}`)
                }
              }
            }}
            invocation={invocation}
            asChild
          >
            <button type="button">Message</button>
          </ActionMenuTarget>
          <button
            type="button"
            data-testid="update-target"
            onClick={() => setVersion((current) => current + 1)}
          >
            Update
          </button>
        </ActionMenuProvider>
      )
    }
    await render(<SnapshotHarness />)

    await openContextMenu(container.querySelector('button')!)
    await act(async () =>
      container.querySelector<HTMLElement>('[data-testid="update-target"]')!.click()
    )
    await clickAction()
    expect(copied).toEqual(['v1:Selected snapshot'])

    await openContextMenu(container.querySelector('button')!)
    await clickAction()
    expect(copied).toEqual(['v1:Selected snapshot', 'v2:Current message'])

    await act(async () =>
      container.querySelector<HTMLElement>('[data-testid="update-target"]')!.click()
    )
    const event = await openContextMenu(container.querySelector('button')!)
    expect(event.defaultPrevented).toBe(false)
    expect(document.body.querySelector('[data-action-id="copy"]')).toBeNull()
  })

  it('supports future selection and whole-message invocation snapshots without core changes', async () => {
    const copied: string[] = []
    const bindings: Partial<Record<TestActionId, ActionMenuBinding<MessageInvocation>>> = {
      copy: {
        execute: (invocation) => {
          copied.push(invocation.text)
        }
      }
    }
    const Harness = (): React.JSX.Element => {
      const [invocation, setInvocation] = useState<MessageInvocation>({
        kind: 'selection',
        messageId: 'message-1',
        text: 'Selection'
      })
      return (
        <ActionMenuProvider>
          <ActionMenuTarget
            targetId="message-1"
            identityKey={`message-1:${invocation.kind}`}
            catalog={catalog}
            recipe={recipe}
            bindings={bindings}
            invocation={invocation}
            asChild
          >
            <button type="button" data-testid="message-target">
              Message
            </button>
          </ActionMenuTarget>
          <button
            type="button"
            data-testid="whole-message"
            onClick={() =>
              setInvocation({ kind: 'message', messageId: 'message-1', text: 'Whole message' })
            }
          >
            Whole message
          </button>
        </ActionMenuProvider>
      )
    }
    await render(<Harness />)

    await openContextMenu(container.querySelector('[data-testid="message-target"]')!)
    await clickAction()
    await act(async () =>
      container.querySelector<HTMLElement>('[data-testid="whole-message"]')!.click()
    )
    await openContextMenu(container.querySelector('[data-testid="message-target"]')!)
    await clickAction()

    expect(copied).toEqual(['Selection', 'Whole message'])
  })

  it('invalidates an open menu when its identity changes or target unregisters', async () => {
    const Harness = ({
      identityKey,
      visible
    }: {
      identityKey: string
      visible: boolean
    }): React.JSX.Element => (
      <ActionMenuProvider>
        {visible ? (
          <ActionMenuTarget
            targetId="message-1"
            identityKey={identityKey}
            catalog={catalog}
            recipe={recipe}
            bindings={{ copy: { execute: () => undefined } }}
            invocation={{ kind: 'message' as const, messageId: 'message-1', text: 'Message' }}
            asChild
          >
            <button type="button">Message</button>
          </ActionMenuTarget>
        ) : null}
      </ActionMenuProvider>
    )
    await render(<Harness identityKey="message-1:v1" visible />)
    await openContextMenu(container.querySelector('button')!)
    expect(document.body.querySelector('[data-action-id="copy"]')).not.toBeNull()

    await render(<Harness identityKey="message-1:v2" visible />)
    expect(document.body.querySelector('[data-action-id="copy"]')).toBeNull()

    await openContextMenu(container.querySelector('button')!)
    await render(<Harness identityKey="message-1:v2" visible={false} />)
    expect(document.body.querySelector('[data-action-id="copy"]')).toBeNull()
  })

  it('registers targets for external opens and removes them on unmount', async () => {
    const Harness = ({ visible }: { visible: boolean }): React.JSX.Element => {
      const controls = useActionMenu()
      return (
        <>
          {visible ? (
            <ActionMenuTarget
              targetId="external-target"
              identityKey="external:v1"
              catalog={catalog}
              recipe={recipe}
              bindings={{ copy: { execute: () => undefined } }}
              invocation={{ kind: 'message', messageId: 'message-1', text: 'Message' }}
              asChild
            >
              <button type="button">Target</button>
            </ActionMenuTarget>
          ) : null}
          <button
            type="button"
            data-testid="external-open"
            onClick={() =>
              controls.openMenu({
                targetId: 'external-target',
                pointer: { x: 11, y: 23 },
                focusTarget: document.activeElement
              })
            }
          >
            Open
          </button>
        </>
      )
    }
    await render(
      <ActionMenuProvider>
        <Harness visible />
      </ActionMenuProvider>
    )
    await act(async () =>
      container.querySelector<HTMLElement>('[data-testid="external-open"]')!.click()
    )
    expect(document.body.querySelector('[data-action-id="copy"]')).not.toBeNull()

    await render(
      <ActionMenuProvider>
        <Harness visible={false} />
      </ActionMenuProvider>
    )
    expect(document.body.querySelector('[data-action-id="copy"]')).toBeNull()
    await act(async () =>
      container.querySelector<HTMLElement>('[data-testid="external-open"]')!.click()
    )
    expect(document.body.querySelector('[data-action-id="copy"]')).toBeNull()
  })

  it('executes the action belonging to the target that opened the menu', async () => {
    const executed: string[] = []
    await render(
      <ActionMenuProvider>
        {['first', 'second'].map((targetId) => (
          <ActionMenuTarget
            key={targetId}
            targetId={targetId}
            identityKey={`${targetId}:v1`}
            catalog={catalog}
            recipe={recipe}
            bindings={{
              copy: {
                execute: (invocation) => {
                  executed.push(invocation.text)
                }
              }
            }}
            invocation={{ kind: 'message', messageId: targetId, text: targetId }}
            asChild
          >
            <button type="button" data-target-id={targetId}>
              {targetId}
            </button>
          </ActionMenuTarget>
        ))}
      </ActionMenuProvider>
    )

    await openContextMenu(container.querySelector('[data-target-id="second"]')!)
    await clickAction()

    expect(executed).toEqual(['second'])
  })

  it('restores focus to the element active when the pointer menu opened', async () => {
    await render(
      <ActionMenuProvider>
        <ActionMenuTarget
          targetId="message-1"
          identityKey="message-1:v1"
          catalog={catalog}
          recipe={recipe}
          bindings={{ copy: { execute: () => undefined } }}
          invocation={{ kind: 'message', messageId: 'message-1', text: 'Message' }}
          asChild
        >
          <button type="button">Message</button>
        </ActionMenuTarget>
      </ActionMenuProvider>
    )
    const target = container.querySelector('button')!
    target.focus()
    await openContextMenu(target)
    await clickAction()
    await act(async () => queueMicrotask(() => undefined))

    expect(document.activeElement).toBe(target)
  })

  it('lets a target override focus restoration after an action hands focus elsewhere', async () => {
    let restoreRequested = false
    await render(
      <ActionMenuProvider>
        <ActionMenuTarget
          targetId="message-1"
          identityKey="message-1:v1"
          catalog={catalog}
          recipe={recipe}
          bindings={{ copy: { execute: () => undefined } }}
          invocation={{ kind: 'message', messageId: 'message-1', text: 'Message' }}
          onRestoreFocus={() => {
            restoreRequested = true
          }}
          asChild
        >
          <button type="button">Message</button>
        </ActionMenuTarget>
      </ActionMenuProvider>
    )
    const target = container.querySelector('button')!
    target.focus()
    await openContextMenu(target)
    await clickAction()
    await act(async () => queueMicrotask(() => undefined))

    expect(restoreRequested).toBe(true)
    expect(document.activeElement).not.toBe(target)
  })

  it('applies a caller-provided content layer only to that provider menu', async () => {
    await render(
      <ActionMenuProvider testId="dialog-menu" contentClassName="z-[70]">
        <ActionMenuTarget
          targetId="dialog-target"
          identityKey="dialog-target:v1"
          catalog={catalog}
          recipe={recipe}
          bindings={{ copy: { execute: () => undefined } }}
          invocation={{ kind: 'message', messageId: 'message-1', text: 'Message' }}
          asChild
        >
          <button type="button">Dialog target</button>
        </ActionMenuTarget>
      </ActionMenuProvider>
    )

    await openContextMenu(container.querySelector('button')!)

    expect(document.body.querySelector('[data-testid="dialog-menu"]')?.classList).toContain(
      'z-[70]'
    )
  })
})

const TargetExecutionControls = ({ name }: { name: string }): React.JSX.Element => {
  const target = useActionMenuTarget<TestActionId>()
  const action = target.entries.find((entry) => entry.kind === 'action')
  return (
    <>
      <button type="button" data-run={name} onClick={() => void target.execute('copy')}>
        Run {name}
      </button>
      <output data-state={name}>
        {action?.kind === 'action' && action.disabled ? 'disabled' : 'enabled'}
      </output>
    </>
  )
}

describe('Action Menu execution protection', () => {
  it('keeps another target pointer menu open when an async action settles', async () => {
    let resolveFirst: (() => void) | undefined
    await render(
      <ActionMenuProvider testId="pending-menu">
        {['first', 'second'].map((name) => (
          <ActionMenuTarget
            key={name}
            targetId={name}
            identityKey={`${name}:v1`}
            catalog={catalog}
            recipe={recipe}
            bindings={{
              copy: {
                execute:
                  name === 'first'
                    ? () => new Promise<void>((resolve) => (resolveFirst = resolve))
                    : () => undefined
              }
            }}
            invocation={{ kind: 'message', messageId: name, text: name }}
            asChild
          >
            <button type="button" data-target-id={name}>
              {name}
            </button>
          </ActionMenuTarget>
        ))}
      </ActionMenuProvider>
    )

    await openContextMenu(container.querySelector('[data-target-id="first"]')!)
    await clickAction()
    await openContextMenu(container.querySelector('[data-target-id="first"]')!)
    expect(
      document.body.querySelector('[data-action-id="copy"]')?.hasAttribute('data-disabled')
    ).toBe(true)
    await openContextMenu(container.querySelector('[data-target-id="second"]')!)
    expect(document.body.querySelector('[data-testid="pending-menu"]')).not.toBeNull()
    expect(
      document.body.querySelector('[data-action-id="copy"]')?.hasAttribute('data-disabled')
    ).toBe(false)

    if (!resolveFirst) throw new Error('Expected the first async action to start')
    const settleFirst = resolveFirst
    await act(async () => {
      settleFirst()
      await Promise.resolve()
    })

    expect(document.body.querySelector('[data-testid="pending-menu"]')).not.toBeNull()
    expect(
      document.body.querySelector('[data-action-id="copy"]')?.hasAttribute('data-disabled')
    ).toBe(false)
    await openContextMenu(container.querySelector('[data-target-id="first"]')!)
    expect(
      document.body.querySelector('[data-action-id="copy"]')?.hasAttribute('data-disabled')
    ).toBe(false)
  })

  it('blocks duplicate async execution for one identity while allowing another target', async () => {
    const resolvers = new Map<string, () => void>()
    const executions: string[] = []
    const buildBinding = (name: string): ActionMenuBinding<MessageInvocation> => ({
      execute: () => {
        executions.push(name)
        return new Promise<void>((resolve) => resolvers.set(name, resolve))
      }
    })
    await render(
      <ActionMenuProvider>
        {['first', 'second'].map((name) => (
          <ActionMenuTarget
            key={name}
            targetId={name}
            identityKey={`${name}:v1`}
            catalog={catalog}
            recipe={recipe}
            bindings={{ copy: buildBinding(name) }}
            invocation={{ kind: 'message', messageId: name, text: name }}
            asChild
          >
            <div>
              <TargetExecutionControls name={name} />
            </div>
          </ActionMenuTarget>
        ))}
      </ActionMenuProvider>
    )

    await act(async () => {
      container.querySelector<HTMLElement>('[data-run="first"]')!.click()
      container.querySelector<HTMLElement>('[data-run="first"]')!.click()
      container.querySelector<HTMLElement>('[data-run="second"]')!.click()
      await Promise.resolve()
    })

    expect(executions).toEqual(['first', 'second'])
    expect(container.querySelector('[data-state="first"]')?.textContent).toBe('disabled')
    expect(container.querySelector('[data-state="second"]')?.textContent).toBe('disabled')

    await act(async () => {
      resolvers.get('first')?.()
      resolvers.get('second')?.()
      await Promise.resolve()
    })
    expect(container.querySelector('[data-state="first"]')?.textContent).toBe('enabled')
    expect(container.querySelector('[data-state="second"]')?.textContent).toBe('enabled')
  })

  it('releases the execution lock after synchronous throws and promise rejections', async () => {
    let attempt = 0
    const failures: unknown[] = []
    const binding: ActionMenuBinding<MessageInvocation> = {
      execute: () => {
        attempt += 1
        if (attempt === 1) throw new Error('sync failure')
        if (attempt === 2) return Promise.reject(new Error('async failure'))
        return undefined
      }
    }
    await render(
      <ActionMenuProvider onActionError={(error) => failures.push(error)}>
        <ActionMenuTarget
          targetId="message-1"
          identityKey="message-1:v1"
          catalog={catalog}
          recipe={recipe}
          bindings={{ copy: binding }}
          invocation={{ kind: 'message', messageId: 'message-1', text: 'Message' }}
          asChild
        >
          <div>
            <TargetExecutionControls name="message" />
          </div>
        </ActionMenuTarget>
      </ActionMenuProvider>
    )

    for (let index = 0; index < 3; index += 1) {
      await act(async () => {
        container.querySelector<HTMLElement>('[data-run="message"]')!.click()
        await Promise.resolve()
      })
      expect(container.querySelector('[data-state="message"]')?.textContent).toBe('enabled')
    }

    expect(attempt).toBe(3)
    expect(failures.map((failure) => (failure as Error).message)).toEqual([
      'sync failure',
      'async failure'
    ])
  })

  it('renders the same resolved entries inside a regular dropdown menu consumer', async () => {
    const selected: string[] = []
    const MoreMenu = (): React.JSX.Element => {
      const target = useActionMenuTarget<TestActionId>()
      return (
        <DropdownMenu open>
          <DropdownMenuTrigger>More</DropdownMenuTrigger>
          <DropdownMenuContent>
            <ActionMenuItems
              entries={target.entries}
              onSelect={(action) => {
                selected.push(action)
                void target.execute(action)
              }}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )
    }
    await render(
      <ActionMenuProvider>
        <ActionMenuTarget
          targetId="message-1"
          identityKey="message-1:v1"
          catalog={catalog}
          recipe={recipe}
          bindings={{ copy: { execute: () => undefined } }}
          invocation={{ kind: 'message', messageId: 'message-1', text: 'Message' }}
          asChild
        >
          <div>
            <MoreMenu />
          </div>
        </ActionMenuTarget>
      </ActionMenuProvider>
    )

    expect(document.body.querySelector('[data-action-id="copy"]')).not.toBeNull()
    await act(async () =>
      document.body.querySelector<HTMLElement>('[data-action-id="copy"]')!.click()
    )
    expect(selected).toEqual(['copy'])
  })
})
