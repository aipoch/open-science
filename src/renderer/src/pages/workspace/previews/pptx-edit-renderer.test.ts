// @vitest-environment jsdom
import { PptxViewer } from '@aiden0z/pptx-renderer'
import { describe, expect, it } from 'vitest'

import { applyOperations } from '../../../../../shared/pptx-edit'
import { EVERY_OPERATION } from '../../../../../shared/pptx-edit/every-operation.test-support'
import { createDeckFixture } from '../../../../../shared/pptx-edit/pptx-fixture.test-support'

describe('edited presentations load in the pinned renderer', () => {
  it('opens a deck produced by every operation kind', async () => {
    const { bytes, slideCount } = applyOperations(createDeckFixture(), EVERY_OPERATION)
    const viewer = new PptxViewer(document.createElement('div'), { pdfjs: false, lazySlides: true })
    try {
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      await viewer.open(buffer as ArrayBuffer, { renderMode: 'slide', lazySlides: true })
      expect(viewer.slideCount).toBe(slideCount)
    } finally {
      viewer.destroy()
    }
  })
})
