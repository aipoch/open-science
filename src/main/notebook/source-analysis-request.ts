import { analyzeNotebookCodeRisk } from '@aipoch/notebook-code-risk'
import {
  analyzeNotebookSourceFileAccess,
  analyzePythonNotebookSource,
  analyzeReplNotebookSource,
  analyzeRNotebookSource,
  type AnalyzeNotebookSource
} from '@aipoch/notebook-analysis'

type CodeRiskArguments = Parameters<typeof analyzeNotebookCodeRisk>
type FileAccessArguments = Parameters<typeof analyzeNotebookSourceFileAccess>

// Structured-clone payloads shared by the main thread and the source-analysis worker.
export type SourceAnalysisRequest =
  | {
      kind: 'code-risk'
      language: CodeRiskArguments[0]
      source: string
      context?: CodeRiskArguments[2]
      previousSources?: CodeRiskArguments[3]
    }
  | {
      kind: 'dependencies'
      language: Parameters<AnalyzeNotebookSource>[0]
      source: string
      context: Parameters<AnalyzeNotebookSource>[2]
    }
  | {
      kind: 'file-access'
      language: FileAccessArguments[0]
      source: string
      context?: FileAccessArguments[2]
    }

export const runSourceAnalysis = (
  request: SourceAnalysisRequest,
  signal?: AbortSignal
): Promise<unknown> => {
  if (request.kind === 'code-risk') {
    return analyzeNotebookCodeRisk(
      request.language,
      request.source,
      request.context,
      request.previousSources,
      signal
    )
  }
  if (request.kind === 'file-access') {
    return analyzeNotebookSourceFileAccess(request.language, request.source, request.context)
  }
  const analyzeSource =
    request.language === 'repl'
      ? analyzeReplNotebookSource
      : request.language === 'python'
        ? analyzePythonNotebookSource
        : analyzeRNotebookSource
  return analyzeSource(request.source, request.context)
}
