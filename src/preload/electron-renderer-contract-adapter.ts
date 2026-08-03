import { RENDERER_CONTRACT_CATALOG } from '../shared/renderer-contract-catalog'
import type {
  RendererContractDescriptor,
  RendererParameterCodec
} from '../shared/renderer-contract'

type ElectronIpcListener = (event: unknown, payload: unknown) => void

export type ElectronRendererContractPort = Readonly<{
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, listener: ElectronIpcListener) => void
  removeListener: (channel: string, listener: ElectronIpcListener) => void
}>

export type ElectronRendererContractAdapter = Readonly<{
  invoke: <Result>(publicPath: string, ...args: unknown[]) => Promise<Result>
  subscribe: <Payload>(publicPath: string, listener: (payload: Payload) => void) => () => void
}>

type ElectronRendererRequestContract = Readonly<{
  contract: RendererContractDescriptor
  channel: string
}>

const contractsByPath = new Map(
  RENDERER_CONTRACT_CATALOG.map((contract) => [contract.publicPath, contract] as const)
)

const requireRequestContract = (publicPath: string): ElectronRendererRequestContract => {
  const contract = contractsByPath.get(publicPath)
  const channel = contract?.channel
  if (
    contract?.surfaceInstallation.electron !== 'preload' ||
    contract.kind !== 'method' ||
    contract.dispatchPolicy.electron !== 'electron-ipc-request' ||
    channel == null
  ) {
    throw new Error(`Renderer contract is not an Electron IPC request: ${publicPath}`)
  }
  return { contract, channel }
}

const requireEventContract = (publicPath: string): string => {
  const contract = contractsByPath.get(publicPath)
  const channel = contract?.channel
  if (
    contract?.surfaceInstallation.electron !== 'preload' ||
    contract.kind !== 'event' ||
    contract.dispatchPolicy.electron !== 'electron-ipc-subscription' ||
    channel == null
  ) {
    throw new Error(`Renderer contract is not an Electron IPC event: ${publicPath}`)
  }
  return channel
}

const encodeRequestArguments = (codec: RendererParameterCodec, args: unknown[]): unknown[] => {
  switch (codec) {
    case 'positional':
      return args
    case 'default-empty-object':
      return args[0] === undefined ? [{}] : args
    case 'optional-argument-slot':
      return args.length === 0 ? [undefined] : args
    case 'runtime-selection-object':
      return [{ language: args[0], selection: args[1] }]
    case 'runtime-language-environment-object':
      return [{ language: args[0], envId: args[1] }]
    case 'runtime-language-object':
      return [{ language: args[0] }]
    case 'runtime-enablement-object':
      return [{ language: args[0], envId: args[1], enabled: args[2], force: args[3] }]
    case 'runtime-install-authorization-object':
      return [{ language: args[0], envId: args[1], authorized: args[2] }]
    case 'runtime-interpreter-path-object':
      return [{ language: args[0], path: args[1] }]
    default:
      throw new Error(`Unsupported Electron request codec: ${codec}`)
  }
}

export const createElectronRendererContractAdapter = (
  port: ElectronRendererContractPort
): ElectronRendererContractAdapter => ({
  invoke: async <Result>(publicPath: string, ...args: unknown[]): Promise<Result> => {
    const { contract, channel } = requireRequestContract(publicPath)
    const encodedArgs = encodeRequestArguments(contract.parameterCodec.electron, args)
    return (await port.invoke(channel, ...encodedArgs)) as Result
  },
  subscribe: <Payload>(publicPath: string, listener: (payload: Payload) => void): (() => void) => {
    const channel = requireEventContract(publicPath)
    const wrappedListener: ElectronIpcListener = (_event, payload) => listener(payload as Payload)
    port.on(channel, wrappedListener)
    return () => port.removeListener(channel, wrappedListener)
  }
})
