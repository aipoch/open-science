import type { ArtifactWriteSource } from '../../shared/artifacts'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export const createPngBytes = (payload: string | readonly number[] | Buffer): Buffer =>
  Buffer.concat([
    PNG_SIGNATURE,
    Buffer.isBuffer(payload)
      ? payload
      : typeof payload === 'string'
        ? Buffer.from(payload)
        : Buffer.from(payload)
  ])

export const createPngInlineSource = (
  payload: string | readonly number[] | Buffer
): ArtifactWriteSource => ({
  kind: 'inline',
  content: createPngBytes(payload).toString('base64'),
  encoding: 'base64'
})
