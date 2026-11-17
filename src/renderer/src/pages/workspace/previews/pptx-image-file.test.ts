// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { PPTX_EDIT_MAX_IMAGE_BASE64_CHARS } from '../../../../../shared/pptx-edit'
import { PPTX_IMAGE_MAX_BYTES, readPptxImageFile } from './pptx-image-file'

describe('readPptxImageFile', () => {
  it('encodes a supported image as base64', async () => {
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'a.jpg', { type: 'image/jpeg' })
    expect(await readPptxImageFile(file)).toEqual({
      kind: 'ready',
      mime: 'image/jpeg',
      dataBase64: '/9j/'
    })
  })

  it('rejects other types', async () => {
    const file = new File(['x'], 'a.webp', { type: 'image/webp' })
    expect(await readPptxImageFile(file)).toEqual({ kind: 'unsupported' })
  })

  it('rejects files whose encoding would exceed the operation limit', async () => {
    expect(Math.ceil(PPTX_IMAGE_MAX_BYTES / 3) * 4).toBeLessThanOrEqual(
      PPTX_EDIT_MAX_IMAGE_BASE64_CHARS
    )
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    Object.defineProperty(file, 'size', { value: PPTX_IMAGE_MAX_BYTES + 1 })
    expect(await readPptxImageFile(file)).toEqual({ kind: 'too-large' })
  })
})
