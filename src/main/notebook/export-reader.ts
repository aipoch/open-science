import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import type {
  ExportNotebookAllRequest,
  ExportNotebookKernelRequest,
  NotebookRunDocument,
  NotebookRunRecord
} from '../../shared/notebook'
import { resolveDataKernelForTab } from '../../shared/notebook'
import {
  runDocumentToIpynbByKernel,
  runDocumentToIpynbForKernel,
  type NbformatOutput,
  type ResolvedArtifact
} from './ipynb-export'
import type { NotebookRunRepository } from './repository'

type NotebookExportFile = {
  kernel: 'python' | 'r'
  name: string
  data: string
}

type ResolveArtifactPath = (request: {
  path: string
  projectName: string
  sessionId: string
}) => Promise<string>

type NotebookExportReaderOptions = {
  repository: Pick<NotebookRunRepository, 'findExisting'>
  defaultProjectName: string
  appVersion?: string
  resolveArtifactPath?: ResolveArtifactPath
}

const isPathInside = (root: string, candidate: string): boolean => {
  const relativePath = relative(resolve(root), resolve(candidate))
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  )
}

const artifactMimeData = async (
  root: string,
  artifact: NotebookRunRecord['artifacts'][number],
  resolveManagedPath?: ResolveArtifactPath
): Promise<ResolvedArtifact | null> => {
  const mimeType = artifact.mimeType
  if (!mimeType) return null

  let filePath: string | undefined
  if (isPathInside(root, artifact.path)) {
    const [realRoot, realFilePath] = await Promise.all([realpath(root), realpath(artifact.path)])
    if (!isPathInside(realRoot, realFilePath)) {
      throw new Error(`Artifact escapes the notebook session root: ${artifact.name}`)
    }
    filePath = realFilePath
  } else {
    filePath = await resolveManagedPath?.({
      path: artifact.path,
      projectName: artifact.projectName,
      sessionId: artifact.sessionId
    })
  }
  if (!filePath) return null

  const binary = await readFile(filePath)
  if (mimeType === 'image/svg+xml') {
    return { mimeType, data: binary.toString('utf8') }
  }
  if (mimeType.startsWith('image/')) {
    return { mimeType, data: binary.toString('base64') }
  }
  if (mimeType === 'application/json') {
    return { mimeType, data: JSON.parse(binary.toString('utf8')) as unknown }
  }
  if (mimeType.startsWith('text/')) {
    return { mimeType, data: binary.toString('utf8') }
  }
  return null
}

const resolveArtifactOutputs = async (
  document: NotebookRunDocument,
  resolveManagedPath?: ResolveArtifactPath
): Promise<Map<string, NbformatOutput[]>> => {
  const outputsByRun = new Map<string, NbformatOutput[]>()
  const artifactSessionId = document.artifactSessionId ?? document.sessionId

  for (const run of document.runs) {
    if (run.artifacts.length === 0) continue

    const outputs: NbformatOutput[] = []
    for (const artifact of run.artifacts) {
      try {
        const belongsToDocument =
          artifact.projectName === document.projectName && artifact.sessionId === artifactSessionId
        const resolved = belongsToDocument
          ? await artifactMimeData(document.notebookSessionRoot, artifact, resolveManagedPath)
          : null
        if (resolved) {
          outputs.push({
            output_type: 'display_data',
            data: { [resolved.mimeType]: resolved.data },
            metadata: {}
          })
        }
      } catch {
        outputs.push({
          output_type: 'stream',
          name: 'stderr',
          text: [`[Open Science] Could not inline artifact: ${artifact.name}\n`]
        })
      }
    }
    outputsByRun.set(run.runId, outputs)
  }

  return outputsByRun
}

const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

// Owns durable snapshot loading, fail-closed artifact resolution, kernel selection, pure nbformat
// projection, and byte-stable serialization; Electron's native save action stays in the facade.
class NotebookExportReader {
  constructor(private readonly options: NotebookExportReaderOptions) {}

  async readKernel(request: ExportNotebookKernelRequest): Promise<NotebookExportFile> {
    const document = await this.loadDocument(request)
    const kernel = resolveDataKernelForTab(document.runs, request.kernel)
    if (!kernel) {
      throw new Error(
        `No ${request.kernel === 'repl' || request.kernel === 'bash' ? 'data-kernel' : request.kernel} runs in this session. Run a Python or R cell first.`
      )
    }

    const artifactOutputs = await resolveArtifactOutputs(document, this.options.resolveArtifactPath)
    const notebook = runDocumentToIpynbForKernel(document, kernel, {
      appVersion: this.options.appVersion,
      artifactOutputs
    })

    return {
      kernel,
      name: `session-${request.sessionId.slice(0, 8)}-${kernel}.ipynb`,
      data: serialize(notebook)
    }
  }

  async readAll(request: ExportNotebookAllRequest): Promise<NotebookExportFile[]> {
    const document = await this.loadDocument(request)
    const artifactOutputs = await resolveArtifactOutputs(document, this.options.resolveArtifactPath)
    const notebooks = runDocumentToIpynbByKernel(document, {
      appVersion: this.options.appVersion,
      artifactOutputs
    })
    const prefix = `session-${request.sessionId.slice(0, 8)}`
    const files = (['python', 'r'] as const)
      .filter((kernel) => notebooks[kernel] !== undefined)
      .map((kernel) => ({
        kernel,
        name: `${prefix}-${kernel}.ipynb`,
        data: serialize(notebooks[kernel])
      }))

    if (files.length === 0) {
      throw new Error('No data-kernel runs in this session. Run a Python or R cell first.')
    }
    return files
  }

  private async loadDocument(
    request: ExportNotebookAllRequest | ExportNotebookKernelRequest
  ): Promise<NotebookRunDocument> {
    const projectName = request.projectName ?? this.options.defaultProjectName
    const document = await this.options.repository.findExisting(projectName, request.sessionId)
    if (!document) {
      throw new Error(`Notebook session not found: ${request.sessionId}`)
    }
    return document
  }
}

export { NotebookExportReader }
