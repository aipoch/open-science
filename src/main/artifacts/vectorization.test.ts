import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vectorizeImage } from '@aipoch/image-vectorization'
import sharp from 'sharp'
import { expect, it, vi } from 'vitest'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import { writeArtifactFileForCurrentRun, writeArtifactFileInputSchema } from './mcp-server'
import { ArtifactRepository } from './repository'

it('changes the hollow outline and thin line independently while preserving the hole', async () => {
  const bytes = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="white"/><path d="M30 55H78V48L95 60L78 72V65H30Z" fill="white" stroke="black" stroke-width="2"/><path d="M125 60H175" stroke="black" stroke-width="2"/></svg>'
    )
  )
    .png()
    .toBuffer()
  const { content, mimeType } = await vectorizeImage(bytes)
  expect(mimeType).toBe('image/svg+xml')
  const svg = content.toString()
  expect(svg).toMatch(/id="line-\d+"/)
  const recolored = svg.replace(/(id="arrow-\d+"[^>]*?fill=")[^"]+"/, '$1#ff0000"')
  const rgb = await sharp(Buffer.from(recolored)).removeAlpha().raw().toBuffer()
  const pixel = (x: number, y: number): number[] => [
    ...rgb.subarray((y * 240 + x) * 3, (y * 240 + x) * 3 + 3)
  ]
  expect(pixel(50, 55)).toEqual([255, 0, 0])
  expect(pixel(50, 60)).toEqual([255, 255, 255])
  expect(pixel(150, 60)).toEqual([0, 0, 0])
  const protectedExport = await vectorizeImage(bytes, { preserveRegion: [20, 40, 105, 80] })
  expect(protectedExport.content.toString()).toContain('id="source-crop"')
  expect(protectedExport.content.toString()).not.toMatch(/id="arrow-\d+"/)
  expect(protectedExport.content.toString()).toMatch(/id="line-\d+"/)
})

it('exports through the Artifact tool using the authorized source and actual fallback format', async () => {
  const root = await mkdtemp(join(tmpdir(), 'image-export-'))
  const bytes = await sharp({
    create: { width: 20, height: 20, channels: 4, background: { r: 10, g: 30, b: 50, alpha: 0.5 } }
  })
    .png()
    .toBuffer()
  const binding = {
    projectId: 'project',
    appSessionId: 'session',
    artifactStorageSessionId: 'storage',
    artifactRunId: 'run',
    rootFrameId: 'root',
    agentFrameId: 'agent',
    messageBranchId: 'branch',
    runtimeSegmentId: 'segment',
    promptMessageId: 'prompt',
    sourceScope: { allowedImportRoots: [] }
  }
  const input = {
    sourceKind: 'upload-version' as const,
    sourceFileId: 'upload',
    inputFileVersionId: 'version',
    sourceProjectId: 'project',
    sourceSessionId: 'session',
    filename: 'source.png',
    contentType: 'image/png',
    sizeBytes: bytes.length,
    checksum: createHash('sha256').update(bytes).digest('hex'),
    storageKey: 'managed',
    association: 'turn-attached' as const
  }
  const lease = {
    path: 'managed',
    size: bytes.length,
    versionToken: 1,
    snapshot: { dev: 1n, ino: 1n, size: BigInt(bytes.length), mtimeNs: 1n },
    read: vi.fn(),
    copyTo: vi.fn(),
    readRange: async () => bytes,
    verifyUnchanged: vi.fn(),
    close: vi.fn()
  }
  const writeImageArtifact = vi.fn(
    async (_binding: unknown, output: { filename: string; content: Buffer; mimeType: string }) => ({
      id: 'result',
      versionId: 'result-version',
      artifactId: 'result',
      versionNumber: 1,
      sessionId: 'session',
      projectId: 'project',
      name: output.filename,
      path: 'managed',
      fileUrl: 'artifact://result',
      size: output.content.length,
      mtimeMs: 1,
      mimeType: output.mimeType
    })
  )
  const server = new NotebookLocalRpcServer({} as never, {
    transport: 'tcp',
    writeImageArtifact,
    vectorizeImage: (data, signal) => vectorizeImage(data, { signal }),
    inputRegistry: {
      registerTurn: vi.fn(),
      getTurnInputs: vi.fn(),
      clearSession: vi.fn(),
      openTurnContent: async (request) =>
        request.inputFileVersionId === input.inputFileVersionId ? { input, lease } : undefined
    }
  })
  try {
    const { endpoint } = await server.ensureStarted()
    const token = server.issueArtifactRunCapability(binding)
    const currentRunFile = join(root, 'current-run.json')
    await writeFile(currentRunFile, JSON.stringify({ ...binding, rpcCapabilityToken: token }))
    const environment = {
      storageRoot: root,
      sessionId: 'storage',
      projectId: 'project',
      currentRunFile,
      allowedImportRoots: [],
      rpcEndpoint: endpoint
    }
    const source = {
      kind: 'vectorizedImage' as const,
      projectId: 'project',
      sourceKind: input.sourceKind,
      sourceFileId: 'upload',
      inputFileVersionId: 'version'
    }
    const save = (version: string): ReturnType<typeof writeArtifactFileForCurrentRun> =>
      writeArtifactFileForCurrentRun(
        new ArtifactRepository(root),
        environment,
        writeArtifactFileInputSchema.parse({
          filename: 'converted.svg',
          source: { ...source, inputFileVersionId: version }
        })
      )
    await expect(save('unavailable')).rejects.toThrow(/not available in this turn/)
    expect(writeImageArtifact).not.toHaveBeenCalled()
    await expect(save('version')).resolves.toMatchObject({
      name: 'converted.png',
      imageExport: { mode: 'original', reason: expect.stringContaining('transparency') }
    })
    expect(writeImageArtifact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        mimeType: 'image/png',
        content: bytes,
        producer: expect.objectContaining({ inputFiles: [input] })
      })
    )
    expect(lease.verifyUnchanged).toHaveBeenCalledOnce()
    expect(lease.close).toHaveBeenCalledOnce()
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})
