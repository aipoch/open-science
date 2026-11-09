import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HostViewImageService, type HostViewImageBackend } from './host-view-image-service'
import { NotebookLocalRpcServer } from './local-rpc-server'
import {
  buildNotebookToolContent,
  compactNotebookExecutionResult,
  type NotebookRpcConnection
} from './mcp-server'

const backend = (supportsImageInput: boolean): HostViewImageBackend => ({
  frameworkId: 'open-science-agent',
  backendId: 'open-science-agent:provider',
  modelRoute: 'open-science-agent',
  model: supportsImageInput ? 'visual' : 'text-only',
  supportsImageInput
})

const image = {
  data: Buffer.from('private image').toString('base64'),
  mimeType: 'image/png' as const,
  originalSize: { width: 20, height: 10 },
  outputSize: { width: 20, height: 10 }
}

const deferred = (): { promise: Promise<void>; resolve(): void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const call = (
  connection: NotebookRpcConnection,
  method: string,
  params = {},
  signal?: AbortSignal
): Promise<Response> =>
  fetch(connection.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
    signal
  })

let root: string | undefined
let server: NotebookLocalRpcServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

const workspace = async (): Promise<string> => {
  root = await mkdtemp(join(tmpdir(), 'view-image-rpc-'))
  await writeFile(join(root, 'plot.png'), 'image')
  return root
}

