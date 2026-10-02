// @vitest-environment jsdom
import { act, type PropsWithChildren } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotebookRunRecord } from '../../../../shared/notebook'
import type { GrantedLocalRoot } from '../../../../shared/local-fs'
import {
  createInitialGrantedFoldersState,
  useGrantedFoldersStore
} from '@/stores/granted-folders-store'
import { NotebookRunOutputs } from './NotebookRunOutputs'
import { WorkspaceToolDetailsRow } from './WorkspaceToolDetailsRow'
import { NotebookFolderAccessNotice } from './NotebookFolderAccessNotice'
import { ViolationLog } from '../../../../../packages/notebook-network-sandbox/runtime/src/gateway/violation-log'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: PropsWithChildren) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
  DropdownMenuContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: PropsWithChildren<{ onSelect?: () => void }>) => (
    <button onClick={onSelect}>{children}</button>
  )
}))

const path = '/fixture/config/settings.json'
const folder = '/fixture/config'
const record: NotebookRunRecord = {
  runId: 'fixture-run',
  cellId: 'fixture-cell',
  kernelKind: 'bash',
  source: 'agent',
  status: 'completed',
  exitCode: 1,
  script: 'fixture-cli',
  startedAt: 0,
  outputs: [],
  workingFiles: [],
  text: {
    stdout: '{"error":"access failed"}',
    traceback: '',
    plain: [],
    stderr: `<sandbox_violations>\nOPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED: ${path} Filesystem access failed; native permissions, read-only mounts, or the sandbox may be responsible.\n</sandbox_violations>\n`
  }
}
let root: Root
let container: HTMLDivElement
let roots: GrantedLocalRoot[]
const listDir = vi.fn()
const grantRoot = vi.fn()
const execute = vi.fn()
const getStatus = vi.fn()
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
const click = async (selector: string): Promise<void> => {
  const button = document.body.querySelector<HTMLElement>(selector)
  expect(button, selector).not.toBeNull()
  await act(async () => button!.click())
}
const open = async (run = record): Promise<void> => {
  await act(async () => root.render(<NotebookFolderAccessNotice run={run} />))
  await flush()
  await click('[data-testid="notebook-folder-access-notice"] button')
  await flush()
}
beforeEach(() => {
  roots = []
  useGrantedFoldersStore.setState(createInitialGrantedFoldersState())
  listDir.mockReset().mockImplementation(async (candidate: string) => {
    if (candidate === path) throw new Error('ENOTDIR: not a directory')
    return { entries: [], resolvedPath: candidate, truncated: false }
  })
  grantRoot.mockReset().mockImplementation(async (request) => {
    roots = [{ id: 'fixture-root', name: 'config', ...request }]
    return roots
  })
  getStatus.mockReset().mockResolvedValue({ kind: 'ready', warnings: [] })
  execute.mockReset()
  window.api = {
    platform: 'linux',
    settings: { getNotebookNetworkStatus: getStatus },
    localFs: {
      getRoots: async () => ({ home: '/fixture/home', machineName: 'Fixture' }),
      listDrives: async () => [],
      listDir,
      listGrantedRoots: async () => roots,
      grantRoot
    },
    notebook: { executeShell: execute }
  } as unknown as typeof window.api
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('Notebook folder access recovery', () => {
  it.each([
    { platform: 'linux', file: '/fixture/My  Folder/settings.json', parent: '/fixture/My  Folder' },
    {
      platform: 'win32',
      file: String.raw`\\fixture-server\share\My Folder\settings.json`,
      parent: String.raw`\\fixture-server\share\My Folder`
    }
  ])(
    'preserves the exact $platform diagnostic path through dialog confirmation',
    async ({ platform, file, parent }) => {
      window.api.platform = platform
      listDir.mockImplementation(async (candidate: string) => {
        if (candidate === file) throw new Error('ENOTDIR: not a directory')
        return { entries: [], resolvedPath: candidate, truncated: false }
      })
      const stdout = JSON.stringify({ error: `EPERM: operation not permitted, open '${file}'` })
      const stderr = new ViolationLog().attach('fixture', '', undefined, stdout)
      await open({ ...record, text: { ...record.text, stderr, stdout } })
      expect(listDir).toHaveBeenCalledWith(file)
      expect(listDir).toHaveBeenCalledWith(parent)
      expect(grantRoot).not.toHaveBeenCalled()
      await click('[data-testid="grant-access-grant"]')
      await click('[data-testid="grant-folder-access-confirmation"] button:last-of-type')
      expect(grantRoot).toHaveBeenCalledExactlyOnceWith({ path: parent, access: 'ro' })
      expect(execute).not.toHaveBeenCalled()
    }
  )

  it('prefills the immediate file parent and requires both explicit confirmations', async () => {
    await open()
    expect(listDir).toHaveBeenCalledWith(path)
    expect(listDir).toHaveBeenCalledWith(folder)
    expect(document.body.textContent).toContain('applies across Sessions')
    expect(
      document.body.querySelector('[role="radio"][data-state="checked"]')?.getAttribute('value')
    ).toBe('ro')
    expect(grantRoot).not.toHaveBeenCalled()
    await click('[data-testid="grant-access-grant"]')
    expect(document.body.textContent).toContain('stop active Notebook kernels')
    expect(grantRoot).not.toHaveBeenCalled()
    await click('[data-testid="grant-folder-access-confirmation"] button:last-of-type')
    expect(grantRoot).toHaveBeenCalledExactlyOnceWith({ path: folder, access: 'ro' })
    expect(document.body.textContent).toContain('Run the command again when you are ready.')
    expect(execute).not.toHaveBeenCalled()
    expect(record.text.stdout).toBe('{"error":"access failed"}')
  })

  it.each(['cancel', 'decline', 'escape'] as const)('does not grant on %s', async (action) => {
    await open()
    if (action === 'decline') {
      await click('[data-testid="grant-access-grant"]')
      await click('[data-testid="grant-folder-access-confirmation"] button:first-of-type')
    } else if (action === 'cancel') await click('[data-testid="grant-access-cancel"]')
    else await act(async () => fireEvent.keyDown(document.body, { key: 'Escape' }))
    expect(grantRoot).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('grants read/write only after the user selects it', async () => {
    await open()
    await click('[role="radio"][value="rw"]')
    await click('[data-testid="grant-access-grant"]')
    await click('[data-testid="grant-folder-access-confirmation"] button:last-of-type')
    expect(grantRoot).toHaveBeenCalledExactlyOnceWith({ path: folder, access: 'rw' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('preserves an existing read/write grant on reopen', async () => {
    roots = [{ id: 'existing', path: folder, name: 'config', access: 'rw' }]
    await open()
    expect(
      document.body.querySelector('[role="radio"][data-state="checked"]')?.getAttribute('value')
    ).toBe('rw')
  })

  it.each(['ENOENT: no such file', 'EACCES: permission denied'])(
    'does not climb from unresolved paths: %s',
    async (message) => {
      listDir.mockRejectedValue(new Error(message))
      await open()
      expect(listDir).not.toHaveBeenCalledWith(folder)
      expect(
        document.body.querySelector<HTMLButtonElement>('[data-testid="grant-access-grant"]')
          ?.disabled
      ).toBe(true)
      expect(grantRoot).not.toHaveBeenCalled()
    }
  )

  it('accepts a directory without treating its dotted name as a file', async () => {
    listDir.mockResolvedValue({ entries: [], resolvedPath: path, truncated: false })
    await open()
    expect(listDir).not.toHaveBeenCalledWith(folder)
    await click('[data-testid="grant-access-grant"]')
    await click('[data-testid="grant-folder-access-confirmation"] button:last-of-type')
    expect(grantRoot).toHaveBeenCalledExactlyOnceWith({ path, access: 'ro' })
  })

  it.each(['/settings.json', '/fixture/home/settings.json'])(
    'does not prefill a broad parent for %s',
    async (candidate) => {
      listDir.mockRejectedValue(new Error('ENOTDIR: not a directory'))
      await open({
        ...record,
        text: { ...record.text, stderr: record.text.stderr.replace(path, candidate) }
      })
      expect(listDir.mock.calls.every(([requested]) => requested === candidate)).toBe(true)
      expect(
        document.body.querySelector<HTMLButtonElement>('[data-testid="grant-access-grant"]')
          ?.disabled
      ).toBe(true)
      expect(grantRoot).not.toHaveBeenCalled()
    }
  )

  it('does not enable a prefilled grant before existing rights can be loaded', async () => {
    window.api.localFs.listGrantedRoots = vi
      .fn()
      .mockRejectedValue(new Error('fixture lookup failed'))
    await open()
    expect(listDir).not.toHaveBeenCalled()
    expect(
      document.body.querySelector<HTMLButtonElement>('[data-testid="grant-access-grant"]')?.disabled
    ).toBe(true)
    expect(grantRoot).not.toHaveBeenCalled()
  })

  it('keeps a rejected grant in the dialog without reporting success or retrying', async () => {
    grantRoot.mockRejectedValue(new Error('cleanup incomplete'))
    await open()
    await click('[data-testid="grant-access-grant"]')
    await click('[data-testid="grant-folder-access-confirmation"] button:last-of-type')
    expect(document.body.querySelector('[data-testid="grant-access-error"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Folder access was updated.')
    expect(execute).not.toHaveBeenCalled()
  })

  it('ignores a pending initialization after cancellation', async () => {
    let finish!: (value: unknown) => void
    listDir.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    await open()
    await click('[data-testid="grant-access-cancel"]')
    await act(async () => finish({ entries: [], resolvedPath: folder, truncated: false }))
    expect(document.body.querySelector('[data-testid="grant-folder-access-dialog"]')).toBeNull()
    expect(grantRoot).not.toHaveBeenCalled()
  })

  it('offers no recovery while protection is unavailable', async () => {
    getStatus.mockResolvedValue({ kind: 'setupRequired', platform: 'win32', reasons: [] })
    await act(async () => root.render(<NotebookFolderAccessNotice run={record} />))
    expect(document.body.querySelector('[data-testid="notebook-folder-access-notice"]')).toBeNull()
  })

  it('requires a live owner opt-in for notebook panels and conversation rows', async () => {
    const activity = {
      id: 'activity',
      title: 'Shell',
      status: 'completed' as const,
      kind: 'tool' as const,
      eventIds: [],
      sortIndex: 0,
      createdAt: 0,
      updatedAt: 0
    }
    const details = { displayName: 'Shell', sections: [], notebookRunId: record.runId }
    for (const allowFolderAccess of [false, true]) {
      await act(async () =>
        root.render(
          <>
            <NotebookRunOutputs run={record} allowFolderAccess={allowFolderAccess} />
            <WorkspaceToolDetailsRow
              activity={activity}
              details={details}
              notebookRun={record}
              isExpanded
              onToggle={() => undefined}
              allowFolderAccess={allowFolderAccess}
            />
          </>
        )
      )
      expect(
        document.body.querySelectorAll('[data-testid="notebook-folder-access-notice"]')
      ).toHaveLength(allowFolderAccess ? 2 : 0)
    }
  })
})
