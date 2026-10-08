// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore } from '@/stores/session-store'
import type { ProjectFileItem } from '../../../../shared/project-files'

import { mentionProjectFile } from './project-file-mention'
import { projectFileMentionTransfers } from './project-file-mention-transfer'
import { useProjectFileMentionAction } from './use-project-file-mention-action'
import { useProjectFileMentionDrag } from './use-project-file-mention-drag'
import { useProjectFileMentionDrop } from './use-project-file-mention-drop'

const originalApi = window.api

const file = (overrides: Partial<ProjectFileItem> = {}): ProjectFileItem => ({
  id: 'file-1',
  source: 'artifact',
  sourceFileId: 'artifact-1',
  sourceVersionId: 'version-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  name: 'report.md',
  path: '/workspace/report.md',
  size: 10,
  sortAtMs: 1,
  ...overrides
})

const createDataTransfer = (): {
  types: string[]
  setData: (type: string, value: string) => void
  getData: (type: string) => string
  dropEffect: string
  effectAllowed: string
} => {
  const data = new Map<string, string>()
  const dataTransfer = {
    types: [] as string[],
    dropEffect: 'none',
    effectAllowed: 'uninitialized',
    setData: (type: string, value: string) => {
      data.set(type, value)
      if (!dataTransfer.types.includes(type)) dataTransfer.types.push(type)
    },
    getData: (type: string) => data.get(type) ?? ''
  }
  return dataTransfer
}

const Source = ({ disabled }: { disabled?: boolean }): React.JSX.Element => {
  const drag = useProjectFileMentionDrag(file(), { disabled })
  return <div data-testid="source" {...drag} />
}

const Drop = ({
  receive,
  disabled
}: {
  receive: (transfer: { projectId: string; file: ProjectFileItem }) => boolean | Promise<boolean>
  disabled?: boolean
}): React.JSX.Element => {
  const drop = useProjectFileMentionDrop({ disabled, receive })
  return (
    <div data-testid="drop" {...drop.props}>
      {drop.over ? <span>over</span> : null}
      {drop.error ? <span>error</span> : null}
    </div>
  )
}

const composerAvailable = (): void => {
  useNavigationStore.setState({
    view: 'workspace',
    activeProjectId: 'project-1',
    artifactMentionAvailability: { projectId: 'project-1', canMention: true }
  })
  useSessionStore.setState({
    sessions: [
      {
        id: 'session-1',
        projectId: 'project-1',
        title: 'Session',
        cwd: '/workspace',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
        messages: []
      }
    ],
    selectedSessionId: 'session-1'
  })
}

beforeEach(() => {
  useNavigationStore.setState({
    view: 'workspace',
    activeProjectId: 'project-1',
    pendingArtifactMention: undefined,
    artifactMentionAvailability: undefined,
    explicitNavigationRevision: 0
  })
  useSessionStore.setState({ sessions: [], selectedSessionId: undefined })
})

afterEach(() => {
  cleanup()
  projectFileMentionTransfers.cancel()
  window.api = originalApi
  useNavigationStore.setState({
    view: 'home',
    activeProjectId: undefined,
    pendingArtifactMention: undefined,
    artifactMentionAvailability: undefined
  })
  useSessionStore.setState({ sessions: [], selectedSessionId: undefined })
})

describe('project file mention drag and drop', () => {
  it('copies the dragged file into the drop target', () => {
    const received: ProjectFileItem[] = []
    render(
      <>
        <Source />
        <Drop
          receive={({ file }) => {
            received.push(file)
            return true
          }}
        />
      </>
    )
    const dataTransfer = createDataTransfer()
    fireEvent.dragStart(screen.getByTestId('source'), { dataTransfer })
    expect(dataTransfer.types).toContain('application/x-open-science-file-mention')
    fireEvent.dragOver(screen.getByTestId('drop'), { dataTransfer })
    expect(screen.queryByText('over')).not.toBeNull()
    fireEvent.drop(screen.getByTestId('drop'), { dataTransfer })
    expect(received).toEqual([file()])
    // Mentioning never consumes the source card: the registry only drops the pending token.
    expect(screen.getByTestId('source')).not.toBeNull()
  })

  it('does not start or accept a drag from a disabled source', () => {
    const receive = vi.fn(() => true)
    render(
      <>
        <Source disabled />
        <Drop receive={receive} />
      </>
    )
    const source = screen.getByTestId('source')
    expect(source.getAttribute('draggable')).toBe('false')
    const dataTransfer = createDataTransfer()
    fireEvent.dragStart(source, { dataTransfer })
    expect(dataTransfer.types).toHaveLength(0)
    fireEvent.drop(screen.getByTestId('drop'), { dataTransfer })
    expect(receive).not.toHaveBeenCalled()
  })

  it('reports an error when the target rejects the transfer', async () => {
    render(
      <>
        <Source />
        <Drop receive={() => false} />
      </>
    )
    const dataTransfer = createDataTransfer()
    fireEvent.dragStart(screen.getByTestId('source'), { dataTransfer })
    fireEvent.dragOver(screen.getByTestId('drop'), { dataTransfer })
    fireEvent.drop(screen.getByTestId('drop'), { dataTransfer })
    expect(await screen.findByText('error')).not.toBeNull()
  })

  it('ignores drags while the drop target is disabled', () => {
    const receive = vi.fn(() => true)
    render(
      <>
        <Source />
        <Drop receive={receive} disabled />
      </>
    )
    const dataTransfer = createDataTransfer()
    fireEvent.dragStart(screen.getByTestId('source'), { dataTransfer })
    fireEvent.dragOver(screen.getByTestId('drop'), { dataTransfer })
    expect(screen.queryByText('over')).toBeNull()
    fireEvent.drop(screen.getByTestId('drop'), { dataTransfer })
    expect(receive).not.toHaveBeenCalled()
  })
})

