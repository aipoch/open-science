import type {
  ExportNotebookAllRequest,
  ExportNotebookKernelRequest,
  NotebookRunDocument
} from '../../shared/notebook'
import { resolveDataKernelForTab } from '../../shared/notebook'
import { runDocumentToIpynbByKernel, runDocumentToIpynbForKernel } from './ipynb-export'
import type { NotebookRunRepository } from './repository'

type NotebookExportFile = {
  kernel: 'python' | 'r'
  name: string
  data: string
}

type NotebookExportReaderOptions = {
  repository: Pick<NotebookRunRepository, 'findExisting'> &
    Partial<Pick<NotebookRunRepository, 'readSessionRuns'>>
  defaultProjectName: string
  appVersion?: string
}

const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

// Owns durable snapshot loading, kernel selection, pure nbformat projection, and byte-stable
// serialization; Electron's native save action stays in the facade.
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

    const notebook = runDocumentToIpynbForKernel(document, kernel, {
      appVersion: this.options.appVersion
    })

    return {
      kernel,
      name: `session-${request.sessionId.slice(0, 8)}-${kernel}.ipynb`,
      data: serialize(notebook)
    }
  }

  async readAll(request: ExportNotebookAllRequest): Promise<NotebookExportFile[]> {
    const document = await this.loadDocument(request)
    const notebooks = runDocumentToIpynbByKernel(document, {
      appVersion: this.options.appVersion
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
    const sessionRuns = this.options.repository.readSessionRuns
      ? await this.options.repository.readSessionRuns(projectName, request.sessionId)
      : document.runs
    const runs =
      request.agentFrameFilter === undefined
        ? sessionRuns
        : request.agentFrameFilter === null
          ? sessionRuns.filter((run) => !run.agentFrameId)
          : sessionRuns.filter((run) => run.agentFrameId === request.agentFrameFilter)
    return { ...document, runs }
  }
}

export { NotebookExportReader }
