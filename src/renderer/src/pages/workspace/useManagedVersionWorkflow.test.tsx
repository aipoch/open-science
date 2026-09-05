// @vitest-environment jsdom
import { act, useLayoutEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import type { ProjectFilesChangedEvent } from '../../../../shared/project-files'
import type {
  ManagedFileSource,
  ManagedFileVersionDiffResult,
  ManagedFileVersionInspectResult,
  ManagedFileVersionIpcResult
} from '../../../../shared/managed-file-versions'
import { useManagedVersionWorkflow, type ManagedVersionMode } from './useManagedVersionWorkflow'

type InspectResult = ManagedFileVersionIpcResult<ManagedFileVersionInspectResult>
let root: Root
let container: HTMLDivElement
let workflow: ReturnType<typeof useManagedVersionWorkflow>
let changedListeners: Set<(event: ProjectFilesChangedEvent) => void>
const inspect = vi.fn<(request: unknown) => Promise<InspectResult>>()

function Harness({ item }: { item: PreviewFileItem }): null {
  const [mode, setMode] = useState<ManagedVersionMode>('view')
  const current = useManagedVersionWorkflow({
    item,
    projectId: item.projectId,
    mode,
    setMode,
    t: i18next.t
  })
  useLayoutEffect(() => {
    workflow = current
  })
  return null
}

const render = async (item: PreviewFileItem): Promise<void> => {
  await act(async () => root.render(<Harness item={item} />))
}

const itemFor = (source: ManagedFileSource): PreviewFileItem => ({
  id: `${source}:file-1`,
  type: 'file',
  source,
  projectId: 'project-1',
  sessionId: 'session-1',
  managedFileId: 'file-1',
  title: 'report.md',
  name: 'report.md',
  format: 'markdown',
  path: 'versions/v1/report.md',
  size: 10,
  mtimeMs: 1,
  versionNumber: 1
})

function snapshot(
  source: ManagedFileSource,
  head: number,
  selected = head
): ManagedFileVersionInspectResult {
  const versions = Array.from({ length: head }, (_, index) => ({
    id: `v${index + 1}`,
    source,
    fileId: 'file-1',
    versionNumber: index + 1,
    displayName: 'report.md',
    originKind: 'user_edit' as const,
    basedOnVersionId: index === 0 ? null : `v${index}`,
    contentType: 'text/markdown',
    sizeBytes: 10 + index,
    checksum: `checksum-${index}`,
    createdAt: '2026-09-05T00:00:00.000Z'
  }))
  return {
    source,
    projectId: 'project-1',
    fileId: 'file-1',
    sessionId: 'session-1',
    displayName: 'report.md',
    headVersionId: `v${head}`,
    selectedVersionId: `v${selected}`,
    versions,
    selectedVersion: versions[selected - 1],
    headVersion: versions[head - 1],
    canEdit: true,
    canDiff: selected > 1,
    text: `text v${selected}`
  }
}

const changed = async (
  source: ManagedFileSource,
  kind: 'upsert' | 'delete' = 'upsert'
): Promise<void> => {
  await act(async () => {
    for (const listener of changedListeners) {
      listener({ projectId: 'project-1', sessionId: 'session-1', sources: [source], kind })
    }
  })
}

beforeEach(() => {
  inspect.mockReset()
  useProjectStore.setState(createInitialProjectState())
  useSessionStore.setState(createInitialSessionState())
  changedListeners = new Set()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('api', undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      managedFileVersions: { inspect },
      projectFiles: {
        onChanged: (listener: (event: ProjectFilesChangedEvent) => void) => {
          changedListeners.add(listener)
          return () => changedListeners.delete(listener)
        }
      }
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe.each(['upload', 'artifact'] as const)('%s version inspection freshness', (source) => {
  it('refreshes the head, editable text and download context when the same file metadata changes', async () => {
    inspect.mockResolvedValueOnce({ ok: true, value: snapshot(source, 1) })
    inspect.mockResolvedValue({ ok: true, value: snapshot(source, 2) })
    const item = itemFor(source)
    await render(item)
    expect(workflow.inspect?.headVersionId).toBe('v1')
    await render({ ...item, path: 'versions/v2/report.md', size: 11, mtimeMs: 2, versionNumber: 2 })

    expect.soft(inspect).toHaveBeenCalledTimes(2)
    expect.soft(workflow.inspect?.headVersionId).toBe('v2')
    expect.soft(workflow.controlsInspect?.text).toBe('text v2')
    expect.soft(workflow.downloadVersionContext?.latestVersionId).toBe('v2')
  })

  it('refreshes on a file notification while preserving an explicitly selected historical version', async () => {
    inspect.mockResolvedValueOnce({ ok: true, value: snapshot(source, 1) })
    inspect.mockResolvedValue({ ok: true, value: snapshot(source, 2, 1) })
    await render({ ...itemFor(source), selectedVersionId: 'v1' })
    await changed(source)

    expect.soft(workflow.inspect?.headVersionId).toBe('v2')
    expect.soft(workflow.inspect?.selectedVersionId).toBe('v1')
    expect.soft(workflow.downloadVersionContext?.latestVersionId).toBe('v2')
    expect.soft(inspect).toHaveBeenLastCalledWith(expect.objectContaining({ versionId: 'v1' }))
  })

  it('withdraws stale write capability when the source is deleted', async () => {
    inspect.mockResolvedValueOnce({ ok: true, value: snapshot(source, 1) })
    inspect.mockResolvedValue({
      ok: true,
      value: { ...snapshot(source, 1), canEdit: false, unavailableReason: 'FILE_DELETED' }
    })
    await render(itemFor(source))
    expect(workflow.controlsInspect?.canEdit).toBe(true)
    await changed(source, 'delete')

    expect(workflow.controlsInspect?.canEdit).not.toBe(true)
  })

  it('keeps confirmed navigation but withholds stale editable text while metadata reinspection is pending', async () => {
    inspect.mockResolvedValueOnce({ ok: true, value: snapshot(source, 1) })
    inspect.mockReturnValue(new Promise(() => undefined))
    const item = itemFor(source)
    await render(item)
    await render({ ...item, mtimeMs: 2 })

    expect(workflow.navigationInspect?.headVersionId).toBe('v1')
    expect(workflow.inspect).toBeUndefined()
    expect(workflow.controlsInspect).toBeUndefined()
  })

  it('does not accept an old in-flight inspection after a newer file notification', async () => {
    let resolveOld!: (result: InspectResult) => void
    inspect.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve
      })
    )
    inspect.mockResolvedValue({ ok: true, value: snapshot(source, 2) })
    await render(itemFor(source))
    await changed(source)
    await act(async () => resolveOld({ ok: true, value: snapshot(source, 1) }))

    expect(workflow.inspect?.headVersionId).toBe('v2')
  })

  it('refreshes write capability when origin lifecycle metadata changes', async () => {
    inspect.mockResolvedValueOnce({ ok: true, value: snapshot(source, 1) })
    inspect.mockResolvedValue({
      ok: true,
      value: { ...snapshot(source, 1), canEdit: false, unavailableReason: 'FILE_DELETED' }
    })
    const item = itemFor(source)
    await render({ ...item, originSession: { state: 'active' } })
    await render({ ...item, originSession: { state: 'deleted' } })

    expect(workflow.controlsInspect?.canEdit).not.toBe(true)
  })

  it('refreshes write capability when the project is archived with the hook still mounted', async () => {
    const project = {
      id: 'project-1',
      name: 'Research',
      description: '',
      isExample: false,
      createdAt: 1,
      updatedAt: 1
    }
    useProjectStore.getState().upsertProject(project)
    inspect.mockResolvedValueOnce({ ok: true, value: snapshot(source, 1) })
    inspect.mockResolvedValue({
      ok: true,
      value: { ...snapshot(source, 1), canEdit: false, unavailableReason: 'PROJECT_NOT_WRITABLE' }
    })
    await render(itemFor(source))
    await act(async () => {
      useProjectStore.getState().upsertProject({ ...project, archivedAt: 2, updatedAt: 2 })
    })

    expect(workflow.controlsInspect?.canEdit).not.toBe(true)
  })

  it('already rejects an old response after explicit refresh (control)', async () => {
    let resolveOld!: (result: InspectResult) => void
    inspect.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve
      })
    )
    inspect.mockResolvedValue({ ok: true, value: snapshot(source, 2) })
    await render(itemFor(source))
    await act(async () => workflow.refreshInspect())
    await act(async () => resolveOld({ ok: true, value: snapshot(source, 1) }))

    expect(workflow.inspect?.headVersionId).toBe('v2')
  })
})

