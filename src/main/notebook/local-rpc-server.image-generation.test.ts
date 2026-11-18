import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { ImageModelService } from '../image-model/service'
import { ImageResultStore } from '../image-model/result-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageModelError, type ImageModelRequest } from '../image-model/contract'
import type { ArtifactVersionCoreProvenance } from '../../shared/artifact-provenance'
import { NotebookLocalRpcServer } from './local-rpc-server'
import { validateArtifactContentType } from '../artifacts/content-type'

const binding = {
  projectId: 'project-a',
  appSessionId: 'session-a',
  artifactStorageSessionId: 'session-a',
  artifactRunId: 'run-a',
  rootFrameId: 'root-a',
  agentFrameId: 'agent-a',
  messageBranchId: 'branch-a',
  runtimeSegmentId: 'segment-a',
  promptMessageId: 'prompt-a',
  agentName: 'codex',
  allowedMethods: ['imageGenerate'] as const
}

const call = async (
  endpoint: string,
  token: string,
  params: Record<string, unknown>
): Promise<{ response: Response; payload: Record<string, unknown> }> => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'imageGenerate', params })
  })
  return { response, payload: (await response.json()) as Record<string, unknown> }
}

let server: NotebookLocalRpcServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('imageGenerate Artifact RPC', () => {
  it('rejects a renamed retry after restart and still recovers the original request', async () => {
    const png = await sharp({
      create: { width: 128, height: 128, channels: 3, background: 'white' }
    })
      .png()
      .toBuffer()
    const root = await mkdtemp(join(tmpdir(), 'image-rpc-replay-'))
    const provider = vi.fn(async () =>
      Response.json({ data: [{ b64_json: png.toString('base64') }] })
    )
    const writeImageArtifact = vi.fn(async (_binding: unknown, input: { filename: string }) => ({
      id: 'version',
      artifactId: 'artifact',
      versionId: 'version',
      versionNumber: 1,
      sessionId: binding.appSessionId,
      projectId: binding.projectId,
      name: input.filename,
      path: '/managed/original.png',
      fileUrl: 'artifact://version',
      size: png.length,
      mtimeMs: 1,
      mimeType: 'image/png'
    }))
    const start = async () => {
      const results = new ImageResultStore(
        () => root,
        async () => ({
          logicalFile: { sessionId: binding.appSessionId },
          version: { checksum: createHash('sha256').update(png).digest('hex') },
          size: png.length,
          readRange: async () => png,
          verifyUnchanged: async () => {},
          close: async () => {}
        })
      )
      const imageModel = new ImageModelService({
        results,
        fetch: provider,
        download: async () => png,
        recordUsage: async () => {},
        resolveTarget: async () => ({
          serviceId: 'local',
          adapter: 'openai-images',
          baseUrl: 'https://images.example/v1',
          apiKey: 'test-key',
          model: { id: 'image', wireModelId: 'image', presetId: 'openai-images/generic' }
        })
      })
      server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
        transport: 'tcp',
        imageModel,
        writeImageArtifact
      })
      const { endpoint } = await server.ensureStarted()
      const token = server.issueArtifactRunCapability(binding)
      return (filename: string) =>
        call(endpoint, token, {
          operation: 'generate',
          prompt: 'Draw a circle',
          idempotencyKey: 'retry',
          filename
        })
    }
    try {
      const initial = await start()
      const original = await initial('original.png')
      expect(original.response.status).toBe(200)
      await server?.close()
      const retry = await start()
      expect((await retry('renamed.png')).response.status).toBe(409)
      expect(writeImageArtifact).toHaveBeenCalledOnce()
      const replay = await retry('original.png')
      expect(replay.response.status).toBe(200)
      expect(replay.payload).toEqual(original.payload)
      expect(provider).toHaveBeenCalledOnce()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['image/png', undefined, 'generated-image.png'],
    ['image/jpeg', 'diagram.png', 'diagram.jpg'],
    ['image/jpeg', 'diagram.JPEG', 'diagram.JPEG'],
    ['image/webp', 'diagram.jpg', 'diagram.webp']
  ] as const)(
    'publishes %s once with its actual file extension',
    async (mime, filename, expectedName) => {
      const execute = vi.fn(async (request: ImageModelRequest) => {
        const result = {
          bytes: Buffer.from(
            mime === 'image/jpeg'
              ? [0xff, 0xd8, 0xff]
              : mime === 'image/webp'
                ? [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')]
                : [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
          ),
          mime,
          width: 32,
          height: 24,
          serviceId: 'service-a',
          presetId: 'preset-a',
          model: 'model-a',
          parameters: { size: 'auto' },
          generatedImages: 1
        }
        await request.onResult?.(result)
        return result
      })
      const writeImageArtifact = vi.fn(
        async (
          _binding: unknown,
          input: { filename: string; mimeType?: string; content: Buffer }
        ) => {
          void _binding
          validateArtifactContentType({
            filename: input.filename,
            declaredContentType: input.mimeType,
            sample: input.content
          })
          return {
            id: 'artifact-version-a',
            artifactId: 'artifact-a',
            versionId: 'version-a',
            versionNumber: 1,
            sessionId: 'session-a',
            projectId: 'project-a',
            name: input.filename,
            path: '/managed/generated-image.png',
            fileUrl: 'artifact://version-a',
            size: 11,
            mtimeMs: 1,
            mimeType: mime
          }
        }
      )
      const capture = vi.fn(() => execute)
      server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
        transport: 'tcp',
        imageModel: { capture },
        writeImageArtifact,
        inputRegistry: {
          registerTurn: async () => [],
          getTurnInputs: () => [],
          clearSession: () => {}
        }
      })
      const connection = await server.ensureStarted()
      server.setArtifactTurnBinding(binding.appSessionId, {
        projectId: binding.projectId,
        ownerExecutionId: 'execution-a',
        artifactRunId: binding.artifactRunId,
        provenanceContext: binding
      })
      const token = server.issueArtifactRunCapability(binding)
      const params = {
        operation: 'generate',
        prompt: 'draw a circle',
        idempotencyKey: 'invocation-a',
        filename
      }
      const first = await call(connection.endpoint, token, params)
      const second = await call(connection.endpoint, token, params)

      expect(first.response.status).toBe(200)
      expect(second).toEqual(first)
      expect(execute).toHaveBeenCalledOnce()
      expect(writeImageArtifact).toHaveBeenCalledOnce()
      expect(writeImageArtifact.mock.calls[0]?.[1]).toMatchObject({
        filename: expectedName,
        mimeType: mime,
        producer: {
          normalizedArguments: {
            prompt: params.prompt,
            imageServiceId: 'service-a',
            generatedImages: 1,
            parameters: { size: 'auto' }
          }
        }
      })
      expect(first.payload.result).toMatchObject({
        source: {
          sourceKind: 'artifact-version',
          sourceFileId: 'artifact-a',
          inputFileVersionId: 'version-a'
        },
        artifactId: 'artifact-a',
        versionId: 'version-a',
        width: 32,
        height: 24
      })
      expect(JSON.stringify(first.payload)).not.toContain('image-bytes')
      const preview = {
        projectId: binding.projectId,
        sessionId: binding.appSessionId,
        artifactId: 'artifact-a',
        versionId: 'version-a'
      }
      const scope = server.captureImageGenerationPreviewScope(preview)
      expect(scope).toMatchObject({
        artifactRunId: 'run-a',
        messageBranchId: 'branch-a',
        promptMessageId: 'prompt-a'
      })
      expect(
        server.captureImageGenerationPreviewScope({ ...preview, sessionId: 'other-session' })
      ).toBeUndefined()
      expect(
        server.captureImageGenerationPreviewScope({ ...preview, projectId: 'other-project' })
      ).toBeUndefined()
      expect(
        server.captureImageGenerationPreviewScope({ ...preview, artifactId: 'other-file' })
      ).toBeUndefined()

      server.setArtifactTurnBinding(binding.appSessionId, {
        projectId: binding.projectId,
        ownerExecutionId: 'execution-b',
        artifactRunId: binding.artifactRunId,
        provenanceContext: { ...binding, messageBranchId: 'branch-b' }
      })
      expect(server.captureImageGenerationPreviewScope(preview)).toBeUndefined()
      expect(() => scope?.assertActive()).toThrow('no longer active')
      const nextExecute = vi.fn(execute.getMockImplementation()!)
      capture.mockReturnValue(nextExecute)
      await call(connection.endpoint, token, { ...params, idempotencyKey: 'invocation-b' })
      expect(capture).toHaveBeenCalledOnce()
      expect(execute).toHaveBeenCalledTimes(2)
      expect(nextExecute).not.toHaveBeenCalled()
      const nextToken = server.issueArtifactRunCapability({ ...binding, artifactRunId: 'run-b' })
      await call(connection.endpoint, nextToken, params)
      expect(capture).toHaveBeenCalledTimes(2)
      expect(nextExecute).toHaveBeenCalledOnce()
      server.issueArtifactRunCapability({ ...binding, allowedMethods: ['artifactSaveVersion'] })
      expect(capture).toHaveBeenCalledTimes(2)
    }
  )

  it('rejects a source Version from another Project before invoking the model', async () => {
    const execute = vi.fn()
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      imageModel: { capture: () => execute },
      writeImageArtifact: vi.fn(),
      inputRegistry: {
        registerTurn: async () => [],
        getTurnInputs: () => [],
        clearSession: () => {}
      }
    })
    const connection = await server.ensureStarted()
    const token = server.issueArtifactRunCapability(binding)
    const result = await call(connection.endpoint, token, {
      operation: 'edit',
      prompt: 'change the colors',
      idempotencyKey: 'invocation-b',
      source: {
        projectId: 'project-b',
        sourceKind: 'artifact-version',
        sourceFileId: 'file-b',
        inputFileVersionId: 'version-b'
      }
    })
    expect(result.response.status).toBe(403)
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects an edit outside the trusted turn input scope before calling the provider', async () => {
    const execute = vi.fn()
    const inputRegistry = {
      registerTurn: async () => [],
      getTurnInputs: () => [],
      clearSession: () => {},
      openTurnContent: vi.fn(async function (this: unknown) {
        expect(this).toBe(inputRegistry)
        return undefined
      })
    }
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      imageModel: { capture: () => execute },
      writeImageArtifact: vi.fn(),
      inputRegistry
    })
    const { endpoint } = await server.ensureStarted()
    const token = server.issueArtifactRunCapability(binding)
    const result = await call(endpoint, token, {
      operation: 'edit',
      prompt: 'recolor',
      idempotencyKey: 'edit-forbidden',
      source: {
        projectId: binding.projectId,
        sourceKind: 'artifact-version',
        sourceFileId: 'other-file',
        inputFileVersionId: 'other-version'
      }
    })
    expect(result.response.status).toBe(403)
    expect(inputRegistry.openTurnContent).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          appSessionId: binding.appSessionId,
          artifactRunId: binding.artifactRunId,
          rootFrameId: binding.rootFrameId,
          agentFrameId: binding.agentFrameId,
          messageBranchId: binding.messageBranchId,
          runtimeSegmentId: binding.runtimeSegmentId,
          promptMessageId: binding.promptMessageId,
          assertActive: expect.any(Function)
        }
      })
    )
    expect(execute).not.toHaveBeenCalled()
  })

  it('preserves provider error codes and never resubmits an uncertain invocation', async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(new ImageModelError('OUTCOME_UNKNOWN', 'Provider response lost.'))
    const writeImageArtifact = vi.fn()
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      imageModel: { capture: () => execute },
      writeImageArtifact,
      inputRegistry: {
        registerTurn: async () => [],
        getTurnInputs: () => [],
        clearSession: () => {}
      }
    })
    const { endpoint } = await server.ensureStarted()
    const token = server.issueArtifactRunCapability(binding)
    const params = { operation: 'generate', prompt: 'a circle', idempotencyKey: 'uncertain' }
    const first = await call(endpoint, token, params)
    const repeated = await call(endpoint, token, params)
    expect(first.payload).toEqual({
      error: {
        code: 'OUTCOME_UNKNOWN',
        message: 'Provider response lost.',
        imageError: { code: 'OUTCOME_UNKNOWN' }
      }
    })
    expect(repeated.payload).toEqual(first.payload)
    expect(execute).toHaveBeenCalledOnce()
    expect(writeImageArtifact).not.toHaveBeenCalled()

    const conflict = await call(endpoint, token, { ...params, prompt: 'a square' })
    expect(conflict.response.status).toBe(409)
    const invalid = await call(endpoint, token, { ...params, prompt: '' })
    expect(invalid.response.status).toBe(400)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('rechecks an uncertain invocation for the exact local version without submitting again', async () => {
    const execute = vi.fn(async () => {
      throw new ImageModelError('OUTCOME_UNKNOWN', 'Publication was not acknowledged.')
    })
    const readImageArtifact = vi.fn<() => Promise<ArtifactVersionCoreProvenance | undefined>>()
    readImageArtifact.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      descriptor: {
        artifactId: 'file-a',
        versionId: 'version-a',
        versionNumber: 1,
        name: 'diagram.png',
        mimeType: 'image/png',
        size: 80
      },
      evidence: {
        connector_execution: {
          normalized_arguments: {
            model: 'model-a',
            presetId: 'preset-a',
            width: 128,
            height: 128
          }
        }
      }
    } as unknown as ArtifactVersionCoreProvenance)
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      imageModel: { capture: () => execute },
      readImageArtifact,
      writeImageArtifact: vi.fn()
    })
    const { endpoint } = await server.ensureStarted()
    server.setArtifactTurnBinding(binding.appSessionId, {
      projectId: binding.projectId,
      ownerExecutionId: 'execution-a',
      artifactRunId: binding.artifactRunId,
      provenanceContext: binding
    })
    const token = server.issueArtifactRunCapability(binding)
    const params = { operation: 'generate', prompt: 'draw a circle', idempotencyKey: 'recheck' }
    expect((await call(endpoint, token, params)).payload.error).toBeDefined()
    expect((await call(endpoint, token, { ...params, prompt: 'a square' })).response.status).toBe(
      409
    )
    expect((await call(endpoint, token, params)).payload.error).toBeDefined()
    expect((await call(endpoint, token, params)).payload.result).toMatchObject({
      artifactId: 'file-a',
      versionId: 'version-a',
      width: 128
    })
    expect((await call(endpoint, token, params)).payload.result).toMatchObject({
      versionId: 'version-a'
    })
    expect(readImageArtifact).toHaveBeenCalledTimes(2)
    expect(readImageArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactRunId: binding.artifactRunId,
        messageBranchId: binding.messageBranchId
      }),
      'run-a:recheck'
    )
    expect(execute).toHaveBeenCalledOnce()
  })

  it('retains captured publication authority while a turn drains', async () => {
    let active = true
    let resolveGeneration:
      | ((result: {
          bytes: Buffer
          mime: 'image/png'
          width: number
          height: number
          serviceId: string
          presetId: string
          model: string
          parameters: Record<string, never>
        }) => void)
      | undefined
    const execute = vi.fn(async (request: ImageModelRequest) => {
      const result = await new Promise<{
        bytes: Buffer
        mime: 'image/png'
        width: number
        height: number
        serviceId: string
        presetId: string
        model: string
        parameters: Record<string, never>
      }>((resolve) => {
        resolveGeneration = resolve
      })
      await request.onResult?.(result)
      return result
    })
    const writeImageArtifact = vi.fn(async () => ({
      id: 'version',
      artifactId: 'artifact',
      versionId: 'version',
      versionNumber: 1,
      sessionId: binding.appSessionId,
      projectId: binding.projectId,
      name: 'result.png',
      path: '/result.png',
      fileUrl: 'artifact://version',
      size: 11,
      mtimeMs: 1
    }))
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      imageModel: { capture: () => execute },
      writeImageArtifact,
      inputRegistry: {
        registerTurn: async () => [],
        getTurnInputs: () => [],
        clearSession: () => {}
      }
    })
    const connection = await server.ensureStarted()
    const token = server.issueArtifactRunCapability(binding, undefined, () => active)
    const request = call(connection.endpoint, token, {
      operation: 'generate',
      prompt: 'a pending image',
      idempotencyKey: 'invocation-c'
    })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    active = false
    const revocation = server.revokeArtifactRunCapability(token)
    resolveGeneration?.({
      bytes: Buffer.from('image-bytes'),
      mime: 'image/png',
      width: 8,
      height: 8,
      serviceId: 'service-a',
      presetId: 'preset-a',
      model: 'model-a',
      parameters: {}
    })
    await revocation
    const result = await request
    expect(result.response.status).toBe(200)
    expect(writeImageArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactRunId: binding.artifactRunId,
        messageBranchId: binding.messageBranchId
      }),
      expect.objectContaining({ content: Buffer.from('image-bytes') })
    )
    expect(writeImageArtifact).toHaveBeenCalledOnce()
  })
})
