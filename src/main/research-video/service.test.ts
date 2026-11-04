import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createResearchVideoService, type ResearchVideoScope } from './service'
import type { LocalModelOwner } from '../local-models/owner'
import type { ArtifactVersionFile } from '../../shared/artifact-provenance'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(): Promise<{
  root: string
  scope: ResearchVideoScope
  specPath: string
  generate: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
  service: ReturnType<typeof createResearchVideoService>
}> {
  const root = await mkdtemp(join(tmpdir(), 'video-service-'))
  roots.push(root)
  const specPath = join(root, 'video.json')
  await writeFile(
    specPath,
    JSON.stringify({
      title: 'Question',
      session: 'session.json',
      scenes: [
        {
          id: 'question',
          msg: 0,
          lines: [{ caption: 'What does the evidence show?' }],
          panels: [{ type: 'title', text: 'Question' }]
        }
      ]
    })
  )
  await writeFile(join(root, 'session.json'), JSON.stringify({ messages: [{ md: 'Evidence' }] }))
  const scope: ResearchVideoScope = {
    projectId: 'project',
    appSessionId: 'session',
    artifactStorageSessionId: 'storage',
    artifactRunId: 'run',
    rootFrameId: 'root',
    agentFrameId: 'agent',
    messageBranchId: 'branch',
    runtimeSegmentId: 'segment',
    promptMessageId: 'prompt',
    sourceScope: { allowedImportRoots: [root], workspaceCwd: root }
  }
  const release = vi.fn()
  const models = {
    acquireUse: vi.fn(async () => ({
      revision: 'kokoro',
      assets: [{ file: 'model_quantized.onnx', path: join(root, 'model_quantized.onnx') }],
      release
    }))
  } as unknown as LocalModelOwner
  const generate = vi.fn(async (input) => {
    expect(JSON.parse(await readFile(input.specPath, 'utf8')).title).toBe('Question')
    await mkdir(input.outputDirectory)
    const playerPath = join(input.outputDirectory, 'player.html'),
      sourcePath = join(input.outputDirectory, 'sources.zip')
    await writeFile(playerPath, 'player')
    await writeFile(sourcePath, 'sources')
    return { playerPath, sourcePath, duration: 5, preparationMs: 1 }
  })
  const save = vi.fn(
    async (request) =>
      ({
        id: request.filename,
        artifactId: request.filename,
        versionId: request.writeOperationId,
        name: request.filename
      }) as ArtifactVersionFile
  )
  const service = createResearchVideoService({
    models,
    acquireWriter: () => release,
    dataRoot: () => root,
    engineDirectory: root,
    generate,
    save
  })
  return { root, scope, specPath, generate, save, release, service }
}
it('publishes frozen output through the existing writer and releases the lease', async () => {
  const f = await fixture()
  const result = await f.service.generate(
    { specPath: f.specPath, filename: 'result' },
    f.scope,
    new AbortController().signal
  )
  expect(result.duration).toBe(5)
  expect(f.save.mock.calls.map((c) => c[0].filename)).toEqual(['result-sources.zip', 'result.html'])
  expect(f.save.mock.calls[0][0].messageBranchId).toBe('branch')
  expect(f.release).toHaveBeenCalledOnce()
  expect(await readdir(join(f.root, 'research-video-jobs'))).toEqual([])
})
it('retains completed files and resumes partial publication without regenerating or duplicating the first output', async () => {
  const f = await fixture()
  f.save
    .mockImplementationOnce(async (r) => ({ versionId: r.writeOperationId }) as ArtifactVersionFile)
    .mockRejectedValueOnce(new Error('disk full'))
  await expect(
    f.service.generate(
      { specPath: f.specPath, filename: 'result' },
      f.scope,
      new AbortController().signal
    )
  ).rejects.toThrow('resumeJobId=')
  const [id] = await readdir(join(f.root, 'research-video-jobs'))
  await expect(
    f.service.generate(
      { specPath: f.specPath, filename: 'result', resumeJobId: id },
      { ...f.scope, messageBranchId: 'other' },
      new AbortController().signal
    )
  ).rejects.toThrow('does not match')
  await f.service.generate(
    { specPath: f.specPath, filename: 'result', resumeJobId: id },
    f.scope,
    new AbortController().signal
  )
  expect(f.generate).toHaveBeenCalledOnce()
  expect(f.save.mock.calls.filter((c) => c[0].filename === 'result-sources.zip')).toHaveLength(1)
  expect(f.save.mock.calls[1][0].writeOperationId).toBe(f.save.mock.calls[2][0].writeOperationId)
})
it('shutdown cancels inference before releasing the model and deletes unfinished job files', async () => {
  const f = await fixture()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  f.generate.mockImplementation(async (_input, signal) => {
    started()
    return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    )
  })
  const job = f.service.generate(
    { specPath: f.specPath, filename: 'result' },
    f.scope,
    new AbortController().signal
  )
  const rejected = expect(job).rejects.toThrow('Application is closing')
  await ready
  await f.service.close()
  await rejected
  expect(f.save).not.toHaveBeenCalled()
  expect(f.release).toHaveBeenCalledOnce()
  expect(await readdir(join(f.root, 'research-video-jobs'))).toEqual([])
})

it('reports actual worker progress only to the matching session and branch', async () => {
  const f = await fixture()
  let resume!: () => void
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const original = f.generate.getMockImplementation()!
  f.generate.mockImplementation(async (input, _signal, report) => {
    report?.({ phase: 'voice', completed: 2, total: 5 })
    started()
    await new Promise<void>((resolve) => {
      resume = resolve
    })
    return (original as (input: unknown) => Promise<unknown>)(input)
  })
  const pending = f.service.generate(
    { specPath: f.specPath, filename: 'result' },
    f.scope,
    new AbortController().signal
  )
  await ready
  expect(
    f.service.getProgress({ projectId: 'project', sessionId: 'session', branchId: 'branch' })
  ).toMatchObject({ phase: 'voice', completed: 2, total: 5 })
  expect(f.service.getProgress({ projectId: 'project', sessionId: 'other' })).toBeUndefined()
  expect(
    f.service.getProgress({ projectId: 'project', sessionId: 'session', branchId: 'other' })
  ).toBeUndefined()
  resume()
  await pending
  expect(f.service.getProgress({ projectId: 'project', sessionId: 'session' })?.phase).toBe(
    'completed'
  )
})
