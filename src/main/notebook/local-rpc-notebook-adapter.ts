import { z } from 'zod'

import {
  notebookLanguageSchema,
  type AppendNotebookCodeCellRequest,
  type BeginNotebookCodeCellRequest,
  type ExecuteNotebookCodeRequest,
  type ExecuteNotebookControlRequest,
  type ExecuteShellRequest,
  type AbortNotebookCodeCellRequest,
  type FinishNotebookCodeCellRequest,
  type NotebookLanguage,
  type NotebookRestartRequest,
  type NotebookSessionRequest,
  type RequestNotebookNetworkAccessRequest,
  type RunNotebookCellRequest
} from '../../shared/notebook'
import type { ManageEnvironmentsRequest, ManageEnvironmentsResult } from '../../shared/notebook-env'
import type { InstallRequest, InstallResult } from './package-manager'

const provenanceContextSchema = z
  .object({
    rootFrameId: z.string(),
    agentFrameId: z.string(),
    messageBranchId: z.string(),
    runtimeSegmentId: z.string(),
    promptMessageId: z.string(),
    originMessageId: z.string().optional()
  })
  .strict()

const registeredInputFileSchema = z
  .object({
    inputFileVersionId: z.string(),
    sourceKind: z.enum(['upload-version', 'artifact-version']),
    sourceFileId: z.string(),
    sourceVersionNumber: z.number().optional(),
    sourceCreatedAt: z.string().optional(),
    sourceProjectId: z.string(),
    sourceSessionId: z.string(),
    filename: z.string(),
    contentType: z.string().optional(),
    sizeBytes: z.number(),
    checksum: z.string(),
    storageKey: z.string(),
    association: z.enum(['turn-attached', 'resolver-accessed'])
  })
  .strict()

const notebookSessionRequestSchema = z
  .object({
    projectId: z.string().optional(),
    sessionId: z.string(),
    workspaceCwd: z.string(),
    provenanceContext: provenanceContextSchema.optional(),
    executionInvocationId: z.string().optional(),
    registeredInputFiles: z.array(registeredInputFileSchema).optional(),
    registeredHelperSkillIds: z.array(z.string()).optional(),
    inputRunLeaseId: z.string().optional(),
    delegatedWorkAttemptId: z.string().optional()
  })
  .strict()

const positiveTimeoutSchema = z.number().int().positive()
const runSourceSchema = z.enum(['agent', 'user'])
const runInputKindSchema = z.enum(['cell', 'terminal'])
const paginationSchema = {
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional()
}

const notebookLocalRpcRequestSchemas = {
  beginCodeCell: notebookSessionRequestSchema.extend({
    cellId: z.string().optional(),
    source: runSourceSchema.optional(),
    language: notebookLanguageSchema.optional(),
    environment: z.string().optional()
  }),
  appendCodeCell: notebookSessionRequestSchema.extend({
    writeId: z.string(),
    cellId: z.string(),
    delta: z.string()
  }),
  abortCodeCell: notebookSessionRequestSchema.extend({
    writeId: z.string(),
    cellId: z.string()
  }),
  finishCodeCell: notebookSessionRequestSchema.extend({
    writeId: z.string(),
    cellId: z.string()
  }),
  runCell: notebookSessionRequestSchema.extend({
    cellId: z.string(),
    timeoutMs: positiveTimeoutSchema.optional(),
    source: runSourceSchema.optional(),
    inputKind: runInputKindSchema.optional(),
    environment: z.string().optional()
  }),
  execute: notebookSessionRequestSchema.extend({
    code: z.string(),
    kernelSkillIds: z.array(z.string().min(1).max(128)).optional(),
    artifactVersionInputs: z.array(z.string().min(1).max(256)).max(64).optional(),
    timeoutMs: positiveTimeoutSchema.optional(),
    cellId: z.string().optional(),
    source: runSourceSchema.optional(),
    inputKind: runInputKindSchema.optional(),
    language: notebookLanguageSchema.optional(),
    environment: z.string().optional()
  }),
  executeControl: notebookSessionRequestSchema.extend({
    code: z.string(),
    timeoutMs: positiveTimeoutSchema.optional()
  }),
  executeShell: notebookSessionRequestSchema.extend({
    command: z.string(),
    timeoutMs: positiveTimeoutSchema.optional()
  }),
  requestNetworkAccess: notebookSessionRequestSchema.extend({
    hostname: z.string().trim().min(1).max(253),
    reason: z.string().trim().min(1).max(1_000),
    runtime: z.enum(['python', 'r', 'repl', 'bash']).optional(),
    command: z.string().min(1).optional()
  }),
  state: notebookSessionRequestSchema,
  restart: z.union([
    notebookSessionRequestSchema,
    notebookSessionRequestSchema.extend({
      language: notebookLanguageSchema,
      environment: z.string().min(1)
    })
  ]),
  shutdown: notebookSessionRequestSchema,
  inspectPackages: notebookSessionRequestSchema.extend({
    language: notebookLanguageSchema,
    packages: z.array(z.string().min(1)).min(1)
  }),
  managePackages: notebookSessionRequestSchema.extend({
    language: notebookLanguageSchema,
    packages: z.array(z.string().min(1)).min(1),
    usePip: z.boolean().optional(),
    installer: z.enum(['biocmanager', 'github']).optional(),
    channels: z.array(z.string().min(1)).optional(),
    environment: z.string().optional(),
    operation: z.enum(['install', 'uninstall']).optional()
  }),
  manageEnvironments: z.discriminatedUnion('action', [
    notebookSessionRequestSchema.extend({
      action: z.literal('create'),
      language: notebookLanguageSchema,
      name: z.string(),
      packages: z.array(z.string().min(1)).optional(),
      ...paginationSchema
    }),
    notebookSessionRequestSchema.extend({ action: z.literal('list'), ...paginationSchema }),
    notebookSessionRequestSchema.extend({
      action: z.literal('remove'),
      name: z.string(),
      ...paginationSchema
    })
  ]),
  listRuntimes: notebookSessionRequestSchema.extend(paginationSchema),
  bindRuntime: notebookSessionRequestSchema.extend({
    language: notebookLanguageSchema,
    runtimeId: z.string().min(1)
  }),
  switchRuntime: notebookSessionRequestSchema.extend({
    language: notebookLanguageSchema,
    runtimeId: z.string().min(1)
  })
} as const