it('refreshes managed artifact inspection when the owning session filesRevision increases', async () => {
  const session = {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Research',
    cwd: '.',
    status: 'idle' as const,
    messages: [],
    filesRevision: 1,
    createdAt: 1,
    updatedAt: 1
  }
  useSessionStore.setState({ sessions: [session] })
  inspect.mockResolvedValueOnce({ ok: true, value: snapshot('artifact', 1) })
  inspect.mockResolvedValue({ ok: true, value: snapshot('artifact', 2) })
  await render(itemFor('artifact'))
  await act(async () => {
    useSessionStore.setState({ sessions: [{ ...session, filesRevision: 2, updatedAt: 2 }] })
  })

  expect(workflow.inspect?.headVersionId).toBe('v2')
})

it.each([{ path: 'versions/v2/report.md' }, { size: 11 }, { mtimeMs: 2 }, { versionNumber: 2 }])(
  'invalidates when only metadata %j changes',
  async (metadata) => {
    inspect.mockResolvedValueOnce({ ok: true, value: snapshot('upload', 1) })
    inspect.mockResolvedValue({ ok: true, value: snapshot('upload', 2) })
    const item = itemFor('upload')
    await render(item)
    await render({ ...item, ...metadata })
    expect(workflow.inspect?.headVersionId).toBe('v2')
  }
)

