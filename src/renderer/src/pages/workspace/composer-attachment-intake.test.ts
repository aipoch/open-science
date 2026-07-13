// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { MAX_COMPOSER_ATTACHMENTS, MAX_UPLOAD_FILE_BYTES } from '../../../../shared/uploads'
import { planComposerAttachmentIntake } from './composer-attachment-intake'

// Builds a File-like object with a controlled size without allocating large buffers.
const makeFile = (name: string, size: number): File => {
  const file = new File([], name)
  Object.defineProperty(file, 'size', { value: size })
  return file
}

describe('planComposerAttachmentIntake', () => {
  it('accepts files within the size limit and reports no error', () => {
    const small = makeFile('a.txt', 10)

    const result = planComposerAttachmentIntake([small], 0)

    expect(result.accepted).toEqual([small])
    expect(result.error).toBeNull()
  })

  it('skips oversized files while still accepting valid ones', () => {
    const valid = makeFile('ok.txt', 1024)
    const huge = makeFile('big.zip', MAX_UPLOAD_FILE_BYTES + 1)

    const result = planComposerAttachmentIntake([valid, huge], 0)

    expect(result.accepted).toEqual([valid])
    expect(result.error).toBe('big.zip exceeds the 50 MB limit')
  })

  it('combines multiple oversized file names in the error', () => {
    const first = makeFile('one.bin', MAX_UPLOAD_FILE_BYTES + 1)
    const second = makeFile('two.bin', MAX_UPLOAD_FILE_BYTES + 2)

    const result = planComposerAttachmentIntake([first, second], 0)

    expect(result.accepted).toEqual([])
    expect(result.error).toBe('one.bin, two.bin exceeds the 50 MB limit')
  })

  it('rejects the whole batch when it would exceed the attachment count', () => {
    const files = Array.from({ length: 3 }, (_, index) => makeFile(`f${index}.txt`, 10))

    const result = planComposerAttachmentIntake(files, MAX_COMPOSER_ATTACHMENTS - 2)

    expect(result.accepted).toEqual([])
    expect(result.error).toBe('You can attach up to 10 files')
  })

  it('accepts a batch that exactly fills the remaining slots', () => {
    const files = Array.from({ length: 2 }, (_, index) => makeFile(`f${index}.txt`, 10))

    const result = planComposerAttachmentIntake(files, MAX_COMPOSER_ATTACHMENTS - 2)

    expect(result.accepted).toEqual(files)
    expect(result.error).toBeNull()
  })
})
