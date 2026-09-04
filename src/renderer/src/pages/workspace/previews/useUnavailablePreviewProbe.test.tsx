// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUnavailablePreviewProbe } from './useUnavailablePreviewProbe'

const Probe = ({
  size,
  mtimeMs,
  selectedVersionId = 'upload-version-1'
}: {
  size: number
  mtimeMs: number
  selectedVersionId?: string
}): React.JSX.Element => {
  const missing = useUnavailablePreviewProbe({
    enabled: true,
    projectId: 'project-1',
    sessionId: 'session-1',
    managedFileId: 'upload-file-1',
    selectedVersionId,
    source: 'upload',
    path: '/managed/upload.csv',
    size,
    mtimeMs
  })

  return <div data-missing={String(missing)} />
}

describe('useUnavailablePreviewProbe', () => {
  let container: HTMLDivElement
  let root: Root
  let readPreview: ReturnType<typeof vi.fn>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    readPreview = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
      .mockResolvedValue({
        content: 'YQ==',
        encoding: 'base64',
        size: 1,
        truncated: false
      })
    window.api = { uploads: { readPreview } } as unknown as Window['api']
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('re-probes the same path when its file version metadata changes', async () => {
    await act(async () => root.render(<Probe size={10} mtimeMs={100} />))
    expect(container.querySelector('div')?.dataset.missing).toBe('true')

    await act(async () => root.render(<Probe size={12} mtimeMs={200} />))

    expect(readPreview).toHaveBeenCalledTimes(2)
    expect(container.querySelector('div')?.dataset.missing).toBe('false')
  })

  it('re-probes when the selected immutable version changes without metadata drift', async () => {
    await act(async () =>
      root.render(<Probe size={10} mtimeMs={100} selectedVersionId="upload-version-1" />)
    )
    expect(container.querySelector('div')?.dataset.missing).toBe('true')

    await act(async () =>
      root.render(<Probe size={10} mtimeMs={100} selectedVersionId="upload-version-2" />)
    )

    expect(readPreview).toHaveBeenCalledTimes(2)
    expect(readPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        fileId: 'upload-file-1',
        versionId: 'upload-version-2'
      })
    )
    expect(container.querySelector('div')?.dataset.missing).toBe('false')
  })
})