type NotebookLocalRpcRequestSchemas = typeof notebookLocalRpcRequestSchemas

const parseNotebookLocalRpcRequest = <Method extends keyof NotebookLocalRpcRequestSchemas>(
  method: Method,
  request: Record<string, unknown>
): z.output<NotebookLocalRpcRequestSchemas[Method]> => {
  const parsed = notebookLocalRpcRequestSchemas[method].safeParse(request)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.join('.') || 'params'
    throw new Error(
      `Invalid notebook RPC params for ${method}: ${path}: ${issue?.message ?? 'invalid value'}`
    )
  }
  // These schemas validate without coercion or defaults. Keep the established request identity so
  // runtime consumers and tests observe the same object the authenticated bridge enriched.
  return request as z.output<NotebookLocalRpcRequestSchemas[Method]>
}

type InspectPackagesRequest = NotebookSessionRequest & {
  language: NotebookLanguage
  packages: string[]
}

type NotebookRuntimeBindingRequest = NotebookSessionRequest & {
  language: NotebookLanguage
  runtimeId: string
}

type NotebookLocalRpcCapability = {
  beginCodeCell(request: BeginNotebookCodeCellRequest, signal?: AbortSignal): Promise<unknown>
  appendCodeCell(request: AppendNotebookCodeCellRequest): Promise<unknown>
  abortCodeCell(request: AbortNotebookCodeCellRequest): Promise<unknown>
  finishCodeCell(request: FinishNotebookCodeCellRequest): Promise<unknown>
  runCell(request: RunNotebookCellRequest, signal?: AbortSignal): Promise<unknown>
  execute(request: ExecuteNotebookCodeRequest, signal?: AbortSignal): Promise<unknown>
  executeControl(request: ExecuteNotebookControlRequest): Promise<unknown>
  executeShell(request: ExecuteShellRequest, signal?: AbortSignal): Promise<unknown>
  requestNetworkAccess(
    request: RequestNotebookNetworkAccessRequest,
    signal?: AbortSignal
  ): Promise<unknown>
  state(request: NotebookSessionRequest): Promise<unknown>
  restart(request: NotebookRestartRequest): Promise<unknown>
  shutdown(request: NotebookSessionRequest): Promise<unknown>
  inspectPackages(request: InspectPackagesRequest): Promise<unknown>
  managePackages(request: InstallRequest): Promise<InstallResult>
  manageEnvironments(request: ManageEnvironmentsRequest): Promise<ManageEnvironmentsResult>
  listRuntimes(request: NotebookSessionRequest): Promise<unknown>
  bindRuntime(request: NotebookRuntimeBindingRequest): Promise<unknown>
  switchRuntime(request: NotebookRuntimeBindingRequest): Promise<unknown>
}

const NOTEBOOK_LOCAL_RPC_METHODS = [
  'beginCodeCell',
  'appendCodeCell',
  'abortCodeCell',
  'finishCodeCell',
  'runCell',
  'execute',
  'executeControl',
  'executeShell',
  'requestNetworkAccess',
  'state',
  'restart',
  'shutdown',
  'inspectPackages',
  'managePackages',
  'manageEnvironments',
  'listRuntimes',
  'bindRuntime',
  'switchRuntime'
] as const

