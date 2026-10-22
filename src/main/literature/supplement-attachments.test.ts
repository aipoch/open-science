import { describe, expect, it, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { readFile } from 'node:fs/promises'
import { LiteratureSupplementAttachments, extractSupplementFile } from './supplement-attachments'

const request = {
  itemId: 'paper',
  expectedMetadataRevision: 1,
  downloadId: 'd1b720c7-1000-4000-8000-000000000001'
}
const selected = {
  itemId: 'paper',
  revision: 1,
  doi: '10.1234/paper',
  provider: 'europe-pmc' as const,
  filename: 'data.docx',
  archiveEntry: 'data.docx',
  url: 'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1/supplementaryFiles',
  sourceUrl: 'https://europepmc.org/articles/PMC1',
  expires: Date.now() + 10000
}
const item = {
  id: 'paper',
  metadataRevision: 1,
  item: { identifiers: [{ scheme: 'doi', value: selected.doi }] }
}
const document = Buffer.from(zipSync({ '[Content_Types].xml': strToU8('<Types/>') }))
function setup(): {
  service: LiteratureSupplementAttachments
  get: ReturnType<typeof vi.fn>
  attachContent: ReturnType<typeof vi.fn>
  download: ReturnType<typeof vi.fn>
  getDownload: ReturnType<typeof vi.fn>
  publish: ReturnType<typeof vi.fn>
  pageCount: ReturnType<typeof vi.fn>
} {
  const get = vi.fn().mockResolvedValue(item)
  const attachContent = vi
    .fn()
    .mockResolvedValue({ attachmentId: 'attachment', versionId: 'version' })
  const download = vi
    .fn()
    .mockResolvedValue(
      Buffer.from(zipSync({ 'data.docx': document, 'figure.jpg': strToU8('unused') }))
    )
  const getDownload = vi.fn().mockReturnValue(selected)
  const publish = vi.fn(async ({ sourcePath, contentType }, commit) => {
    expect(contentType).toContain('wordprocessingml')
    expect(await readFile(sourcePath)).toEqual(document)
    return commit({ id: 'blob', sizeBytes: document.length, checksum: 'a'.repeat(64) })
  })
  const pageCount = vi.fn().mockResolvedValue(3)
  const service = new LiteratureSupplementAttachments({
    finder: { getDownload },
    catalog: { get, attachContent },
    content: { withPublishedContent: publish } as never,
    download,
    pageCount
  })
  return { service, get, attachContent, download, getDownload, publish, pageCount }
}

describe('supplement attachment admission', () => {
  it.each([
    ['.PDF', 'application/pdf'],
    ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
  ])('retains %s when truncating a long archived filename', async (suffix, contentType) => {
    const { service, getDownload, download, publish, attachContent, pageCount } = setup()
    const filename = 'x'.repeat(260) + suffix
    const bytes = suffix === '.PDF' ? Buffer.from('%PDF-1.7 test') : document
    getDownload.mockReturnValue({ ...selected, filename, archiveEntry: filename })
    download.mockResolvedValue(Buffer.from(zipSync({ [filename]: bytes })))
    publish.mockImplementation(async ({ sourcePath }, commit) => {
      expect(await readFile(sourcePath)).toEqual(bytes)
      return commit({ id: 'blob', sizeBytes: bytes.length, checksum: 'a'.repeat(64) })
    })
    await service.run(request, new AbortController().signal)
    expect(attachContent).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'x'.repeat(240 - suffix.length) + suffix,
        contentType,
        pageCount: suffix === '.PDF' ? 3 : undefined
      })
    )
    expect(pageCount).toHaveBeenCalledTimes(suffix === '.PDF' ? 1 : 0)
    download.mockResolvedValue(Buffer.from(zipSync({ [filename]: strToU8('not a document') })))
    await expect(service.run(request, new AbortController().signal)).rejects.toThrow(
      'Invalid supplementary'
    )
    expect(attachContent).toHaveBeenCalledTimes(1)
  })

  it('extracts only the selected DOCX and commits ordinary-file metadata and provenance', async () => {
    const { service, attachContent, download, getDownload } = setup()
    const signal = new AbortController().signal
    expect(await service.run(request, signal)).toEqual({
      attachmentId: 'attachment',
      versionId: 'version'
    })
    expect(getDownload).toHaveBeenCalledWith(request.downloadId, 'paper', 1)
    expect(download).toHaveBeenCalledWith(
      selected.url,
      50 * 1024 * 1024,
      expect.any(Function),
      undefined,
      signal,
      undefined,
      { accept: 'application/zip', timeoutMs: 180_000 }
    )
    expect(attachContent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'supplementary',
        filename: 'data.docx',
        pageCount: undefined,
        expectedMetadataRevision: 1,
        provenance: expect.objectContaining({
          provider: 'europe-pmc',
          sourceUrl: selected.sourceUrl
        })
      })
    )
  })
  it('coalesces repeated clicks while a file is downloading', async () => {
    const { service, download, attachContent } = setup()
    await Promise.all([
      service.run(request, new AbortController().signal),
      service.run(request, new AbortController().signal)
    ])
    expect(download).toHaveBeenCalledTimes(1)
    expect(attachContent).toHaveBeenCalledTimes(1)
  })
  it.each(['changed', 'deleted', 'doi'])(
    'does not publish when the reference is %s during download',
    async (reason) => {
      const { service, get, publish } = setup()
      get.mockResolvedValueOnce(item).mockResolvedValue({
        ...item,
        ...(reason === 'changed'
          ? { metadataRevision: 2 }
          : reason === 'deleted'
            ? { deletedAt: 1 }
            : { item: { identifiers: [{ scheme: 'doi', value: '10.1234/other' }] } })
      })
      await expect(service.run(request, new AbortController().signal)).rejects.toThrow(
        'reference changed'
      )
      expect(publish).not.toHaveBeenCalled()
    }
  )
  it('rejects expired candidates and renderer-supplied download URLs before I/O', async () => {
    const { service, getDownload, download } = setup()
    getDownload.mockImplementation(() => {
      throw new Error('expired')
    })
    await expect(service.run(request, new AbortController().signal)).rejects.toThrow('expired')
    expect(() =>
      service.run({ ...request, url: selected.url } as never, new AbortController().signal)
    ).toThrow()
    expect(download).not.toHaveBeenCalled()
  })
  it('honors cancellation before publication', async () => {
    const { service, download, publish } = setup()
    const controller = new AbortController()
    download.mockImplementation(async () => {
      controller.abort()
      return Buffer.from(zipSync({ 'data.docx': document }))
    })
    await expect(service.run(request, controller.signal)).rejects.toThrow()
    expect(publish).not.toHaveBeenCalled()
  })
  it('rejects missing, duplicate-basename and traversing archive members', () => {
    for (const files of [
      { 'other.docx': document },
      { 'a/data.docx': document, 'b/data.docx': document },
      { '../data.docx': document }
    ] as Record<string, Uint8Array>[])
      expect(() => extractSupplementFile(Buffer.from(zipSync(files)), 'data.docx')).toThrow()
  })
  it('rejects oversized archive entries before inflation', () => {
    const archive = Buffer.from(zipSync({ 'data.docx': document }))
    const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    archive.writeUInt32LE(51 * 1024 * 1024, central + 24)
    expect(() => extractSupplementFile(archive, 'data.docx')).toThrow(
      'Invalid supplementary archive entry'
    )
  })
  it('rejects HTML error pages disguised as documents', async () => {
    const { service, download, publish } = setup()
    download.mockResolvedValue(
      Buffer.from(zipSync({ 'data.docx': strToU8('<html>Unavailable</html>') }))
    )
    await expect(service.run(request, new AbortController().signal)).rejects.toThrow(
      'did not return'
    )
    expect(publish).not.toHaveBeenCalled()
  })
})

