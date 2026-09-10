// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { i18next } from '@/i18n'
import { useUpdateStore } from '@/stores/update-store'
import { UpdateDialog } from './UpdateDialog'
vi.mock('@/components/streamdown/AgentMarkdown', () => ({
  AgentMarkdown: ({ content }: { content: string }) => <div>{content}</div>
}))
let container: HTMLDivElement, root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  useUpdateStore.setState({ isDialogOpen: false, status: { state: 'idle', current: '' } })
  await i18next.changeLanguage('en')
})
it.each([
  'Research work is still running. Stop it before restarting to update.',
  'Subagents are still running. Return to their tasks and stop them before restarting to update.'
])('translates the research blocker in Simplified Chinese: %s', async (error) => {
  await i18next.changeLanguage('zh-Hans')
  useUpdateStore.setState({
    isDialogOpen: true,
    status: {
      state: 'error',
      current: '1.0.0',
      latest: '1.1.0',
      applyKind: 'restart',
      blockedBy: [error.startsWith('Subagents') ? 'delegated' : 'agent'],
      error
    }
  })
  act(() => root.render(<UpdateDialog />))
  const alert = document.querySelector('[role="alert"]')
  expect(alert).not.toBeNull()
  expect(alert?.textContent).not.toContain(error)
  expect(document.body.textContent).not.toContain('Download update')
})

it('keeps restart actionable after a gate refusal and sends apply instead of download', () => {
  const apply = vi.fn(async () => {}),
    download = vi.fn(async () => {})
  useUpdateStore.setState({
    isDialogOpen: true,
    apply,
    download,
    status: {
      state: 'ready',
      current: '1.0.0',
      latest: '1.1.0',
      applyKind: 'restart',
      blockedBy: ['agent'],
      error: 'Research work is still running. Stop it before restarting to update.'
    }
  })
  act(() => root.render(<UpdateDialog />))
  const restart = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Restart to update'
  )
  expect(restart).toBeDefined()
  act(() => restart!.click())
  expect(apply).toHaveBeenCalledTimes(1)
  expect(download).not.toHaveBeenCalled()
})

it('shows manual verification without promising restart and prevents repeated actions', () => {
  useUpdateStore.setState({
    isDialogOpen: true,
    status: { state: 'applying', current: '1.0.0', latest: '1.1.0', applyKind: 'installer' }
  })
  act(() => root.render(<UpdateDialog />))
  expect(document.body.textContent).toContain('Verifying installer…')
  expect(document.body.textContent).not.toContain('will close to finish installing')
  for (const button of document.querySelectorAll('button')) expect(button.disabled).toBe(true)
})

it('retains unknown technical errors even when a blocker is present', () => {
  useUpdateStore.setState({
    isDialogOpen: true,
    status: {
      state: 'error',
      current: '1.0.0',
      latest: '1.1.0',
      applyKind: 'restart',
      blockedBy: ['agent'],
      error: 'E_CUSTOM: connection lost'
    }
  })
  act(() => root.render(<UpdateDialog />))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'E_CUSTOM: connection lost'
  )
})

it('renders the delegated blocker in Japanese', async () => {
  await i18next.changeLanguage('ja')
  useUpdateStore.setState({
    isDialogOpen: true,
    status: {
      state: 'ready',
      current: '1.0.0',
      latest: '1.1.0',
      applyKind: 'restart',
      blockedBy: ['delegated'],
      error:
        'Subagents are still running. Return to their tasks and stop them before restarting to update.'
    }
  })
  act(() => root.render(<UpdateDialog />))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'サブエージェントがまだ実行中です。'
  )
})