it('filters unrelated changes, handles project resets, and cleans up when the managed identity leaves', async () => {
  inspect.mockResolvedValue({ ok: true, value: snapshot('artifact', 1) })
  const item = itemFor('artifact')
  await render(item)
  expect(changedListeners.size).toBe(1)
  await act(async () => {
    for (const listener of changedListeners) {
      listener({ projectId: 'other', sources: ['artifact'], kind: 'reset' })
      listener({ projectId: 'project-1', sources: ['upload'], kind: 'upsert' })
      listener({
        projectId: 'project-1',
        sessionId: 'other',
        sources: ['artifact'],
        kind: 'upsert'
      })
    }
  })
  await render({ ...item })
  expect(inspect).toHaveBeenCalledTimes(1)
  await act(async () => {
    for (const listener of changedListeners) {
      listener({ projectId: 'project-1', sessionId: 'other', sources: [], kind: 'reset' })
    }
  })
  expect(inspect).toHaveBeenCalledTimes(2)
  await render({ ...item, managedFileId: undefined })
  expect(changedListeners.size).toBe(0)
  expect(workflow.inspect).toBeUndefined()
})

it('keeps inspection unconfirmed when a notification and an old response arrive before React commits', async () => {
  let resolveOld!: (value: InspectResult) => void
  let resolveLatest!: (value: InspectResult) => void
  inspect.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOld = resolve
    })
  )
  inspect.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveLatest = resolve
    })
  )
  await render(itemFor('upload'))
  await act(async () => {
    for (const listener of changedListeners) {
      listener({ projectId: 'project-1', sources: ['upload'], kind: 'upsert' })
    }
    resolveOld({ ok: true, value: snapshot('upload', 1) })
    await Promise.resolve()
  })
  expect(workflow.inspect).toBeUndefined()
  await act(async () => resolveLatest({ ok: true, value: snapshot('upload', 2) }))
  expect(workflow.inspect?.headVersionId).toBe('v2')
})

