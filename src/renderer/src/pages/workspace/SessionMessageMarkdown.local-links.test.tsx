// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getByRole } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotebookSessionReference } from '../../../../shared/notebook'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import type { MessageArtifact } from './session-message-artifact-reference'

vi.mock('./artifact-preview', () => ({ ArtifactPreview: () => null }))

const { SessionMessageMarkdown } = await import('./SessionMessageMarkdown')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const notebookReference: NotebookSessionReference = {
  projectId: 'project-1',
  sessionId: 'session-1',
  workspaceCwd: '/workspace',
  notebookSessionRoot: '/workspace/sessions/session-1',
  dataRoot: '/workspace/sessions/session-1/data',
  runtimeRoot: '/workspace/sessions/session-1/runtime',
  runJsonPath: '/workspace/sessions/session-1/run.json'
}

describe('SessionMessageMarkdown local file links', () => {
  let container: HTMLDivElement
  let root: Root
  let stageLocalPath: ReturnType<typeof vi.fn>
  let reveal: ReturnType<typeof vi.fn>

  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    useSettingsStore.setState({ ...createInitialSettingsState(), isLoaded: true })
    stageLocalPath = vi.fn()
    reveal = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('api', {
      platform: 'darwin',
      uploads: { stageLocalPath },
      localFs: { reveal }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const clickMessageLink = async (): Promise<void> => {
    const link = container.querySelector<HTMLElement>('[data-session-message-link]')
    expect(link).not.toBeNull()
    await act(async () => link?.click())
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
  }

  it.each([
    [
      '/Users/research/data',
      '/Users/research/data/测试%20报告.md',
      '/Users/research/data/测试 报告.md'
    ],
    [
      'C:\\Users\\research\\data',
      'C:\\Users\\research\\data\\测试%20报告.md',
      'C:\\Users\\research\\data\\测试 报告.md'
    ],
    [
      'C:\\Users\\research\\data',
      'C:/Users/research/data/测试%20报告.md',
      'C:/Users/research/data/测试 报告.md'
    ],
    [
      'C:\\Users\\research\\data',
      'file:///C:/Users/research/data/测试%20报告.md',
      'C:\\Users\\research\\data\\测试 报告.md'
    ],
    [
      'C:\\Users\\research\\data',
      'c:/users/RESEARCH/data/测试%2520报告.md',
      'c:/users/RESEARCH/data/测试%20报告.md'
    ],
    [
      'C:\\Users\\research\\data',
      'C:\\Users\\research\\data\\_report_(1).md',
      'C:\\Users\\research\\data\\_report_(1).md'
    ],
    [
      '\\\\server\\share\\data',
      '\\\\server\\share\\data\\测试%20报告.md',
      '\\\\server\\share\\data\\测试 报告.md'
    ],
    [
      '\\\\server\\share\\data',
      '//server/share/data/测试%20报告.md',
      '//server/share/data/测试 报告.md'
    ],
    [
      '\\\\server\\share\\data',
      'file://server/share/data/测试%20报告.md',
      '\\\\server\\share\\data\\测试 报告.md'
    ],
    [
      String.raw`C:\Users\research\data`,
      String.raw`C:\\Users\\research\\data\\report.md`,
      String.raw`C:\Users\research\data\report.md`
    ],
    [
      String.raw`\\server\share\data`,
      String.raw`\\\\server\\share\\data\\report.md`,
      String.raw`\\server\share\data\report.md`
    ]
  ])(
    'preserves cross-platform source identity through real Markdown: %s → %s',
    async (dataRoot, href, sourcePath) => {
      const name = sourcePath.split(/[\\/]/u).at(-1)!
      const notebook = { ...notebookReference, dataRoot }
      vi.stubGlobal('api', {
        platform: dataRoot.startsWith('/Users/') ? 'darwin' : 'win32',
        uploads: { stageLocalPath },
        localFs: { reveal }
      })

      const onPreviewArtifact = vi.fn()
      const artifact: MessageArtifact = {
        id: 'unrelated',
        artifactId: 'unrelated',
        kind: 'managed-file',
        path: `/managed/elsewhere/${name}`,
        name,
        mimeType: 'text/markdown',
        size: 1,
        mtimeMs: 1
      }
      await act(async () =>
        root.render(
          <SessionMessageMarkdown
            content={`[打开报告](<${href}> "Local report")`}
            artifacts={[artifact]}
            notebookReference={notebook}
            onPreviewArtifact={onPreviewArtifact}
            onPreviewArtifactModal={vi.fn()}
          />
        )
      )
      expect(container.querySelector('[data-session-data-file-link]')).not.toBeNull()
      expect(container.querySelector('[data-session-artifact-link]')).toBeNull()
      await clickMessageLink()
      expect(usePreviewWorkbenchStore.getState().items).toEqual([
        expect.objectContaining({ source: 'local', path: sourcePath })
      ])
      expect(stageLocalPath).not.toHaveBeenCalled()
      await act(async () => getByRole(container, 'button', { name: 'Show in folder' }).click())
      expect(reveal).toHaveBeenCalledExactlyOnceWith(sourcePath)
      expect(onPreviewArtifact).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['linux', '/home/user/Downloads/report.md'],
    ['darwin', '/Users/user/Downloads/report.md'],
    ['win32', String.raw`C:\Users\user\Downloads\report.md`]
  ])('opens external files in the default application on %s', async (platform, path) => {
    const openPath = vi.fn().mockResolvedValue('')
    vi.stubGlobal('api', { platform, localFs: { openPath, reveal } })
    await act(async () =>
      root.render(
        <SessionMessageMarkdown
          content={`[Report](<${path}>)`}
          artifacts={[]}
          notebookReference={notebookReference}
          onPreviewArtifact={vi.fn()}
          onPreviewArtifactModal={vi.fn()}
        />
      )
    )
    await clickMessageLink()
    expect(openPath).toHaveBeenCalledExactlyOnceWith(path)
    await act(async () => getByRole(container, 'button', { name: 'Show in folder' }).click())
    expect(reveal).toHaveBeenCalledExactlyOnceWith(path)
    expect(usePreviewWorkbenchStore.getState().items).toEqual([])
  })
})
