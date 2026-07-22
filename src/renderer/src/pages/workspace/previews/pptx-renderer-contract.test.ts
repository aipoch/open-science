// @vitest-environment jsdom
import { PptxViewer } from '@aiden0z/pptx-renderer'
import { describe, expect, it } from 'vitest'

import { BoundedBlobUrlCache, installPptxMediaUrlCache } from './office-renderers'

describe('@aiden0z/pptx-renderer integration contract', () => {
  it('exposes the pinned media cache hook used by bounded windowing', () => {
    const container = document.createElement('div')
    const viewer = new PptxViewer(container, { pdfjs: false })
    const cache = new BoundedBlobUrlCache()

    expect(() => installPptxMediaUrlCache(viewer, cache)).not.toThrow()
    expect((viewer as unknown as { mediaUrlCache: Map<string, string> }).mediaUrlCache).toBe(cache)

    viewer.destroy()
  })
})
