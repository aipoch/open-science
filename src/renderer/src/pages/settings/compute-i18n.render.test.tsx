// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeApprovalRequest, ComputeHost } from '../../../../shared/compute'
import { ComputeApprovalDialog } from './ComputeApprovalDialog'
import { ComputeHostDetail } from './ComputeHostDetail'
import { ComputePanel } from './ComputePanel'
import { i18next } from '@/i18n'
import { createInitialComputeState, useComputeStore } from '@/stores/compute-store'

let container: HTMLDivElement
let root: Root

const host = (overrides: Partial<ComputeHost> = {}): ComputeHost => ({
  id: 'host-1',
  providerId: 'ssh:biowulf',
  displayName: 'biowulf',
  shape: 'direct_ssh',
  sshAlias: 'biowulf',
  sshOverrides: undefined,
  scratchRoot: undefined,
  scratchPinned: false,
  concurrencyLimit: undefined,
  probeResult: undefined,
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const approvalRequest: ComputeApprovalRequest = {
  id: 'approval-1',
  provider_id: 'ssh:cluster',
  provider_name: 'Research cluster',
  shape: 'direct_ssh',
  intent: 'Inspect the remote environment',
  command_preview: 'python ...',
  command_full: 'python --version && pip list'
}

// Stub window.api.compute.detailsGet so ComputeHostDetail does not hit real IPC. Only the api
// property is replaced — Radix's portal and tooltip layers need the real jsdom window.
const stubDetailsGet = (doc: string, isSkeleton = false): void => {
  ;(window as unknown as { api: { compute: Record<string, unknown> } }).api = {
    compute: {
      detailsGet: vi.fn().mockResolvedValue({ doc, isSkeleton }),
      deletionStatus: vi.fn().mockResolvedValue({ blockedByJobs: false })
    }
  }
}

// The detail page loads its doc in an effect; let the promise chain settle before asserting.
const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const switchTo = (language: string): void => {
  act(() => {
    void i18next.changeLanguage(language)
  })
}

// Radix portals render outside the container, so approval-dialog queries go through document.body.
const findBodyButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === label
  )

const findButtonIn = (label: string, blockText: string): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find(
    (button) =>
      button.textContent?.trim() === label &&
      button.closest('div')?.textContent?.includes(blockText)
  )

// React swallows a direct .value assignment on a controlled input; go through the prototype setter.
const setInputValue = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  // Reset before rendering, not just after unmounting, so a leaked language can never reach an
  // assertion: changeLanguage settles on a promise the previous afterEach did not await.
  switchTo('en')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useComputeStore.setState({
    ...createInitialComputeState(),
    isLoaded: true,
    loadHosts: vi.fn(),
    probeHost: vi.fn(),
    deleteHost: vi.fn(),
    saveDetails: vi.fn(),
    setScratch: vi.fn(),
    setConcurrency: vi.fn(),
    respondApproval: vi.fn().mockResolvedValue(undefined)
  })
  stubDetailsGet('')
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  switchTo('en')
  vi.restoreAllMocks()
})

describe('ComputePanel i18n', () => {
  it('translates the banner, the list header and the add action', () => {
    act(() => root.render(<ComputePanel onNavigate={vi.fn()} />))

    expect(container.textContent).toContain('Connect where heavy compute runs')
    expect(container.textContent).toContain('SSH hosts')
    expect(container.textContent).toContain('Add SSH host')
    expect(container.textContent).toContain('No SSH hosts yet')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('通过 SSH 连接你自己的服务器，为繁重任务提供算力')
    expect(container.textContent).toContain('SSH 主机')
    expect(container.textContent).toContain('添加 SSH 主机')
    expect(container.textContent).toContain('还没有 SSH 主机')
    expect(container.textContent).not.toContain('Connect where heavy compute runs')
    expect(container.textContent).not.toContain('No SSH hosts yet')

    switchTo('zh-Hant')
    expect(container.textContent).toContain('連接執行重型計算的地方')
    expect(container.textContent).toContain('SSH 主機')
    expect(container.textContent).toContain('新增 SSH 主機')
    expect(container.textContent).toContain('還沒有 SSH 主機')
    expect(container.textContent).not.toContain('{{')
  })

  it('localizes a host-list failure and keeps backend details out of the primary error', () => {
    useComputeStore.setState({
      loadError: 'SQLITE_BUSY while reading /private/data/compute.db',
      isLoaded: true
    })
    act(() => root.render(<ComputePanel onNavigate={vi.fn()} />))

    switchTo('zh-Hans')

    const primary = container.querySelector('.text-destructive')
    expect(primary?.textContent).toBe('无法加载主机。')
    expect(primary?.textContent).not.toContain('/private/data/compute.db')
    const details = container.querySelector('details')
    expect(details?.open).toBe(false)
    expect(details?.textContent).toContain('/private/data/compute.db')
  })

  it('re-renders the removal toast in the language active at render time', async () => {
    const deleteHost = vi.fn(() => Promise.resolve())
    useComputeStore.setState({ hosts: [host()], isLoaded: true, deleteHost })
    act(() => root.render(<ComputePanel onNavigate={vi.fn()} />))

    const removeButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'Remove biowulf'
    )
    await act(async () => {
      removeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const confirm = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')
    ).find((button) => button.textContent?.trim() === 'Remove Host')
    await act(async () => confirm?.click())

    expect(deleteHost).toHaveBeenCalledWith('ssh:biowulf')
    expect(container.textContent).toContain('Removed biowulf.')

    // The toast outlives the event that produced it, so it must follow a later language switch.
    switchTo('zh-Hans')
    expect(container.textContent).toContain('已移除 biowulf。')
    expect(container.textContent).not.toContain('Removed biowulf.')

    switchTo('zh-Hant')
    expect(container.textContent).toContain('已移除 biowulf。')
  })

  it('translates the relative probe time on a host card', () => {
    const probedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    useComputeStore.setState({
      hosts: [
        host({
          probeResult: { ok: true, probedAt, exitCode: 0, errorTail: null, cpus: 8, memMib: 16384 }
        })
      ],
      isLoaded: true
    })
    act(() => root.render(<ComputePanel onNavigate={vi.fn()} />))

    expect(container.textContent).toContain('probed 3 h ago')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('3 小时前探测')

    switchTo('zh-Hant')
    expect(container.textContent).toContain('3 小時前探測')
    expect(container.textContent).not.toContain('{{')
  })
})

