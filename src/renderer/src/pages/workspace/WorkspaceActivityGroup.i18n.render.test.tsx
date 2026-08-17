// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
import { WorkspaceActivityGroup } from './WorkspaceActivityGroup'

vi.mock('@/components/ui/message-scroller', () => ({
  MessageScrollerItem: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  await i18next.changeLanguage('en')
})

describe('WorkspaceActivityGroup i18n', () => {
  it('re-renders a completed group when the interface language changes', async () => {
    act(() => {
      root.render(
        <WorkspaceActivityGroup
          group={{
            id: 'group-1',
            type: 'activity-group',
            createdAt: 1,
            sortIndex: 1,
            activities: [
              {
                id: 'activity-1',
                kind: 'tool',
                title: 'Bash',
                status: 'completed',
                eventIds: [],
                sortIndex: 1,
                createdAt: 1,
                updatedAt: 2,
                toolKind: 'execute',
                providerToolName: 'bash',
                rawInput: { command: 'pwd' },
                rawOutput: 'done'
              }
            ]
          }}
          isExpanded={true}
          onToggleGroup={vi.fn()}
          expansionOverrides={{ 'activity-1': true }}
          onToggleRow={vi.fn()}
        />
      )
    })

    expect(container.textContent).toContain('Ran a command')
    expect(container.textContent).toContain('Command')
    expect(container.textContent).toContain('Output')
    await act(async () => i18next.changeLanguage('zh-Hans'))
    expect(container.textContent).toContain('运行了一个命令')
    expect(container.textContent).toContain('命令')
    expect(container.textContent).toContain('输出')
    expect(container.textContent).not.toContain('Ran a command')
    expect(container.textContent).not.toContain('Command')
  })
})
