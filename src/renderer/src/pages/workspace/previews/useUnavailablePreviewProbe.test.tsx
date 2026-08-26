// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUnavailablePreviewProbe } from './useUnavailablePreviewProbe'

const Probe = ({ size, mtimeMs }: { size: number; mtimeMs: number }): React.JSX.Element => {
  const missing = useUnavailablePreviewProbe({
    enabled: true,
    projectId: 'project-1',
    sessionId: 'session-1',
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
})
