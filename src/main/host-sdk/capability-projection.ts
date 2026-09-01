const HOST_CAPABILITY_BASE_KEYS = [
  'mcp',
  'compute',
  'agents',
  'skills',
  'artifacts',
  'lineage',
  'frames',
  'sessions',
  'llm',
  'currentModel',
  'listModels',
  'viewImage'
] as const

const HOST_CAPABILITY_OPERATION_KEYS = [
  'children',
  'collect',
  'delegate',
  'messageReceipt',
  'resolveMessage',
  'sendFrameMessage',
  'stopChild',
  'submitOutput'
] as const

const HOST_CAPABILITY_KEYS = Object.freeze([
  ...HOST_CAPABILITY_BASE_KEYS,
  ...HOST_CAPABILITY_OPERATION_KEYS
])

type HostCapabilityBaseKey = (typeof HOST_CAPABILITY_BASE_KEYS)[number]
type HostCapabilityOperationKey = (typeof HOST_CAPABILITY_OPERATION_KEYS)[number]
type HostCapabilityKey = (typeof HOST_CAPABILITY_KEYS)[number]
type HostCapabilityProjection = Readonly<Record<HostCapabilityKey, boolean>>

type HostCapabilityProjectionContext = Readonly<{
  callerRole: 'main' | 'delegate'
  isControl: boolean
  hasActiveControlInvocation: boolean
  hasWorkspace: boolean
  allowsMethod(method: string): boolean
  delegatedWorkReady: boolean
  delegationAllowed: boolean
  services: Readonly<{
    mcp: boolean
    compute: boolean
    agents: boolean
    skills: boolean
    artifacts: boolean
    lineage: boolean
    frames: boolean
    sessions: boolean
    llm: boolean
    currentModel: boolean
    listModels: boolean
    viewImage: boolean
    delegate: boolean
    children: boolean
    collect: boolean
    stopChild: boolean
    sendFrameMessage: boolean
    messageReceipt: boolean
    resolveMessage: boolean
    submitOutput: boolean
  }>
}>

const rootOnly = (context: HostCapabilityProjectionContext, available: boolean): boolean =>
  context.callerRole === 'main' && context.delegatedWorkReady && available

const communication = (context: HostCapabilityProjectionContext, available: boolean): boolean =>
  context.delegatedWorkReady && available

const projectHostCapabilities = (
  context: HostCapabilityProjectionContext
): HostCapabilityProjection => {
  const allows = (method: string): boolean => context.allowsMethod(method)
  const routeReady = context.delegatedWorkReady && allows('delegatedWorkCall')

  return Object.freeze({
    mcp: allows('mcpCall') && context.services.mcp,
    compute: allows('computeCall') && context.services.compute,
    agents: allows('agentsCall') && context.services.agents,
    skills: allows('skillsCall') && context.services.skills,
    artifacts: allows('artifactsCall') && context.services.artifacts,
    lineage: allows('lineageCall') && context.services.lineage,
    frames: context.isControl && allows('framesCall') && context.services.frames,
    sessions:
      context.callerRole === 'main' &&
      context.isControl &&
      allows('sessionsCall') &&
      context.services.sessions,
    llm: context.isControl && allows('llmCall') && context.services.llm,
    currentModel: context.isControl && allows('currentModelCall') && context.services.currentModel,
    listModels: context.isControl && allows('listModelsCall') && context.services.listModels,
    viewImage:
      context.isControl &&
      context.hasActiveControlInvocation &&
      context.hasWorkspace &&
      allows('viewImageCall') &&
      context.services.viewImage,
    delegate:
      context.delegationAllowed && routeReady && rootOnly(context, context.services.delegate),
    children: routeReady && rootOnly(context, context.services.children),
    collect: routeReady && rootOnly(context, context.services.collect),
    stopChild: routeReady && rootOnly(context, context.services.stopChild),
    sendFrameMessage: routeReady && communication(context, context.services.sendFrameMessage),
    messageReceipt: routeReady && communication(context, context.services.messageReceipt),
    resolveMessage: routeReady && rootOnly(context, context.services.resolveMessage),
    submitOutput:
      context.callerRole === 'delegate' &&
      context.delegatedWorkReady &&
      allows('delegatedOutputCall') &&
      context.services.submitOutput
  })
}

export {
  HOST_CAPABILITY_BASE_KEYS,
  HOST_CAPABILITY_KEYS,
  HOST_CAPABILITY_OPERATION_KEYS,
  projectHostCapabilities
}
export type {
  HostCapabilityBaseKey,
  HostCapabilityKey,
  HostCapabilityOperationKey,
  HostCapabilityProjection,
  HostCapabilityProjectionContext
}