it('accepts only the last inspection when multiple file notifications race', async () => {
  inspect.mockResolvedValueOnce({ ok: true, value: snapshot('upload', 1) })
  let resolveSecond!: (value: InspectResult) => void
  let resolveThird!: (value: InspectResult) => void
  inspect.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveSecond = resolve
    })
  )
  inspect.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveThird = resolve
    })
  )
  await render(itemFor('upload'))
  await changed('upload')
  await changed('upload')
  await act(async () => resolveThird({ ok: true, value: snapshot('upload', 3) }))
  await act(async () => resolveSecond({ ok: true, value: snapshot('upload', 2) }))
  expect(workflow.inspect?.headVersionId).toBe('v3')
})

it.each(['error', 'reject'] as const)(
  'withholds edit authority after a refresh %s even without optional metadata',
  async (failure) => {
    inspect.mockResolvedValueOnce({ ok: true, value: snapshot('upload', 1) })
    await render({
      ...itemFor('upload'),
      size: undefined,
      mtimeMs: undefined,
      versionNumber: undefined
    })
    if (failure === 'error') {
      inspect.mockResolvedValue({ ok: false, error: { code: 'FILE_DELETED', message: 'deleted' } })
    } else {
      inspect.mockRejectedValue(new Error('unavailable'))
    }
    await changed('upload')
    expect(workflow.inspect).toBeUndefined()
    expect(workflow.controlsInspect).toBeUndefined()
    expect(workflow.navigationInspect?.selectedVersionId).toBe('v1')
  }
)

it.each(['error', 'reject'] as const)(
  'ignores an obsolete inspection %s arriving with a notification before React commits',
  async (failure) => {
    window.api.managedFileVersions.diffText = vi.fn().mockReturnValue(new Promise(() => undefined))
    window.api.managedFileVersions.cancelDiff = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { cancelled: true } })
    inspect.mockResolvedValueOnce({ ok: true, value: snapshot('upload', 2) })
    let resolveOld!: (value: InspectResult) => void
    let rejectOld!: (error: Error) => void
    inspect.mockReturnValueOnce(
      new Promise((resolve, reject) => {
        resolveOld = resolve
        rejectOld = reject
      })
    )
    inspect.mockReturnValue(new Promise(() => undefined))
    await render(itemFor('upload'))
    await act(async () => workflow.startDiff())
    await act(async () => workflow.refreshInspect())
    expect(workflow.controlsInspect?.headVersionId).toBe('v2')
    await act(async () => {
      for (const listener of changedListeners) {
        listener({ projectId: 'project-1', sources: ['upload'], kind: 'upsert' })
      }
      if (failure === 'error')
        resolveOld({ ok: false, error: { code: 'STORAGE_UNAVAILABLE', message: 'obsolete error' } })
      else rejectOld(new Error('obsolete error'))
      await Promise.resolve()
    })
    expect(workflow.inspect).toBeUndefined()
    // The pending refresh must retain Stop comparing; an obsolete failure must not leave diff mode.
    expect(workflow.controlsInspect?.headVersionId).toBe('v2')
  }
)

