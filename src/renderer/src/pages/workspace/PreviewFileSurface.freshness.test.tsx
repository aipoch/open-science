// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore,
  type PreviewFileItem
} from '@/stores/preview-workbench-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'
import type { ManagedFileVersionInspectResult } from '../../../../shared/managed-file-versions'
import type { ProjectFilesChangedEvent } from '../../../../shared/project-files'
import { PreviewFileSurface } from './PreviewFileSurface'

let root: Root
let container: HTMLDivElement
let notify: (event: ProjectFilesChangedEvent) => void
let head: number
const acquire = vi.fn<Window['api']['previewResources']['acquire']>()
const release = vi.fn<Window['api']['previewResources']['release']>()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  useSessionStore.setState(createInitialSessionState())
  head = 2
  let nextBlob = 0
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL(): string {
        return `blob:preview-${++nextBlob}`
      }
      static revokeObjectURL(): void {
        // Test URLs hold no browser-owned bytes.
      }
    }
  )
  acquire.mockReset().mockImplementation(async (request) => {
    const version =
      'versionId' in request && request.versionId ? Number(request.versionId.slice(1)) : head
    return {
      id: `resource-v${version}`,
      url: `open-science-preview://v${version}/report`,
      size: 7,
      mimeType: 'text/plain',
      version: 1
    }
  })
  release.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const version = String(input).includes('://v2/') ? 2 : 3
      return new Response(`body v${version}`)
    })
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      previewResources: { acquire, release },
      projectFiles: {
        onChanged: vi.fn((listener: typeof notify) => {
          notify = listener
          return vi.fn()
        })
      },
      artifacts: { getLineage: vi.fn().mockResolvedValue(undefined) },
      managedFileVersions: {
        inspect: vi.fn(async (request: { source: 'upload' | 'artifact'; versionId?: string }) => {
          const versions = [1, 2, 3].map((version) => ({
            id: `v${version}`,
            source: request.source,
            fileId: 'file-1',
            versionNumber: version,
            displayName: 'report.txt',
            originKind: 'user_edit' as const,
            basedOnVersionId: version === 1 ? null : `v${version - 1}`,
            contentType: 'text/plain',
            sizeBytes: 7,
            checksum: String(version),
            createdAt: '2026-09-05T00:00:00Z'
          }))
          const value: ManagedFileVersionInspectResult = {
            source: request.source,
            projectId: 'project-1',
            fileId: 'file-1',
            sessionId: 'session-1',
            displayName: 'report.txt',
            headVersionId: `v${head}`,
            selectedVersionId: request.versionId ?? `v${head}`,
            versions,
            canEdit: true,
            canDiff: true,
            text: `body v${head}`
          }
          return { ok: true, value }
        })
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

describe.each(['upload', 'artifact'] as const)('%s real preview resource freshness', (source) => {
  it.each(['text', 'html', 'image'] as const)(
    'refreshes default %s content after a head-only notification',
    async (format) => {
      const item: PreviewFileItem = {
        id: 'file-1',
        type: 'file',
        source,
        projectId: 'project-1',
        sessionId: 'session-1',
        managedFileId: 'file-1',
        path: 'report',
        title: 'report.txt',
        name: 'report.txt',
        format
      }
      usePreviewWorkbenchStore.getState().activateProject('project-1')
      usePreviewWorkbenchStore.getState().upsertAndActivateItem(item)
      await act(async () =>
        root.render(<PreviewFileSurface item={item} onClose={vi.fn()} workbenchConnected />)
      )
      if (format === 'text') expect(container.textContent).toContain('body v2')
      else if (format === 'html') expect(container.querySelector('iframe')?.src).toContain('://v2/')
      else expect(container.querySelector('img')?.src).toContain('blob:preview-')
      const previousImageUrl = container.querySelector('img')?.src
      acquire.mockClear()
      release.mockClear()
      head = 3
      await act(async () => notify({ projectId: 'project-1', sources: [source], kind: 'upsert' }))
      expect.soft(acquire).toHaveBeenLastCalledWith(expect.objectContaining({ versionId: 'v3' }))
      expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject(item)
      expect(
        (usePreviewWorkbenchStore.getState().items[0] as PreviewFileItem).selectedVersionId
      ).toBeUndefined()
      if (format !== 'image')
        expect.soft(release).toHaveBeenCalledWith({ resourceId: 'resource-v2' })
      if (format === 'text') expect(container.textContent).toContain('body v3')
      else if (format === 'html') expect(container.querySelector('iframe')?.src).toContain('://v3/')
      else expect(container.querySelector('img')?.src).not.toBe(previousImageUrl)
    }
  )

  it('keeps historical content and its lease while updating the head', async () => {
    const item: PreviewFileItem = {
      id: 'file-1',
      type: 'file',
      source,
      projectId: 'project-1',
      sessionId: 'session-1',
      managedFileId: 'file-1',
      path: 'report',
      title: 'report.txt',
      name: 'report.txt',
      format: 'text',
      selectedVersionId: 'v2'
    }
    await act(async () => root.render(<PreviewFileSurface item={item} onClose={vi.fn()} />))
    expect(container.textContent).toContain('body v2')
    acquire.mockClear()
    release.mockClear()
    head = 3
    await act(async () => notify({ projectId: 'project-1', sources: [source], kind: 'upsert' }))
    expect(container.textContent).toContain('body v2')
    expect(acquire).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })
})
