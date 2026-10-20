import type { ApplicationInvocation } from './application-command-router'
import type { RemoteAccessCommandPort } from './remote-access/command-port'

export type RemoteAccessOwner = RemoteAccessCommandPort

export type ApplicationCommandByNameDispatcher = Readonly<{
  invoke: (
    commandName: string,
    invocation: ApplicationInvocation<readonly unknown[]>
  ) => Promise<unknown>
  commandNames: () => readonly string[]
}>

export type RemoteWebApplicationCommandDispatcher = ApplicationCommandByNameDispatcher &
  Readonly<{ rejectedCommandNames: () => readonly string[] }>

export type ApplicationCommandComposition = Readonly<{
  desktop: ApplicationCommandByNameDispatcher
  electron: ApplicationCommandByNameDispatcher
  localWeb: ApplicationCommandByNameDispatcher
  remoteWeb: RemoteWebApplicationCommandDispatcher
  task: ApplicationCommandByNameDispatcher
  bindRemoteAccess: (owner: RemoteAccessOwner) => void
  dispose: () => Promise<void>
}>
