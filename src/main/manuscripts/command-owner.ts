import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { ArtifactVersionDescriptor } from '../../shared/artifact-provenance'
import {
  isManuscriptExportFormat,
  type ManuscriptBibtexExport,
  type ManuscriptExportFormat,
  type PrepareManuscriptRequest,
  type PrepareManuscriptResult,
  type QuartoDetection,
  type RenderManuscriptRequest,
  type RenderManuscriptResult
} from '../../shared/manuscripts'
import { resolveManuscriptReferences } from './artifact-references'

const execFileAsync = promisify(execFile)
const RENDER_TIMEOUT_MS = 10 * 60 * 1000
const RENDER_MAX_BUFFER = 16 * 1024 * 1024
const SAFE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

type CommandRunRequest = Readonly<{
  command: string
  args: readonly string[]
  cwd: string
  signal?: AbortSignal
}>

type ManuscriptApprovalRequest = Readonly<{
  sessionId: string
  title: string
  rawInput: unknown
  signal?: AbortSignal
}>

type ManuscriptCommandOwnerDependencies = Readonly<{
  discoverQuarto: () => Promise<QuartoDetection>
  resolveVersionDescriptors: (request: {
    projectId: string
    appSessionId: string
    versionIds: string[]
  }) => Promise<ArtifactVersionDescriptor[]>
  exportBibtex: (itemIds: readonly string[]) => Promise<ManuscriptBibtexExport>
  approve: (request: ManuscriptApprovalRequest) => Promise<boolean>
  run?: (request: CommandRunRequest) => Promise<{ stdout: string; stderr: string }>
  createId?: () => string
}>

type InternalRenderManuscriptRequest = RenderManuscriptRequest &
  Readonly<{ workingDirectory?: string }>

type ManuscriptCommandOwner = Readonly<{
  detectQuarto: () => Promise<QuartoDetection>
  prepare: (request: PrepareManuscriptRequest) => Promise<PrepareManuscriptResult>
  render: (
    request: InternalRenderManuscriptRequest,
    signal?: AbortSignal
  ) => Promise<RenderManuscriptResult>
}>

const defaultRun = async ({
  command,
  args,
  cwd,
  signal
}: CommandRunRequest): Promise<{ stdout: string; stderr: string }> => {
  const { stdout, stderr } = await execFileAsync(command, [...args], {
    cwd,
    timeout: RENDER_TIMEOUT_MS,
    maxBuffer: RENDER_MAX_BUFFER,
    windowsHide: true,
    shell: false,
    signal
  })
  return { stdout: String(stdout), stderr: String(stderr) }
}

const outputFilename = (
  requested: string | undefined,
  format: ManuscriptExportFormat
): { qmd: string; output: string } => {
  const sourceName = requested && SAFE_BASENAME.test(requested) ? requested : 'manuscript.qmd'
  const withoutExtension = sourceName.replace(/\.[^.]+$/u, '') || 'manuscript'
  return {
    qmd: `${withoutExtension}.qmd`,
    output: `${withoutExtension}.${format}`
  }
}

const mimeTypeFor = (format: ManuscriptExportFormat): string => {
  switch (format) {
    case 'html':
      return 'text/html'
    case 'pdf':
      return 'application/pdf'
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
}

const createManuscriptCommandOwner = (
  dependencies: ManuscriptCommandOwnerDependencies
): ManuscriptCommandOwner => {
  const createId = dependencies.createId ?? randomUUID
  const run = dependencies.run ?? defaultRun

  const prepare = (request: PrepareManuscriptRequest): Promise<PrepareManuscriptResult> =>
    resolveManuscriptReferences({
      ...request,
      resolveVersionDescriptors: dependencies.resolveVersionDescriptors,
      exportBibtex: dependencies.exportBibtex
    })

  return {
    detectQuarto: () => dependencies.discoverQuarto(),
    prepare,
    render: async (request, signal) => {
      if (!isManuscriptExportFormat(request.format)) {
        throw new Error(`Unsupported manuscript export format: ${String(request.format)}`)
      }
      const detection = await dependencies.discoverQuarto()
      if (!detection.available) throw new Error(detection.reason)

      const ownedWorkingDirectory = request.workingDirectory === undefined
      let workingDirectory: string | undefined
      let qmdPath: string | undefined
      let bibliographyPath: string | undefined
      let outputRoot: string | undefined
      try {
        workingDirectory =
          request.workingDirectory ??
          (await mkdtemp(join(tmpdir(), 'open-science-manuscript-work-')))
        await mkdir(workingDirectory, { recursive: true })
        const prepared = await prepare(request)
        const names = outputFilename(request.filename, request.format)
        const id = createId().replace(/[^A-Za-z0-9_-]/gu, '-')
        qmdPath = join(workingDirectory, `.open-science-manuscript-${id}.qmd`)
        const bibliographyName = `.open-science-manuscript-${id}.bib`
        bibliographyPath = join(workingDirectory, bibliographyName)
        outputRoot = await mkdtemp(join(tmpdir(), 'open-science-quarto-'))
        const outputPath = join(outputRoot, names.output)
        const qmd = prepared.bibliography
          ? prepared.qmd.replaceAll('references.bib', bibliographyName)
          : prepared.qmd

        await writeFile(qmdPath, qmd, { encoding: 'utf8', flag: 'wx' })
        if (prepared.bibliography) {
          await writeFile(bibliographyPath, prepared.bibliography.content, {
            encoding: 'utf8',
            flag: 'wx'
          })
        }
        const args = [
          'render',
          qmdPath,
          '--to',
          request.format,
          '--output',
          outputPath,
          '--no-execute'
        ]
        const approved = await dependencies.approve({
          sessionId: request.appSessionId,
          title: 'Run Quarto manuscript render?',
          rawInput: {
            format: request.format,
            command: detection.path,
            args,
            cwd: workingDirectory
          },
          signal
        })
        if (!approved) throw new Error('Quarto manuscript render was not approved.')

        try {
          await run({
            command: detection.path,
            args,
            cwd: workingDirectory,
            signal
          })
        } catch (error) {
          const detail =
            error && typeof error === 'object' && 'stderr' in error
              ? String(error.stderr).trim()
              : error instanceof Error
                ? error.message
                : String(error)
          throw new Error(`Quarto manuscript render failed: ${detail}`)
        }

        const bytes = await readFile(outputPath)
        return {
          filename: names.output,
          mimeType: mimeTypeFor(request.format),
          dataBase64: bytes.toString('base64'),
          references: prepared.references
        }
      } finally {
        await Promise.all([
          ...(qmdPath ? [rm(qmdPath, { force: true })] : []),
          ...(bibliographyPath ? [rm(bibliographyPath, { force: true })] : []),
          ...(outputRoot ? [rm(outputRoot, { recursive: true, force: true })] : []),
          ...(ownedWorkingDirectory && workingDirectory
            ? [rm(workingDirectory, { recursive: true, force: true })]
            : [])
        ]).catch(() => undefined)
      }
    }
  }
}

export { createManuscriptCommandOwner }
export type {
  CommandRunRequest,
  ManuscriptApprovalRequest,
  ManuscriptCommandOwner,
  InternalRenderManuscriptRequest,
  ManuscriptCommandOwnerDependencies
}