it('reports isolated live transfer metrics, saving phase and clears settled progress', async () => {
  const { service, download, publish } = setup()
  let finish!: (bytes: Buffer) => void
  download.mockImplementation((_url, _limit, report) => {
    report({ phase: 'downloading', receivedBytes: 50, totalBytes: 100, bytesPerSecond: 25 })
    return new Promise<Buffer>((resolve) => {
      finish = resolve
    })
  })
  const pending = service.run(request, new AbortController().signal)
  await vi.waitFor(() => expect(download).toHaveBeenCalled())
  expect(service.progress(request)).toMatchObject({
    receivedBytes: 50,
    totalBytes: 100,
    bytesPerSecond: 25
  })
  expect(service.progress({ ...request, itemId: 'other' })).toBeNull()
  expect(service.progress({ ...request, expectedMetadataRevision: 2 })).toBeNull()
  publish.mockImplementation(async (_source, commit) => {
    expect(service.progress(request)?.phase).toBe('saving')
    return commit({ id: 'blob', sizeBytes: document.length, checksum: 'a'.repeat(64) })
  })
  finish(Buffer.from(zipSync({ 'data.docx': document })))
  await pending
  expect(service.progress(request)).toBeNull()
})

it('clears transfer progress on failure and permits a clean retry', async () => {
  const { service, download } = setup()
  download.mockRejectedValueOnce(new Error('connection reset'))
  await expect(service.run(request, new AbortController().signal)).rejects.toThrow(
    'connection reset'
  )
  expect(service.progress(request)).toBeNull()
  await expect(service.run(request, new AbortController().signal)).resolves.toMatchObject({
    attachmentId: 'attachment'
  })
})
