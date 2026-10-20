import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { createRemoteReviewerResolver } from './paged-preview-host'
import { parseDesktopNativeResult, reviewerDesktopRenderSchema } from '../desktop-native-contract'
import type { DesktopNativeOperation } from '../desktop-native-contract'

const request = {
  artifactVersionId: 'version',
  path: resolve('private', 'report.docx'),
  filename: 'report.docx',
  format: 'docx' as const,
  pages: [2],
  includePreview: true,
  maxBytes: 1000,
  verifiedObservation: { device: 1, inode: 2, sizeBytes: 100, modifiedAtMs: 3, changedAtMs: 4 },
  verifiedChecksum: 'checked'
}
const resource = {
  id: 'resource',
  url: 'open-science-preview://resource/report.docx',
  size: 100,
  mimeType: 'application/octet-stream',
  version: 1
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function setup() {
  const resources = {
    acquireResolvedFile: vi.fn().mockResolvedValue(resource),
    release: vi.fn(),
    releaseOwner: vi.fn(),
    acquire: vi.fn(),
    inspect: vi.fn(),
    readRange: vi.fn()
  }
  const render = vi
    .fn()
    .mockResolvedValue({ pageCount: 2, pages: [{ pageNumber: 2, text: 'review text' }] })
  return { resources, render, resolver: createRemoteReviewerResolver(resources, render) }
}

describe('Node-owned Reviewer rendering resources', () => {
  it('keeps file observation and checksum verification in Node and forwards only a bounded capability', async () => {
    const { resolver, resources, render } = setup()
    await expect(resolver(request)).resolves.toMatchObject({
      pages: [{ pageNumber: 2, text: 'review text' }]
    })
    const ownerId = resources.acquireResolvedFile.mock.calls[0][0]
    expect(ownerId).toBeLessThan(0)
    expect(resources.acquireResolvedFile).toHaveBeenCalledWith(
      ownerId,
      {
        path: request.path,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        verifiedObservation: request.verifiedObservation,
        verifiedChecksum: request.verifiedChecksum
      },
      40 * 1024 * 1024
    )
    const operation = render.mock.calls[0][0]
    expect(operation.operation).toBe('reviewer-render')
    expect(reviewerDesktopRenderSchema.parse(operation.input)).toEqual(operation.input)
    expect(JSON.stringify(operation)).not.toContain('private')
    expect(operation.input).not.toHaveProperty('verifiedObservation')
    expect(resources.releaseOwner).toHaveBeenCalledWith(ownerId)
  })
  it('revokes the capability when a native operation fails or disconnects', async () => {
    const { resolver, resources, render } = setup()
    render.mockRejectedValueOnce(new Error('Desktop disconnected'))
    await expect(resolver(request)).rejects.toThrow('Desktop disconnected')
    expect(resources.releaseOwner).toHaveBeenCalledWith(
      resources.acquireResolvedFile.mock.calls[0][0]
    )
    await expect(resolver(request)).resolves.toMatchObject({ pageCount: 2 })
  })
  it('revokes late acquisition after cancellation without sending it to Electron', async () => {
    const { resolver, resources, render } = setup(),
      controller = new AbortController()
    let finish!: (value: unknown) => void
    resources.acquireResolvedFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = resolver({ ...request, signal: controller.signal })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    controller.abort()
    finish(resource)
    await expect(pending).rejects.toThrow()
    expect(render).not.toHaveBeenCalled()
    expect(resources.releaseOwner).toHaveBeenCalledTimes(2)
  })
  it('rejects extra pages, byte budget overflow and native filesystem fields', () => {
    const input = {
      artifactVersionId: 'version',
      format: 'docx' as const,
      pages: [2],
      includePreview: true,
      maxBytes: 2,
      resource
    }
    const operation: DesktopNativeOperation = { operation: 'reviewer-render', input }
    expect(() =>
      parseDesktopNativeResult(operation, { pageCount: 2, pages: [{ pageNumber: 1, text: '' }] })
    ).toThrow()
    expect(() =>
      parseDesktopNativeResult(operation, {
        pageCount: 2,
        pages: [{ pageNumber: 2, text: 'three' }]
      })
    ).toThrow()
    expect(() => reviewerDesktopRenderSchema.parse({ ...input, path: request.path })).toThrow()
    expect(() =>
      reviewerDesktopRenderSchema.parse({
        ...input,
        resource: { ...resource, url: 'file:///private/report.docx' }
      })
    ).toThrow()
    expect(
      parseDesktopNativeResult(operation, { pageCount: 2, pages: [{ pageNumber: 2, text: 'ok' }] })
    ).toEqual({ pageCount: 2, pages: [{ pageNumber: 2, text: 'ok' }] })
  })
})