describe.each(['existing', 'new'])('mentionProjectFile in a %s conversation', (conversation) => {
  beforeEach(() => {
    composerAvailable()
    if (conversation === 'new') useSessionStore.setState({ selectedSessionId: undefined })
  })
  const headVersion = {
    id: 'head-1',
    checksum: 'a'.repeat(64),
    createdAt: '2026-10-05T00:00:00.000Z',
    contentType: 'text/markdown',
    sizeBytes: 42
  }

  it('requests a mention with the resolved head version', async () => {
    const inspect = vi.fn(async () => ({
      ok: true as const,
      value: {
        headVersionId: 'head-1',
        versions: [headVersion],
        headVersion,
        sessionId: 'session-1',
        displayName: 'report.md'
      }
    }))
    window.api = { managedFileVersions: { inspect } } as unknown as Window['api']
    await expect(mentionProjectFile(file())).resolves.toBe('mentioned')
    expect(inspect).toHaveBeenCalledWith({
      source: 'artifact',
      projectId: 'project-1',
      fileId: 'artifact-1'
    })
    expect(useNavigationStore.getState().pendingArtifactMention).toMatchObject({
      projectId: 'project-1',
      sourceVersionId: 'head-1',
      checksum: 'a'.repeat(64),
      name: 'report.md',
      size: 42
    })
  })

  it('reports unavailable when inspection fails', async () => {
    window.api = {
      managedFileVersions: { inspect: vi.fn(async () => ({ ok: false })) }
    } as unknown as Window['api']
    await expect(mentionProjectFile(file())).resolves.toBe('unavailable')
    expect(useNavigationStore.getState().pendingArtifactMention).toBeUndefined()
  })

  it('reports an unresolved version when no head descriptor exists', async () => {
    window.api = {
      managedFileVersions: {
        inspect: vi.fn(async () => ({
          ok: true as const,
          value: {
            headVersionId: 'missing',
            versions: [],
            sessionId: 'session-1',
            displayName: 'report.md'
          }
        }))
      }
    } as unknown as Window['api']
    await expect(mentionProjectFile(file())).resolves.toBe('version-unresolved')
    expect(useNavigationStore.getState().pendingArtifactMention).toBeUndefined()
  })
  it.each(['session', 'project', 'navigation', 'capacity', 'editable'])(
    'rejects a mention when %s changes during inspection',
    async (change) => {
      let resolve!: (value: unknown) => void
      const inspect = vi.fn(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
      window.api = { managedFileVersions: { inspect } } as unknown as Window['api']
      const pending = mentionProjectFile(file())
      if (change === 'session') useSessionStore.setState({ selectedSessionId: 'session-2' })
      if (change === 'project') useNavigationStore.setState({ activeProjectId: 'project-2' })
      if (change === 'navigation') useNavigationStore.setState({ explicitNavigationRevision: 1 })
      if (change === 'capacity' || change === 'editable')
        useNavigationStore.setState({
          artifactMentionAvailability: { projectId: 'project-1', canMention: false }
        })
      resolve({
        ok: true,
        value: {
          headVersion,
          versions: [headVersion],
          sessionId: 'session-1',
          displayName: 'report.md'
        }
      })
      await expect(pending).resolves.toBe('unavailable')
      expect(useNavigationStore.getState().pendingArtifactMention).toBeUndefined()
    }
  )

  it('rejects a second pending mention before the composer consumes the first', async () => {
    window.api = {
      managedFileVersions: {
        inspect: vi.fn(async () => ({
          ok: true,
          value: {
            headVersion,
            versions: [headVersion],
            sessionId: 'session-1',
            displayName: 'report.md'
          }
        }))
      }
    } as unknown as Window['api']
    await expect(
      Promise.all([mentionProjectFile(file()), mentionProjectFile(file({ id: 'file-2' }))])
    ).resolves.toEqual(['mentioned', 'unavailable'])
    expect(useNavigationStore.getState().pendingArtifactMention?.id).toBe('file-1')
  })
})

describe('useProjectFileMentionAction', () => {
  const headVersion = {
    id: 'head-1',
    checksum: 'b'.repeat(64),
    createdAt: '2026-10-05T00:00:00.000Z',
    contentType: 'text/markdown',
    sizeBytes: 7
  }

  it('reports unavailable and skips inspection without a mentionable composer', async () => {
    const inspect = vi.fn()
    window.api = { managedFileVersions: { inspect } } as unknown as Window['api']
    const { result } = renderHook(() => useProjectFileMentionAction(file()))
    expect(result.current.available).toBe(false)
    let mentioned = true
    await act(async () => {
      mentioned = await result.current.mention()
    })
    expect(mentioned).toBe(false)
    expect(inspect).not.toHaveBeenCalled()
  })

  it.each(['session-1', undefined])(
    'mentions the file with selected session %s',
    async (selectedSessionId) => {
      composerAvailable()
      useSessionStore.setState({ selectedSessionId })
      const inspect = vi.fn(async () => ({
        ok: true as const,
        value: {
          headVersionId: 'head-1',
          versions: [headVersion],
          headVersion,
          sessionId: 'session-1',
          displayName: 'report.md'
        }
      }))
      window.api = { managedFileVersions: { inspect } } as unknown as Window['api']
      const { result } = renderHook(() => useProjectFileMentionAction(file()))
      expect(result.current.available).toBe(true)
      let mentioned = false
      await act(async () => {
        mentioned = await result.current.mention()
      })
      expect(mentioned).toBe(true)
      expect(inspect).toHaveBeenCalledOnce()
      expect(useNavigationStore.getState().pendingArtifactMention).toMatchObject({
        projectId: 'project-1',
        sourceVersionId: 'head-1'
      })
    }
  )

  it.each(['missing-session', 'other-project-session'])(
    'rejects an invalid selected session: %s',
    async (selectedSessionId) => {
      composerAvailable()
      const session = useSessionStore.getState().sessions[0]!
      useSessionStore.setState({
        selectedSessionId,
        sessions: [session, { ...session, id: 'other-project-session', projectId: 'project-2' }]
      })
      const inspect = vi.fn()
      window.api = { managedFileVersions: { inspect } } as unknown as Window['api']
      const { result } = renderHook(() => useProjectFileMentionAction(file()))
      expect(result.current.available).toBe(false)
      await expect(mentionProjectFile(file())).resolves.toBe('unavailable')
      expect(inspect).not.toHaveBeenCalled()
    }
  )

  it('updates availability when switching between new and invalid selected sessions', () => {
    composerAvailable()
    window.api = { managedFileVersions: { inspect: vi.fn() } } as unknown as Window['api']
    const { result } = renderHook(() => useProjectFileMentionAction(file()))
    expect(result.current.available).toBe(true)
    act(() => useSessionStore.setState({ selectedSessionId: undefined }))
    expect(result.current.available).toBe(true)
    act(() => useSessionStore.setState({ selectedSessionId: 'missing-session' }))
    expect(result.current.available).toBe(false)
    act(() => useSessionStore.setState({ selectedSessionId: undefined }))
    expect(result.current.available).toBe(true)
  })

  it('disables the action when the Web API has no version inspection capability', async () => {
    composerAvailable()
    window.api = {} as Window['api']
    const { result } = renderHook(() => useProjectFileMentionAction(file()))
    expect(result.current.available).toBe(false)
    await act(async () => {
      expect(await result.current.mention()).toBe(false)
    })
    expect(result.current.error).toBe(false)
  })

  it('reports inspection failures and clears the error on a successful retry', async () => {
    composerAvailable()
    const inspect = vi
      .fn()
      .mockRejectedValueOnce(new Error('inspection failed'))
      .mockResolvedValueOnce({
        ok: true,
        value: {
          headVersion,
          versions: [headVersion],
          sessionId: 'session-1',
          displayName: 'report.md'
        }
      })
    window.api = { managedFileVersions: { inspect } } as unknown as Window['api']
    const { result } = renderHook(() => useProjectFileMentionAction(file()))
    await act(async () => {
      expect(await result.current.mention()).toBe(false)
    })
    expect(result.current.error).toBe(true)
    expect(result.current.pending).toBe(false)
    await act(async () => {
      expect(await result.current.mention()).toBe(true)
    })
    expect(result.current.error).toBe(false)
  })

  it('starts only one inspection for repeated clicks before a rerender', async () => {
    composerAvailable()
    let resolve!: (value: unknown) => void
    const inspect = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    window.api = { managedFileVersions: { inspect } } as unknown as Window['api']
    const { result } = renderHook(() => useProjectFileMentionAction(file()))
    await act(async () => {
      const first = result.current.mention()
      expect(await result.current.mention()).toBe(false)
      resolve({
        ok: true,
        value: {
          headVersion,
          versions: [headVersion],
          sessionId: 'session-1',
          displayName: 'report.md'
        }
      })
      expect(await first).toBe(true)
    })
    expect(inspect).toHaveBeenCalledOnce()
  })
})