type NotebookLocalRpcMethod = (typeof NOTEBOOK_LOCAL_RPC_METHODS)[number]
type NotebookLocalRpcHandler = (
  request: Record<string, unknown>,
  signal?: AbortSignal
) => Promise<unknown>

const NOTEBOOK_LOCAL_RPC_METHOD_SET = new Set<string>(NOTEBOOK_LOCAL_RPC_METHODS)
const NOTEBOOK_INPUT_RUN_METHODS = new Set<NotebookLocalRpcMethod>([
  'runCell',
  'execute',
  'executeControl',
  'executeShell'
])

const isNotebookLocalRpcMethod = (method: unknown): method is NotebookLocalRpcMethod =>
  typeof method === 'string' && NOTEBOOK_LOCAL_RPC_METHOD_SET.has(method)

const opensNotebookInputRun = (method: unknown): method is NotebookLocalRpcMethod =>
  isNotebookLocalRpcMethod(method) && NOTEBOOK_INPUT_RUN_METHODS.has(method)

const assertSessionParams = (params: Record<string, unknown>): void => {
  if (typeof params.sessionId !== 'string' || typeof params.workspaceCwd !== 'string') {
    throw new Error('Notebook RPC params must include sessionId and workspaceCwd.')
  }
}

const toExecuteNotebookCodeRequest = (
  request: z.output<NotebookLocalRpcRequestSchemas['execute']>
): ExecuteNotebookCodeRequest => {
  const { kernelSkillIds, ...runtimeRequest } = request
  return {
    ...runtimeRequest,
    ...(kernelSkillIds ? { helperModules: kernelSkillIds } : {})
  }
}

const resolveNotebookLocalRpcHandler = (
  capability: NotebookLocalRpcCapability,
  method: string,
  params: Record<string, unknown>
): NotebookLocalRpcHandler => {
  assertSessionParams(params)

  if (!isNotebookLocalRpcMethod(method)) {
    throw new Error(`Unknown notebook RPC method: ${method}`)
  }
  parseNotebookLocalRpcRequest(method, params)

  switch (method) {
    case 'beginCodeCell':
      return (request, signal) =>
        capability.beginCodeCell(parseNotebookLocalRpcRequest('beginCodeCell', request), signal)
    case 'appendCodeCell':
      return (request) =>
        capability.appendCodeCell(parseNotebookLocalRpcRequest('appendCodeCell', request))
    case 'abortCodeCell':
      return (request) =>
        capability.abortCodeCell(parseNotebookLocalRpcRequest('abortCodeCell', request))
    case 'finishCodeCell':
      return (request) =>
        capability.finishCodeCell(parseNotebookLocalRpcRequest('finishCodeCell', request))
    case 'runCell':
      return (request, signal) =>
        capability.runCell(parseNotebookLocalRpcRequest('runCell', request), signal)
    case 'execute':
      return (request, signal) => {
        const parsed = parseNotebookLocalRpcRequest('execute', request)
        return capability.execute(toExecuteNotebookCodeRequest(parsed), signal)
      }
    case 'executeControl':
      return (request) =>
        capability.executeControl(parseNotebookLocalRpcRequest('executeControl', request))
    case 'executeShell':
      return (request, signal) =>
        capability.executeShell(parseNotebookLocalRpcRequest('executeShell', request), signal)
    case 'requestNetworkAccess':
      return (request, signal) =>
        capability.requestNetworkAccess(
          parseNotebookLocalRpcRequest('requestNetworkAccess', request),
          signal
        )
    case 'state':
      return (request) => capability.state(parseNotebookLocalRpcRequest('state', request))
    case 'restart':
      return (request) => capability.restart(parseNotebookLocalRpcRequest('restart', request))
    case 'shutdown':
      return (request) => capability.shutdown(parseNotebookLocalRpcRequest('shutdown', request))
    case 'inspectPackages':
      return (request) =>
        capability.inspectPackages(parseNotebookLocalRpcRequest('inspectPackages', request))
    case 'managePackages':
      return (request) =>
        capability.managePackages(parseNotebookLocalRpcRequest('managePackages', request))
    case 'manageEnvironments':
      return (request) =>
        capability.manageEnvironments(parseNotebookLocalRpcRequest('manageEnvironments', request))
    case 'listRuntimes':
      return (request) =>
        capability.listRuntimes(parseNotebookLocalRpcRequest('listRuntimes', request))
    case 'bindRuntime':
      return (request) =>
        capability.bindRuntime(parseNotebookLocalRpcRequest('bindRuntime', request))
    case 'switchRuntime':
      return (request) =>
        capability.switchRuntime(parseNotebookLocalRpcRequest('switchRuntime', request))
  }
}

export {
  NOTEBOOK_LOCAL_RPC_METHODS,
  isNotebookLocalRpcMethod,
  opensNotebookInputRun,
  resolveNotebookLocalRpcHandler
}
export type { NotebookLocalRpcCapability, NotebookLocalRpcHandler, NotebookLocalRpcMethod }
