// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { MAX_COMPOSER_ATTACHMENTS, MAX_UPLOAD_FILE_BYTES } from '../../../../shared/uploads'
import { initI18n } from '@/i18n'
import {
  attachmentStagingGuidance,
  planComposerAttachmentIntake
} from './composer-attachment-intake'

const { t } = initI18n('en')

// Builds a File-like object with a controlled size without allocating large buffers.
const makeFile = (name: string, size: number): File => {
  const file = new File([], name)
  Object.defineProperty(file, 'size', { value: size })
  return file
}

describe('planComposerAttachmentIntake', () => {
  it('accepts files within the size limit and reports no error', () => {
    const small = makeFile('a.txt', 10)

    const result = planComposerAttachmentIntake([small], 0, t)

    expect(result.accepted).toEqual([small])
    expect(result.error).toBeNull()
  })

  it('skips oversized files while still accepting valid ones', () => {
    const valid = makeFile('ok.txt', 1024)
    const huge = makeFile('big.zip', MAX_UPLOAD_FILE_BYTES + 1)

    const result = planComposerAttachmentIntake([valid, huge], 0, t)

    expect(result.accepted).toEqual([valid])
    expect(result.error).toBe('Choose a smaller file. The per-file limit is 10 GB. (big.zip)')
  })

  it('combines multiple oversized file names in the error', () => {
    const first = makeFile('one.bin', MAX_UPLOAD_FILE_BYTES + 1)
    const second = makeFile('two.bin', MAX_UPLOAD_FILE_BYTES + 2)

    const result = planComposerAttachmentIntake([first, second], 0, t)

    expect(result.accepted).toEqual([])
    expect(result.error).toBe(
      'Choose a smaller file. The per-file limit is 10 GB. (one.bin, two.bin)'
    )
  })

  it('rejects the whole batch when it would exceed the attachment count', () => {
    const files = Array.from({ length: 3 }, (_, index) => makeFile(`f${index}.txt`, 10))

    const result = planComposerAttachmentIntake(files, MAX_COMPOSER_ATTACHMENTS - 2, t)

    expect(result.accepted).toEqual([])
    expect(result.error).toBe('You can attach up to 10 files.')
  })

  it('accepts a batch that exactly fills the remaining slots', () => {
    const files = Array.from({ length: 2 }, (_, index) => makeFile(`f${index}.txt`, 10))

    const result = planComposerAttachmentIntake(files, MAX_COMPOSER_ATTACHMENTS - 2, t)

    expect(result.accepted).toEqual(files)
    expect(result.error).toBeNull()
  })
})

describe('attachmentStagingGuidance', () => {
  it.each([
    [
      "Error invoking remote method 'uploads:stage-local-file': Error: Upload source changed while it was being staged: data.tsv",
      'The file changed. Wait for it to finish saving, then select it again.'
    ],
    [
      'Upload source changed before it could be staged: data.tsv',
      'The file changed. Wait for it to finish saving, then select it again.'
    ],
    ['Upload source is not a file: data', 'Select a file to attach.'],
    [
      'ApplicationCommandError: Upload exceeds the 1.5 GB per-file limit: ENOSPC.csv',
      'Choose a smaller file. The per-file limit is 1.5 GB.'
    ],
    [
      'ENOSPC: no space left on device, write',
      'Free up space on the device running Open Science, then try again.'
    ],
    [
      'DesktopRuntimeWriteNotSubmittedError: disconnected',
      'Reconnect to the local service, then try attaching the file again.'
    ],
    ['Failed to fetch', undefined],
    ['EACCES: open ENOSPC.csv', undefined]
  ])('maps the staging diagnostic %s', (detail, expected) => {
    expect(attachmentStagingGuidance(new Error(detail), detail, t)).toBe(expected)
  })
})