describe('ComputeHostDetail i18n', () => {
  it('translates the section headings and the default concurrency value', async () => {
    useComputeStore.setState({ hosts: [host({ scratchRoot: '/my/scratch', scratchPinned: true })] })
    act(() => root.render(<ComputeHostDetail providerId="ssh:biowulf" />))
    await flush()

    expect(container.textContent).toContain('Scratch root')
    expect(container.textContent).toContain('PINNED')
    expect(container.textContent).toContain('Concurrent job limit')
    expect(container.textContent).toContain('10 (default)')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('临时目录')
    expect(container.textContent).toContain('已固定')
    expect(container.textContent).toContain('并发作业上限')
    expect(container.textContent).toContain(
      '此主机达到上限（1–500）后，新任务将等待。降低上限不会停止正在运行的任务。'
    )
    expect(container.textContent).toContain('10（默认）')
    expect(container.textContent).not.toContain('Concurrent job limit')

    switchTo('zh-Hant')
    expect(container.textContent).toContain('暫存目錄')
    expect(container.textContent).toContain('已釘選')
    expect(container.textContent).toContain('並行工作上限')
    expect(container.textContent).toContain(
      '此主機達到上限（1–500）後，新工作將等待。降低上限不會停止執行中的工作。'
    )
    expect(container.textContent).toContain('10（預設）')
    expect(container.textContent).not.toContain('{{')

    // Filesystem paths are protocol values, so they stay verbatim in every locale.
    expect(container.textContent).toContain('/my/scratch')
  })

  it('re-renders a stored validation error in the language active at render time', async () => {
    useComputeStore.setState({ hosts: [host()] })
    act(() => root.render(<ComputeHostDetail providerId="ssh:biowulf" />))
    await flush()

    // Three "Edit" buttons exist on this page; pick the one inside the concurrency block.
    const editButton = findButtonIn('Edit', 'Concurrent job limit')
    act(() => editButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    const input = container.querySelector<HTMLInputElement>('input[type="number"]')
    expect(input).not.toBeNull()
    setInputValue(input as HTMLInputElement, '0')

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save'
    )
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('Must be an integer between 1 and 500.')

    switchTo('zh-Hans')
    expect(container.textContent).toContain('必须是 1 到 500 之间的整数。')
    expect(container.textContent).not.toContain('Must be an integer between 1 and 500.')

    switchTo('zh-Hant')
    expect(container.textContent).toContain('必須是 1 到 500 之間的整數。')
    expect(container.textContent).not.toContain('{{')
  })
})

describe('ComputeApprovalDialog i18n', () => {
  it('translates the prompt while passing agent-supplied text through verbatim', () => {
    useComputeStore.setState({ pendingApprovals: [approvalRequest] })
    act(() => root.render(<ComputeApprovalDialog />))

    expect(document.body.textContent).toContain('Allow remote command?')
    expect(findBodyButton('Deny')).toBeDefined()
    expect(findBodyButton('This session')).toBeDefined()

    switchTo('zh-Hans')
    expect(document.body.textContent).toContain('允许执行远程命令？')
    expect(document.body.textContent).not.toContain('Allow remote command?')
    expect(findBodyButton('拒绝')).toBeDefined()
    expect(findBodyButton('此会话')).toBeDefined()

    switchTo('zh-Hant')
    expect(document.body.textContent).toContain('允許執行遠端指令？')
    expect(findBodyButton('拒絕')).toBeDefined()
    expect(findBodyButton('此工作階段')).toBeDefined()
    expect(document.body.textContent).not.toContain('{{')

    // provider_name, intent and the command preview come from the agent, not the catalog.
    expect(document.body.textContent).toContain('Research cluster')
    expect(document.body.textContent).toContain('Inspect the remote environment')
    expect(document.body.textContent).toContain('python ...')
  })
})
