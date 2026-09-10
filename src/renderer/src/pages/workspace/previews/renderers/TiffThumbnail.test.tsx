// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TiffThumbnail } from './TiffThumbnail'
type Resource = Awaited<ReturnType<Window['api']['previewResources']['acquire']>>
let container: HTMLDivElement, root: Root
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})
afterEach(async () => {
  await act(async () => {
    root.unmount()
    await flush()
  })
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
it('bounds TIFF acquisition to two jobs and releases late results', async () => {
  const gates: Array<(value: Resource) => void> = []
  const acquire = vi.fn(() => new Promise<Resource>((resolve) => gates.push(resolve))),
    release = vi.fn().mockResolvedValue(undefined)
  window.api = { previewResources: { acquire, release } } as unknown as Window['api']
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  const tiles = (enabled: boolean): React.JSX.Element => (
    <>
      {Array.from({ length: 12 }, (_, i) => (
        <TiffThumbnail
          key={i}
          enabled={enabled}
          source="artifact"
          projectId="p"
          managedFileId={'f' + i}
          selectedVersionId={'v' + i}
          path={'/image' + i + '.tif'}
          name={'image' + i + '.tif'}
          fallback={<span>TIFF</span>}
        />
      ))}
    </>
  )
  await act(async () => {
    root.render(tiles(true))
    await flush()
  })
  expect(acquire).toHaveBeenCalledTimes(2)
  expect(gates).toHaveLength(2)
  expect(fetcher).not.toHaveBeenCalled()
  await act(async () => {
    root.render(tiles(false))
    await flush()
  })
  await act(async () => {
    gates.forEach((resolve, i) =>
      resolve({
        id: 'resource-' + i,
        url: 'https://unused/' + i,
        size: 8,
        mimeType: 'image/tiff',
        version: 1
      })
    )
    await flush()
  })
  expect(release).toHaveBeenCalledTimes(2)
  expect(fetcher).not.toHaveBeenCalled()
})
