import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { analyzeNotebookSourceFileAccess } from '@aipoch/notebook-analysis'
import { isAbsolute, sep } from 'node:path'
import { englishNativeTranslator, type NativeTranslator } from '../locale/main-process-messages'
import {
  ProjectFolderConflictError,
  type ProjectFolderStagedFiles
} from '../project-folders/staged-files'
import type {
  NotebookSessionExecutionRequest,
  NotebookSessionExecutionResult
} from './session-aggregate'

export class ProjectFolderExecutionUnavailableError extends Error {
  constructor(readonly reason: 'unsupported-path') {
    super(`Project folder operation is unavailable (${reason}).`)
    this.name = 'ProjectFolderExecutionUnavailableError'
  }
}

type Options = {
  files: ProjectFolderStagedFiles
  getFolder: (projectId: string) => Promise<string | undefined>
  analyze: typeof analyzeNotebookSourceFileAccess
  translate?: NativeTranslator
}

// Direct Notebook execution follows the existing permission and platform-protection settings.
// App-mediated file mutations have a separate independently backed-up approval workflow.
export class ProjectFolderNotebookExecution {
  constructor(private readonly options: Options) {}
  async execute(
    request: NotebookSessionExecutionRequest,
    invoke: (request: NotebookSessionExecutionRequest) => Promise<NotebookSessionExecutionResult>
  ): Promise<NotebookSessionExecutionResult> {
    if (!request.projectId || !request.sessionId || !request.runId) return invoke(request)
    const folder = await this.options.getFolder(request.projectId)
    if (!folder) return invoke(request)
    // Preserve a user-selected directory within this Project between persistent-kernel cells.
    const prefix = folder.endsWith(sep) ? folder : folder + sep
    const cwd = request.cwd === folder || request.cwd.startsWith(prefix) ? request.cwd : folder
    const analysis = await this.options
      .analyze(
        request.kind === 'repl' ? 'repl' : (request.language ?? 'python'),
        request.code,
        request.sourceFileAccessContext
      )
      .catch(() => undefined)
    const inspect = async (
      path: string
    ): Promise<Awaited<ReturnType<typeof lstat>> | undefined> => {
      try {
        return await lstat(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
        throw error
      }
    }
    // A precise single existing-file edit can use the accepted independent-copy workflow.
    // Analysis uncertainty selects ordinary direct execution; it never disables a runtime.
    if (
      analysis &&
      request.kind !== 'repl' &&
      cwd === folder &&
      analysis.readState === 'complete' &&
      analysis.writeState === 'complete' &&
      analysis.writes.length === 1 &&
      [...analysis.reads, ...analysis.writes].every(
        (path) =>
          !isAbsolute(path) &&
          !path.split(/[\\/]/).some((part) => part === '..' || part.toLowerCase() === '.git')
      )
    ) {
      const target = analysis.writes[0]
      const existing = await inspect(join(folder, target))
      if (existing === undefined || (existing.isFile() && !existing.isSymbolicLink())) {
        const paths: string[] = []
        let stageable = true
        for (const path of new Set([...analysis.reads, target])) {
          const metadata = await inspect(join(folder, path))
          if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) {
            stageable = false
            break
          }
          if (metadata) paths.push(path)
        }
        if (!stageable) throw new ProjectFolderExecutionUnavailableError('unsupported-path')
        if (stageable) {
          const stage = await this.options.files.stageForRun({
            projectId: request.projectId,
            sessionId: request.sessionId,
            runId: request.runId,
            folder,
            directory: request.dataRoot,
            paths,
            outputs: [target]
          })
          if (stage) {
            let released = false
            let consumed = false
            let release: Promise<void> | undefined
            const releaseStage = (): Promise<void> =>
              (release ??= this.options.files.releaseStage(stage))
            const onProjectFolderStageReaped = async (): Promise<void> => {
              released = true
              // Teardown can finish before immutable candidate capture; wait for that consumer.
              if (consumed) await releaseStage()
            }
            try {
              const result = await invoke({
                ...request,
                cwd: stage.directory,
                projectFolderRoot: folder,
                projectFolderStageRoot: stage.directory,
                onProjectFolderStageReaped,
                observationMode: 'declared-paths',
                unfrozenInputPaths: stage.inputs.map((input) =>
                  ['data', input.path.split(sep).join('/')].join('/')
                )
              })
              released ||= result.projectFolderStageReleased === true
              const changes = []
              let publicationWarning: string | undefined
              if (result.status === 'completed') {
                try {
                  const present = (await inspect(join(stage.directory, target))) !== undefined
                  const change = await this.options.files.prepare(
                    stage,
                    target,
                    present ? 'write' : 'delete'
                  )
                  if (change)
                    changes.push(
                      await this.options.files.apply(
                        stage,
                        change.id,
                        request.signal,
                        request.projectFolderPermissionPrompts
                      )
                    )
                } catch (error) {
                  if (!(error instanceof ProjectFolderConflictError)) throw error
                  publicationWarning = (this.options.translate ?? englishNativeTranslator)(
                    'Could not change {{path}} because the file changed on disk. Review the latest file or try a different name.',
                    { path: target }
                  )
                }
              }
              return {
                ...result,
                ...(publicationWarning
                  ? {
                      stderr: [result.stderr, publicationWarning].filter(Boolean).join('\n'),
                      outputs: result.outputs.length
                        ? [
                            ...result.outputs,
                            {
                              type: 'stream' as const,
                              name: 'stderr' as const,
                              text: publicationWarning
                            }
                          ]
                        : result.outputs
                    }
                  : {}),
                projectFolderChanges: changes,
                projectFolderInputs: stage.inputs.map((input) => ({
                  relativePath: input.path.split(sep).join('/'),
                  checksum: input.version.checksum,
                  sizeBytes: input.version.size,
                  frozen: false
                }))
              }
            } catch (error) {
              released ||=
                typeof error === 'object' &&
                error !== null &&
                'projectFolderStageReleased' in error &&
                error.projectFolderStageReleased === true
              throw error
            } finally {
              consumed = true
              if (released) await releaseStage()
            }
          }
        }
      }
    }
    const inputs = analysis
      ? await this.options.files.describeInputs(folder, cwd, analysis.reads)
      : []
    const result = await invoke({
      ...request,
      cwd,
      projectFolderRoot: folder,
      observationMode: 'declared-paths',
      unfrozenInputPaths: inputs.map((input) => ['data', input.relativePath].join('/'))
    })
    return { ...result, projectFolderInputs: inputs }
  }
}
