export type RendererContractKind = 'method' | 'event'

export type RendererParameterCodec =
  | 'positional'
  | 'default-empty-object'
  | 'storage-parent-object'
  | 'storage-data-root-object'
  | 'runtime-selection-object'
  | 'runtime-language-environment-object'
  | 'runtime-language-object'
  | 'runtime-enablement-object'
  | 'runtime-install-authorization-object'
  | 'runtime-interpreter-path-object'
  | 'session-save-optional-argument'
  | 'session-save-json-undefined'
  | 'event-listener'
  | 'surface-native'

export type RendererSurfaceInstallation =
  'preload' | 'web-rpc' | 'web-event' | 'browser-native' | 'rejecting-stub' | 'unavailable'

export type RendererDispatchPolicy =
  | 'electron-ipc-request'
  | 'electron-ipc-send'
  | 'electron-ipc-subscription'
  | 'captured-ipc-request'
  | 'web-event-subscription'
  | 'surface-native'
  | 'rejecting-stub'
  | 'none'

export type RendererEventDeliverability =
  'not-event' | 'electron-ipc' | 'application-event' | 'installed-undelivered' | 'unavailable'

export type RendererAuthorityFlow = 'electron-sender' | 'caller-context' | 'none'
export type RendererMapProjection = 'invoke' | 'event' | 'none'

export type RendererSurfaceProfile<Value> = Readonly<{
  electron: Value
  localWeb: Value
  remoteWeb: Value
}>

export type RendererParameterCodecProfile = Readonly<{
  electron: RendererParameterCodec
  web: RendererParameterCodec
}>

export type RendererContractSeed = Readonly<{
  publicPath: string
  channel: string | null
  kind: RendererContractKind
  parameterCodec: RendererParameterCodecProfile
  surfaceInstallation: RendererSurfaceProfile<RendererSurfaceInstallation>
  dispatchPolicy: RendererSurfaceProfile<RendererDispatchPolicy>
  eventDeliverability: RendererSurfaceProfile<RendererEventDeliverability>
  authorityFlow: RendererSurfaceProfile<RendererAuthorityFlow>
  mapProjection: RendererMapProjection
}>

export type RendererContractDescriptor = Readonly<RendererContractSeed & { capability: string }>

export type RendererContractGroup = Readonly<{
  capability: string
  contracts: readonly RendererContractDescriptor[]
}>

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

const freezeContract = (
  capability: string,
  seed: RendererContractSeed
): RendererContractDescriptor =>
  Object.freeze({
    ...seed,
    capability,
    parameterCodec: Object.freeze({ ...seed.parameterCodec }),
    surfaceInstallation: Object.freeze({ ...seed.surfaceInstallation }),
    dispatchPolicy: Object.freeze({ ...seed.dispatchPolicy }),
    eventDeliverability: Object.freeze({ ...seed.eventDeliverability }),
    authorityFlow: Object.freeze({ ...seed.authorityFlow })
  })

export const defineRendererContractGroup = (
  capability: string,
  seeds: readonly RendererContractSeed[]
): RendererContractGroup => {
  if (!capability) throw new Error('Renderer contract capability must not be empty.')
  return Object.freeze({
    capability,
    contracts: Object.freeze(seeds.map((seed) => freezeContract(capability, seed)))
  })
}

export const composeRendererContractCatalog = (
  groups: readonly RendererContractGroup[]
): readonly RendererContractDescriptor[] => {
  const capabilities = new Set<string>()
  const paths = new Set<string>()
  const channels = new Set<string>()
  const catalog: RendererContractDescriptor[] = []

  for (const group of groups) {
    if (capabilities.has(group.capability)) {
      throw new Error(`Duplicate renderer contract capability: ${group.capability}`)
    }
    capabilities.add(group.capability)
    for (const contract of group.contracts) {
      if (paths.has(contract.publicPath)) {
        throw new Error(`Duplicate renderer contract path: ${contract.publicPath}`)
      }
      if (contract.channel !== null && channels.has(contract.channel)) {
        throw new Error(`Duplicate renderer contract channel: ${contract.channel}`)
      }
      if (contract.mapProjection !== 'none' && contract.channel === null) {
        throw new Error(`Projected renderer contract has no channel: ${contract.publicPath}`)
      }
      paths.add(contract.publicPath)
      if (contract.channel !== null) channels.add(contract.channel)
      catalog.push(contract)
    }
  }

  return Object.freeze(
    catalog.sort((left, right) => compareText(left.publicPath, right.publicPath))
  )
}

export const projectRendererContractMaps = (
  catalog: readonly RendererContractDescriptor[]
): Readonly<{
  invoke: Readonly<Record<string, string>>
  event: Readonly<Record<string, string>>
}> => {
  const invoke: Record<string, string> = {}
  const event: Record<string, string> = {}

  for (const contract of catalog) {
    if (contract.mapProjection === 'none' || contract.channel === null) continue
    const target = contract.mapProjection === 'invoke' ? invoke : event
    target[contract.publicPath] = contract.channel
  }

  return Object.freeze({ invoke: Object.freeze(invoke), event: Object.freeze(event) })
}