it.each(['notification', 'metadata'] as const)(
  'withholds the old diff until the refreshed head comparison completes after a %s',
  async (trigger) => {
    const oldDiff: ManagedFileVersionDiffResult = {
      baseVersionId: 'v1',
      selectedVersionId: 'v2',
      lines: []
    }
    const newDiff: ManagedFileVersionDiffResult = {
      baseVersionId: 'v2',
      selectedVersionId: 'v3',
      lines: []
    }
    let resolveInspect!: (value: InspectResult) => void
    let resolveDiff!: (value: ManagedFileVersionIpcResult<ManagedFileVersionDiffResult>) => void
    inspect.mockResolvedValueOnce({ ok: true, value: snapshot('upload', 2) })
    inspect.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInspect = resolve
      })
    )
    window.api.managedFileVersions.diffText = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: oldDiff })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveDiff = resolve
        })
      )
    window.api.managedFileVersions.cancelDiff = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { cancelled: true } })
    const item = itemFor('upload')
    await render(item)
    await act(async () => workflow.startDiff())
    expect(workflow.diffResult).toEqual(oldDiff)

    if (trigger === 'notification') await changed('upload')
    else await render({ ...item, mtimeMs: 3, versionNumber: 3 })
    expect.soft(workflow.diffResult).toBeUndefined()
    expect(workflow.navigationInspect?.headVersionId).toBe('v2')
    await act(async () => resolveInspect({ ok: true, value: snapshot('upload', 3) }))
    expect.soft(workflow.diffResult).toBeUndefined()
    expect(workflow.inspect?.headVersionId).toBe('v3')
    await act(async () => resolveDiff({ ok: true, value: newDiff }))
    expect(workflow.diffResult).toEqual(newDiff)
  }
)

it('withholds an old diff error while rechecking and comparing the current version', async () => {
  inspect.mockResolvedValue({ ok: true, value: snapshot('upload', 2) })
  window.api.managedFileVersions.diffText = vi
    .fn()
    .mockRejectedValueOnce(new Error('old comparison failed'))
    .mockReturnValue(new Promise(() => undefined))
  window.api.managedFileVersions.cancelDiff = vi
    .fn()
    .mockResolvedValue({ ok: true, value: { cancelled: true } })
  await render(itemFor('upload'))
  await act(async () => workflow.startDiff())
  expect(workflow.diffError).toBeDefined()
  await changed('upload')
  expect(workflow.diffError).toBeUndefined()
})

it.each(['success', 'error', 'reject'] as const)(
  'ignores an obsolete diff %s arriving with a file notification before React commits',
  async (outcome) => {
    inspect.mockResolvedValue({ ok: true, value: snapshot('upload', 2) })
    let resolveOld!: (value: ManagedFileVersionIpcResult<ManagedFileVersionDiffResult>) => void
    let rejectOld!: (error: Error) => void
    let resolveLatest!: (value: ManagedFileVersionIpcResult<ManagedFileVersionDiffResult>) => void
    window.api.managedFileVersions.diffText = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((resolve, reject) => {
          resolveOld = resolve
          rejectOld = reject
        })
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveLatest = resolve
        })
      )
    window.api.managedFileVersions.cancelDiff = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { cancelled: true } })
    await render(itemFor('upload'))
    await act(async () => workflow.startDiff())
    const oldRequest = vi.mocked(window.api.managedFileVersions.diffText).mock.calls[0][0]
    const result: ManagedFileVersionDiffResult = {
      baseVersionId: 'v1',
      selectedVersionId: 'v2',
      lines: []
    }
    await act(async () => {
      for (const listener of changedListeners) {
        listener({ projectId: 'project-1', sources: ['upload'], kind: 'upsert' })
      }
      if (outcome === 'success') resolveOld({ ok: true, value: result })
      else if (outcome === 'error')
        resolveOld({
          ok: false,
          error: { code: 'STORAGE_UNAVAILABLE', message: 'obsolete failure' }
        })
      else rejectOld(new Error('obsolete failure'))
      await Promise.resolve()
    })
    expect(workflow.diffResult).toBeUndefined()
    expect(workflow.diffError).toBeUndefined()
    expect(window.api.managedFileVersions.cancelDiff).toHaveBeenCalledWith({
      requestId: oldRequest.requestId
    })
    await act(async () => resolveLatest({ ok: true, value: result }))
    expect(workflow.diffResult).toEqual(result)
  }
)