describe('host.viewImage caller and request ownership', () => {
  it.each([false, true])(
    'uses the child Attempt model when parent image support is %s',
    async (parentVisual) => {
      const cwd = await workspace()
      let writable = true
      const prepareVisionEvidence = vi.fn(async () => 'Image evidence from the child Vision relay')
      const hostViewImage = new HostViewImageService({
        catalog: { readHostArtifactCatalog: async () => [] },
        managedFileVersions: { openVersion: vi.fn() },
        captureBackend: (caller) =>
          caller.role === 'delegate'
            ? server!.captureDelegatedViewImageBackend(caller)
            : backend(parentVisual),
        captureVisionRelay: () => parentVisual,
        prepareVisionEvidence,
        prepareImage: async () => image
      })
      server = new NotebookLocalRpcServer({ shutdown: vi.fn() } as never, {
        transport: 'tcp',
        hostViewImage
      })
      const scope = {
        projectId: 'project-1',
        sessionId: 'session-1',
        rootFrameId: 'root-frame',
        agentFrameId: 'child-frame',
        attemptId: 'attempt-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'segment-1',
        promptMessageId: 'prompt-1',
        workspaceCwd: cwd,
        viewImageBackend: backend(!parentVisual),
        isAttemptWritable: () => writable
      }
      const child = await server.issueDelegatedNotebookConnection(scope)
      const control = await server.issueControlConnection(
        scope.sessionId,
        scope.projectId,
        scope.agentFrameId,
        { role: 'delegate', attemptId: scope.attemptId },
        cwd
      )
      control.beginControlInvocation({
        turnId: 'turn-1',
        controlInvocationGeneration: 1,
        toolInvocationId: 'run-1'
      })
      await expect(call(control, 'capabilitiesCall').then((r) => r.json())).resolves.toMatchObject({
        result: { viewImage: true }
      })
      await expect(
        call(control, 'viewImageCall', { source: { path: 'plot.png' } })
      ).resolves.toMatchObject({ status: 200 })
      const viewImages = await control.completeControlInvocation('run-1')
      expect(viewImages).toEqual(
        parentVisual
          ? [{ evidence: 'Image evidence from the child Vision relay' }]
          : [{ data: image.data, mimeType: image.mimeType }]
      )
      expect(prepareVisionEvidence).toHaveBeenCalledTimes(parentVisual ? 1 : 0)
      const content = buildNotebookToolContent(
        { status: 'completed', stdout: 'computed 42', viewImages },
        {
          includeViewImages: true,
          mapResult: compactNotebookExecutionResult
        }
      )
      expect(content[1].type).toBe(parentVisual ? 'text' : 'image')
      if (parentVisual) expect(JSON.stringify(content)).not.toContain(image.data)

      for (const patch of [
        { projectId: 'wrong-project' },
        { sessionId: 'wrong-session' },
        { agentFrameId: 'wrong-frame' },
        { attemptId: 'wrong-attempt' },
        { role: 'main' as const }
      ]) {
        await expect(
          server.captureDelegatedViewImageBackend({ ...scope, role: 'delegate', ...patch })
        ).resolves.toBeUndefined()
      }
      await expect(
        call(control, 'viewImageCall', {
          source: { path: 'plot.png' },
          attemptId: 'forged-attempt'
        })
      ).resolves.toMatchObject({ status: 400 })

      // A settled Attempt loses access even before explicit capability revocation.
      control.beginControlInvocation({
        turnId: 'turn-2',
        controlInvocationGeneration: 2,
        toolInvocationId: 'run-2'
      })
      await expect(
        call(control, 'viewImageCall', { source: { path: 'plot.png' } })
      ).resolves.toMatchObject({ status: 200 })
      writable = false
      await expect(control.completeControlInvocation('run-2')).resolves.toEqual([])
      await expect(call(control, 'capabilitiesCall').then((r) => r.json())).resolves.toMatchObject({
        result: { viewImage: false }
      })

      writable = true
      control.beginControlInvocation({
        turnId: 'turn-3',
        controlInvocationGeneration: 3,
        toolInvocationId: 'run-3'
      })
      await expect(
        call(control, 'viewImageCall', { source: { path: 'plot.png' } })
      ).resolves.toMatchObject({ status: 200 })
      const previousBackend = await server.captureDelegatedViewImageBackend({
        ...scope,
        role: 'delegate'
      })
      await child.revoke()
      const successor = await server.issueDelegatedNotebookConnection(scope)
      const nextBackend = await server.captureDelegatedViewImageBackend({
        ...scope,
        role: 'delegate'
      })
      expect(nextBackend?.generationToken).not.toBe(previousBackend?.generationToken)
      await expect(control.completeControlInvocation('run-3')).resolves.toEqual([])
      await successor.revoke()
      control.release()
    }
  )

  it.each([false, true])(
    'keeps completed output and the first image after a real second RPC disconnect (native: %s)',
    async (native) => {
      const cwd = await workspace()
      const preparingSecond = deferred()
      const secondSettled = deferred()
      let prepareCount = 0
      const hostViewImage = new HostViewImageService({
        catalog: { readHostArtifactCatalog: async () => [] },
        managedFileVersions: { openVersion: vi.fn() },
        captureBackend: () => backend(native),
        captureVisionRelay: () => true,
        prepareVisionEvidence: async ({ images }) => `Inspected ${images.length} image`,
        prepareImage: async (_path, _options, signal) => {
          if (++prepareCount === 2) {
            preparingSecond.resolve()
            await new Promise<void>((_resolve, reject) => {
              signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
            })
          }
          return image
        }
      })
      const stage = hostViewImage.stage.bind(hostViewImage)
      vi.spyOn(hostViewImage, 'stage').mockImplementation(async (...args) => {
        try {
          return await stage(...args)
        } finally {
          if (prepareCount === 2) secondSettled.resolve()
        }
      })
      server = new NotebookLocalRpcServer({} as never, { transport: 'tcp', hostViewImage })
      const control = await server.issueControlConnection(
        'session-1',
        'project-1',
        'root-frame',
        { role: 'main' },
        cwd
      )
      control.beginControlInvocation({
        turnId: 'turn-1',
        controlInvocationGeneration: 1,
        toolInvocationId: 'run-1'
      })
      await expect(
        call(control, 'viewImageCall', { source: { path: 'plot.png' } })
      ).resolves.toMatchObject({ status: 200 })
      const disconnect = new AbortController()
      const second = call(
        control,
        'viewImageCall',
        { source: { path: 'plot.png' } },
        disconnect.signal
      )
      const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' })
      await preparingSecond.promise
      disconnect.abort()
      await rejected
      await secondSettled.promise
      const viewImages = await control.completeControlInvocation('run-1')
      const content = buildNotebookToolContent(
        { status: 'completed', stdout: 'computed 42 after catching RPC failure', viewImages },
        {
          includeViewImages: true,
          mapResult: compactNotebookExecutionResult
        }
      )
      expect(content).toEqual([
        { type: 'text', text: expect.stringContaining('computed 42 after catching RPC failure') },
        native
          ? { type: 'image', data: image.data, mimeType: image.mimeType }
          : { type: 'text', text: 'Inspected 1 image' }
      ])
      control.release()
    }
  )
})
