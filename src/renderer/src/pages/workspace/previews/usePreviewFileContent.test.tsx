// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePreviewFileContent } from './usePreviewFileContent'

const Probe = (): React.JSX.Element => {
  const state = usePreviewFileContent({
    projectId: 'project-1',
    sessionId: 'active-session',
    source: 'upload',
    path: 'upload-version:project-1/source-session/upload-version-1'
  })

  return <div>{state.status}</div>
}

describe('usePreviewFileContent', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    window.api = {
      uploads: {
        readPreview: vi.fn().mockResolvedValue({
          content: 'group,count\nA,2',
          encoding: 'utf8',
          size: 15,
          truncated: false
        })
      }
    } as unknown as Window['api']
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    container.remove()
  })

  it('keeps project and session scope when reading a version-backed upload', async () => {
    root = createRoot(container)
    await act(async () => root.render(<Probe />))

    expect(window.api.uploads.readPreview).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'source-session',
      path: 'upload-version:project-1/source-session/upload-version-1',
      maxBytes: 1024 * 1024,
      encoding: 'utf8',
      offset: 0
    })
  })
})
