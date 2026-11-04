import type {
  ResearchVideoProgress,
  ResearchVideoStep,
  ResearchVideoProgressRequest
} from '@aipoch/research-film/contracts'
import { acquireDataRootWriter } from '../storage/migration-state'
import { randomUUID } from 'node:crypto'
import { mkdir, lstat, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { writeDurableJsonFile } from '@aipoch/durable-files'
import type { LocalModelOwner, LocalModelUse } from '../local-models/owner'
import type {
  ArtifactRpcCapabilityBinding,
  ArtifactVersionFile,
  SaveArtifactVersionRequest,
  ArtifactWriteSourceScope
} from '../../shared/artifact-provenance'
import { resolveAllowedImportFilePath } from '../artifacts/storage-access'
import { generateResearchVideoSchema } from '@aipoch/research-film'
import { freezeResearchVideoSource } from '@aipoch/research-film'
import type {
  createResearchVideoGenerator,
  ResearchVideoGenerationResult
} from '@aipoch/research-film'

type Input = z.infer<z.ZodObject<typeof generateResearchVideoSchema>>
export type ResearchVideoScope = ArtifactRpcCapabilityBinding & {
  sourceScope: ArtifactWriteSourceScope
}
type Result = {
  player: ArtifactVersionFile
  sources: ArtifactVersionFile
  duration: number
  preparationMs: number
}
type Job = {
  schemaVersion: 1
  id: string
  projectId: string
  appSessionId: string
  messageBranchId: string
  filename: string
  state: 'generating' | 'generated' | 'publishing' | 'completed'
  generation?: ResearchVideoGenerationResult
  publicationRun?: string
  player?: ArtifactVersionFile
  sources?: ArtifactVersionFile
}

/** One process owner, one CPU job at a time. Capability admission and shutdown own its lifetime. */
export function createResearchVideoService(options: {
  models: LocalModelOwner
  acquireWriter?: () => () => void
  dataRoot: () => string
  engineDirectory: string
  generate: ReturnType<typeof createResearchVideoGenerator>
  save: (
    request: SaveArtifactVersionRequest,
    scope: ArtifactWriteSourceScope,
    signal: AbortSignal
  ) => Promise<ArtifactVersionFile>
}): {
  generate(input: Input, scope: ResearchVideoScope, signal: AbortSignal): Promise<Result>
  getProgress(request: ResearchVideoProgressRequest): ResearchVideoProgress | undefined
  close(): Promise<void>
} {
  let latest:
    { scope: ResearchVideoScope; progress: ResearchVideoProgress; settledAt?: number } | undefined
  let closed = false
  let active: { controller: AbortController; done: Promise<Result> } | undefined
  const run = async (
    input: Input,
    scope: ResearchVideoScope,
    signal: AbortSignal
  ): Promise<Result> => {
    const started = performance.now()
    latest = { scope, progress: { phase: 'preparing', startedAt: Date.now() } }
    const report = (step: ResearchVideoStep): void => {
      if (latest?.scope === scope)
        latest.progress = { ...step, startedAt: latest.progress.startedAt }
    }
    let lease: LocalModelUse | undefined
    let release: (() => void) | undefined
    let created = false
    let job: Job | undefined
    let directory: string | undefined
    const persist = (): Promise<void> =>
      writeDurableJsonFile(join(directory!, 'job.json'), JSON.stringify(job))
    try {
      signal.throwIfAborted()
      lease = input.resumeJobId ? undefined : await options.models.acquireUse()
      release = lease ? lease.release : (options.acquireWriter ?? acquireDataRootWriter)()
      const base = join(options.dataRoot(), 'research-video-jobs')
      await mkdir(base, { recursive: true })
      if ((await lstat(base)).isSymbolicLink())
        throw new Error('Unsafe research video job directory')
      const id = input.resumeJobId ?? randomUUID()
      directory = join(base, id)
      if (input.resumeJobId) {
        const info = await lstat(directory)
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error('Unsafe research video job')
        const receipt = join(directory, 'job.json')
        if ((await lstat(receipt)).size > 1024 * 1024 || (await lstat(receipt)).isSymbolicLink())
          throw new Error('Invalid research video job receipt')
        job = JSON.parse(await readFile(receipt, 'utf8')) as Job
        if (
          job.schemaVersion !== 1 ||
          job.id !== id ||
          job.projectId !== scope.projectId ||
          job.appSessionId !== scope.appSessionId ||
          job.messageBranchId !== scope.messageBranchId ||
          !job.generation
        )
          throw new Error(
            'Research video job does not match this conversation branch or has no completed output'
          )
        // Paths in a receipt are never authority; derive our owned output paths again.
        job.generation.playerPath = join(directory, 'output', 'player.html')
        job.generation.sourcePath = join(directory, 'output', 'sources.zip')
      } else {
        const specPath = await resolveAllowedImportFilePath(
          input.specPath,
          scope.sourceScope.allowedImportRoots,
          [scope.sourceScope.notebookDataDir, scope.sourceScope.workspaceCwd].filter(
            (p): p is string => Boolean(p)
          )
        )
        await mkdir(directory, { recursive: false })
        created = true
        job = {
          schemaVersion: 1,
          id,
          projectId: scope.projectId,
          appSessionId: scope.appSessionId,
          messageBranchId: scope.messageBranchId,
          filename: input.filename,
          state: 'generating'
        }
        await persist()
        const frozenSpecPath = await freezeResearchVideoSource(
          specPath,
          join(directory, 'source'),
          signal
        )
        job.generation = await options.generate(
          {
            specPath: frozenSpecPath,
            modelDirectory: dirname(
              lease!.assets.find((asset) => asset.file === 'model_quantized.onnx')!.path
            ),
            engineDirectory: options.engineDirectory,
            outputDirectory: join(directory, 'output'),
            provenance: {
              kind: 'agent-authored-source-snapshot',
              projectId: scope.projectId,
              appSessionId: scope.appSessionId,
              messageBranchId: scope.messageBranchId,
              messageBranchAncestry: scope.messageBranchAncestry,
              messageAncestry: scope.messageAncestry,
              artifactRunId: scope.artifactRunId,
              promptMessageId: scope.promptMessageId,
              modelRevision: lease!.revision,
              sourceClaimsIndependentlyVerified: false
            }
          },
          signal,
          report
        )
        job.state = 'generated'
        await persist()
      }
      if (job.publicationRun !== scope.artifactRunId) {
        job.publicationRun = scope.artifactRunId
        job.player = undefined
        job.sources = undefined
      }
      report({ phase: 'publishing' })
      job.state = 'publishing'
      await persist()
      const save = async (kind: 'player' | 'sources'): Promise<ArtifactVersionFile> => {
        signal.throwIfAborted()
        const binding = scope
        return options.save(
          {
            projectId: binding.projectId,
            appSessionId: binding.appSessionId,
            artifactStorageSessionId: binding.artifactStorageSessionId,
            artifactRunId: binding.artifactRunId,
            rootFrameId: binding.rootFrameId,
            agentFrameId: binding.agentFrameId,
            messageBranchId: binding.messageBranchId,
            runtimeSegmentId: binding.runtimeSegmentId,
            promptMessageId: binding.promptMessageId,
            agentName: binding.agentName,
            notebookSessionId: binding.notebookSessionId,
            messageBranchAncestry: binding.messageBranchAncestry
              ? [...binding.messageBranchAncestry]
              : undefined,
            messageAncestry: binding.messageAncestry ? [...binding.messageAncestry] : undefined,
            writeOperationId: `research-video-${job!.id}-${kind}`,
            filename: kind === 'player' ? `${job!.filename}.html` : `${job!.filename}-sources.zip`,
            contentType: kind === 'player' ? 'text/html' : 'application/zip',
            source: {
              kind: 'localPath',
              path: kind === 'player' ? job!.generation!.playerPath : job!.generation!.sourcePath
            }
          },
          { allowedImportRoots: [join(directory!, 'output')] },
          signal
        )
      }
      job.sources ??= await save('sources')
      await persist()
      job.player ??= await save('player')
      job.state = 'completed'
      await persist()
      const result = {
        sources: job.sources,
        player: job.player,
        duration: job.generation!.duration,
        preparationMs: performance.now() - started
      }
      await rm(directory, { recursive: true, force: true })
      report({ phase: 'completed' })
      return result
    } catch (error) {
      report({ phase: signal.aborted ? 'cancelled' : 'failed' })
      if (directory && job?.generation) {
        throw new Error(
          `Research video publication did not complete. Retry generate_research_video with resumeJobId=${job.id}; completed sources and narration are retained. ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        )
      }
      if (created && directory && job?.state === 'generating')
        await rm(directory, { recursive: true, force: true })
      throw error
    } finally {
      if (latest?.scope === scope) latest.settledAt = Date.now()
      release?.()
    }
  }
  return {
    getProgress(request) {
      const { projectId, sessionId, branchId } = z
        .object({
          projectId: z.string().min(1).max(512),
          sessionId: z.string().min(1).max(512),
          branchId: z.string().min(1).max(512).optional()
        })
        .strict()
        .parse(request)
      if (
        !latest ||
        latest.scope.projectId !== projectId ||
        latest.scope.appSessionId !== sessionId ||
        (branchId && latest.scope.messageBranchId !== branchId) ||
        (latest.settledAt && Date.now() - latest.settledAt > 5000)
      )
        return undefined
      return { ...latest.progress }
    },
    generate(rawInput, scope, signal) {
      const input = z.object(generateResearchVideoSchema).parse(rawInput)
      if (closed) return Promise.reject(new Error('Research video generation is closed'))
      if (active)
        return Promise.reject(
          new Error('Another research video is being generated. Retry after it completes.')
        )
      const controller = new AbortController()
      const done = run(input, scope, AbortSignal.any([signal, controller.signal])).finally(() => {
        active = undefined
      })
      active = { controller, done }
      return done
    },
    async close() {
      closed = true
      const running = active
      running?.controller.abort(new Error('Application is closing'))
      await running?.done.catch(() => {})
    }
  }
}
