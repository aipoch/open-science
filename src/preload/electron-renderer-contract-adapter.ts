import { RENDERER_CONTRACT_CATALOG } from '../shared/renderer-contract-catalog'
import { unwrapApplicationCommandOutcome } from '../shared/application-command-contract'
import type {
  RendererContractDescriptor,
  RendererParameterCodec
} from '../shared/renderer-contract'

type ElectronIpcListener = (event: unknown, payload: unknown) => void

export type ElectronRendererContractPort = Readonly<{
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  send: (channel: string, ...args: unknown[]) => void
  on: (channel: string, listener: ElectronIpcListener) => void
  removeListener: (channel: string, listener: ElectronIpcListener) => void
  getPathForFile: (file: unknown) => string
}>

export type ElectronRendererContractAdapter = Readonly<{
  invoke: <Result>(publicPath: string, ...args: unknown[]) => Promise<Result>
  send: (publicPath: string, ...args: unknown[]) => void
  subscribe: <Payload>(publicPath: string, listener: (payload: Payload) => void) => () => void
}>

type ElectronRendererRequestContract = Readonly<{
  contract: RendererContractDescriptor
  channel: string
}>

const contractsByPath = new Map(
  RENDERER_CONTRACT_CATALOG.map((contract) => [contract.publicPath, contract] as const)
)

const rejectLifecycleDispatch = (
  contract: RendererContractDescriptor | undefined,
  publicPath: string
): void => {
  if (contract?.lifecycleDispatch != null) {
    throw new Error(
      `Renderer contract requires dedicated Electron lifecycle dispatch: ${publicPath}`
    )
  }
}

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
  rejectLifecycleDispatch(contract, publicPath)
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

const requireSendContract = (publicPath: string): string => {
  const contract = contractsByPath.get(publicPath)
  rejectLifecycleDispatch(contract, publicPath)
  const channel = contract?.channel
  if (
    contract?.surfaceInstallation.electron !== 'preload' ||
    contract.kind !== 'method' ||
    contract.dispatchPolicy.electron !== 'electron-ipc-send' ||
    channel == null
  ) {
    throw new Error(`Renderer contract is not an Electron IPC send: ${publicPath}`)
  }
  return channel
}

const encodeRequestArguments = (
  codec: RendererParameterCodec,
  args: unknown[],
  getPathForFile: (file: unknown) => string
): unknown[] | null => {
  switch (codec) {
    case 'positional':
      return args
    case 'default-empty-object':
      return args[0] === undefined ? [{}] : args
    case 'optional-argument-slot':
      return args.length === 0 ? [undefined] : args
    case 'session-save-optional-argument':
      return args[1] ? args : args.slice(0, 1)
    case 'storage-parent-object':
      return [{ parent: args[0] }]
    case 'storage-data-root-object':
      return [{ parent: args[0], markOnboarding: args[1] }]
    case 'native-file-upload-request': {
      const sourcePath = getPathForFile(args[0])
      return sourcePath ? [{ ...(args[1] as object), sourcePath }] : null
    }
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
    const encodedArgs = encodeRequestArguments(
      contract.parameterCodec.electron,
      args,
      port.getPathForFile
    )
    if (encodedArgs === null) return null as Result
    const result = await port.invoke(channel, ...encodedArgs)
    return contract.applicationCommand === 'runtime-validated'
      ? unwrapApplicationCommandOutcome<Result>(result)
      : (result as Result)
  },
  send: (publicPath: string, ...args: unknown[]): void => {
    port.send(requireSendContract(publicPath), ...args)
  },
  subscribe: <Payload>(publicPath: string, listener: (payload: Payload) => void): (() => void) => {
    const channel = requireEventContract(publicPath)
    const wrappedListener: ElectronIpcListener = (_event, payload) => listener(payload as Payload)
    port.on(channel, wrappedListener)
    return () => port.removeListener(channel, wrappedListener)
  }
})
