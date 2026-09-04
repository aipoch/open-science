import { describe, expect, it, vi } from 'vitest'
import type { TFunction } from 'i18next'

import type { Annotation, ImagePointAnnotation } from '../../../../../shared/annotations'
import {
  IMAGE_ANNOTATION_SOURCE_UNAVAILABLE_MESSAGE,
  localizeImageAnnotationSourceError,
  validateImageAnnotationSourcesBeforeSend
} from './image-annotation-source-validation'

const image = (
  kind: ImagePointAnnotation['source']['kind'],
  versionId: string
): ImagePointAnnotation => ({
  id: `point-${versionId}`,
  kind: 'image-point',
  target: 'agent',
  note: 'Inspect this point.',
  source: {
    kind,
    projectId: 'project-1',
    sessionId: 'session-1',
    versionId,
    name: kind === 'artifact-version' ? 'figure.png' : 'upload.avif',
    path:
      kind === 'artifact-version'
        ? `artifact-version:project-1/session-1/artifact-1/${versionId}`
        : `upload-version:project-1/session-1/upload-1/${versionId}`,
    mimeType: kind === 'artifact-version' ? 'image/png' : 'image/avif'
  },
  point: { x: 0.25, y: 0.75 },
  naturalSize: { width: 800, height: 600 }
})

const api = (): {
  acquire: ReturnType<typeof vi.fn<Window['api']['previewResources']['acquire']>>
  release: ReturnType<typeof vi.fn<Window['api']['previewResources']['release']>>
} => ({
  acquire: vi.fn<Window['api']['previewResources']['acquire']>(async (request) => ({
    id: `resource:${request.source}:${request.source === 'artifact' || request.source === 'upload' ? request.fileId : request.path}`,
    url: 'open-science-preview://resource',
    size: 1024,
    mimeType: 'image/png',
    version: 1
  })),
  release: vi.fn<Window['api']['previewResources']['release']>(async () => undefined)
})

describe('image annotation source preflight', () => {
  it('does not require the preview bridge when a send has no image annotations', async () => {
    await expect(validateImageAnnotationSourcesBeforeSend([])).resolves.toBeUndefined()
  })

  it('checks each fixed Artifact or Upload Version once and releases every capability', async () => {
    const resources = api()
    const artifact = image('artifact-version', 'artifact-v1')
    const annotations: Annotation[] = [
      artifact,
      { ...artifact, id: 'same-version-second-point' },
      image('upload-version', 'upload-v1'),
      {
        id: 'quote-1',
        kind: 'text',
        target: 'agent',
        quote: 'Text evidence',
        source: { kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }
      }
    ]

    await expect(
      validateImageAnnotationSourcesBeforeSend(annotations, resources)
    ).resolves.toBeUndefined()

    expect(resources.acquire).toHaveBeenCalledTimes(2)
    expect(resources.acquire).toHaveBeenNthCalledWith(1, {
      source: 'artifact',
      projectId: 'project-1',
      fileId: 'artifact-1',
      versionId: 'artifact-v1',
      mimeType: 'image/png'
    })
    expect(resources.acquire).toHaveBeenNthCalledWith(2, {
      source: 'upload',
      projectId: 'project-1',
      fileId: 'upload-1',
      versionId: 'upload-v1',
      mimeType: 'image/avif'
    })
    expect(resources.release).toHaveBeenCalledTimes(2)
  })

  it.each([
    Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }),
    new Error('Artifact file is outside artifact storage.'),
    new Error('Permission denied')
  ])(
    'fails with one stable user-facing error and does not substitute another Version',
    async (failure) => {
      const resources = api()
      resources.acquire.mockRejectedValue(failure)
      const annotation = image('artifact-version', 'deleted-version')

      await expect(
        validateImageAnnotationSourcesBeforeSend([annotation], resources)
      ).rejects.toThrow(IMAGE_ANNOTATION_SOURCE_UNAVAILABLE_MESSAGE)

      expect(resources.acquire).toHaveBeenCalledOnce()
      expect(resources.acquire).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: 'artifact-1', versionId: 'deleted-version' })
      )
      expect(resources.release).not.toHaveBeenCalled()
    }
  )

  it('localizes only the app-owned source failure identity', () => {
    const translate = vi.fn((key: string) => `translated:${key}`)
    const t = translate as unknown as TFunction
    expect(localizeImageAnnotationSourceError(IMAGE_ANNOTATION_SOURCE_UNAVAILABLE_MESSAGE, t)).toBe(
      `translated:${IMAGE_ANNOTATION_SOURCE_UNAVAILABLE_MESSAGE}`
    )
    expect(localizeImageAnnotationSourceError('provider failed', t)).toBeUndefined()
  })
})
