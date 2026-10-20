import { sideChatCommandContracts } from '../../shared/side-chat'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'
import type { SideChatCommandOwner } from './command-owner'

const sideChatApplicationCommands = {
  list: defineApplicationCommand<
    'side-chat:list',
    readonly [],
    Awaited<ReturnType<SideChatCommandOwner['list']>>
  >('side-chat:list', sideChatCommandContracts.list),
  start: defineApplicationCommand<
    'side-chat:start',
    Parameters<SideChatCommandOwner['start']>,
    Awaited<ReturnType<SideChatCommandOwner['start']>>
  >('side-chat:start', sideChatCommandContracts.start),
  send: defineApplicationCommand<'side-chat:send', Parameters<SideChatCommandOwner['send']>, void>(
    'side-chat:send',
    sideChatCommandContracts.send
  ),
  cancel: defineApplicationCommand<
    'side-chat:cancel',
    Parameters<SideChatCommandOwner['cancel']>,
    void
  >('side-chat:cancel', sideChatCommandContracts.cancel),
  close: defineApplicationCommand<
    'side-chat:close',
    Parameters<SideChatCommandOwner['close']>,
    void
  >('side-chat:close', sideChatCommandContracts.close)
} as const

export const sideChatApplicationCommandGroup = defineApplicationCommandGroup('side-chat', [
  sideChatApplicationCommands.list,
  sideChatApplicationCommands.start,
  sideChatApplicationCommands.send,
  sideChatApplicationCommands.cancel,
  sideChatApplicationCommands.close
] as const)

export function registerSideChatApplicationCommands(
  registrar: ApplicationCommandRegistrar,
  owner: SideChatCommandOwner
): ApplicationCommandInstallation {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(sideChatApplicationCommandGroup, {
      'side-chat:list': () => owner.list(),
      'side-chat:start': ({ args }) => owner.start(args[0]),
      'side-chat:send': ({ args }) => owner.send(args[0]),
      'side-chat:cancel': ({ args }) => owner.cancel(args[0]),
      'side-chat:close': ({ args }) => owner.close(args[0])
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}
