// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ArtifactFile } from '../../../../shared/artifacts'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'
import { useProjectArtifactFiles } from './use-project-artifact-files'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Minimal renderHook mirroring the repo's other hook tests (no @testing-library/react dependency).
const renderHook = <Value>(
  hook: () => Value
): { result: { current: Value }; rerender: () => void; unmount: () => void } => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const result = { current: undefined as unknown as Value }

  const HookHarness = (): null => {
    result.current = hook()
    return null
  }

  const render = (): void => {
    act(() => {
      root.render(createElement(HookHarness))
    })
  }

  render()

  return { result, rerender: render, unmount: () => root.unmount() }
}

const artifact = (projectId: string, name: string): ArtifactFile => ({
  id: `${projectId}:m:${name}`,
  projectName: projectId,
  sessionId: 's',
  name,
  path: `/artifacts/${projectId}/s/m/${name}`,
  fileUrl: `file:///artifacts/${projectId}/s/m/${name}`,
  size: 1,
  mtimeMs: 1
})

let originalApi: unknown

beforeEach(() => {
  useSessionStore.setState(createInitialSessionState())
  originalApi = (window as unknown as { api?: unknown }).api
})

afterEach(() => {
  ;(window as unknown as { api?: unknown }).api = originalApi
})

describe('useProjectArtifactFiles', () => {
  it('never returns the previous project files while the new project scan is in flight', async () => {
    let resolveProjectB: ((files: ArtifactFile[]) => void) | undefined
    const listProjectFiles = vi.fn((request: { projectName: string }) => {
      if (request.projectName === 'project-a') {
        return Promise.resolve([artifact('project-a', 'a.txt')])
      }
      // project-b's scan is held open so the test can observe the value while it is still pending.
      return new Promise<ArtifactFile[]>((resolve) => {
        resolveProjectB = resolve
      })
    })
    ;(window as unknown as { api: unknown }).api = { artifacts: { listProjectFiles } }

    let projectId = 'project-a'
    const { result, rerender } = renderHook(() => useProjectArtifactFiles(projectId))

    // Let project A's scan resolve.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.map((file) => file.name)).toEqual(['a.txt'])

    // Switch to project B before its scan resolves.
    projectId = 'project-b'
    rerender()
    await act(async () => {
      await Promise.resolve()
    })

    // Must not still show project A's file as project B's "Orphaned" artifact.
    expect(result.current).toEqual([])

    resolveProjectB?.([artifact('project-b', 'b.txt')])
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.map((file) => file.name)).toEqual(['b.txt'])
  })

  it('tolerates a missing or throwing bridge method without crashing', async () => {
    ;(window as unknown as { api: unknown }).api = { artifacts: {} }

    const { result } = renderHook(() => useProjectArtifactFiles('project-a'))

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current).toEqual([])
  })
})
