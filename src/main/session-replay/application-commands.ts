import { sessionReplayCommandContracts } from '../../shared/session-replay'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandRegistrar,
  type ApplicationCommandInstallation
} from '../application-command-router'
import type { SessionReplayService } from './service'

export type SessionReplayCommandOwner = Pick<
  SessionReplayService,
  | 'readObservationBindings'
  | 'setResearchMembership'
  | 'findDiscussion'
  | 'unlinkSession'
  | 'get'
  | 'list'
  | 'saveView'
  | 'saveSelectionSnapshot'
  | 'getSelectionSnapshot'
  | 'listSelectionSnapshots'
>
export const sessionReplayCommands = {
  readObservationBindings: defineApplicationCommand(
    'session-replay:read-observation-bindings',
    sessionReplayCommandContracts.readObservationBindings
  ),
  setResearchMembership: defineApplicationCommand(
    'session-replay:set-research-membership',
    sessionReplayCommandContracts.setResearchMembership
  ),
  findDiscussion: defineApplicationCommand(
    'session-replay:find-discussion',
    sessionReplayCommandContracts.findDiscussion
  ),
  unlinkSession: defineApplicationCommand(
    'session-replay:unlink-session',
    sessionReplayCommandContracts.unlinkSession
  ),
  get: defineApplicationCommand('session-replay:get', sessionReplayCommandContracts.get),
  list: defineApplicationCommand('session-replay:list', sessionReplayCommandContracts.list),
  saveView: defineApplicationCommand(
    'session-replay:save-view',
    sessionReplayCommandContracts.saveView
  ),
  saveSelectionSnapshot: defineApplicationCommand(
    'session-replay:save-selection-snapshot',
    sessionReplayCommandContracts.saveSelectionSnapshot
  ),
  getSelectionSnapshot: defineApplicationCommand(
    'session-replay:get-selection-snapshot',
    sessionReplayCommandContracts.getSelectionSnapshot
  ),
  listSelectionSnapshots: defineApplicationCommand(
    'session-replay:list-selection-snapshots',
    sessionReplayCommandContracts.listSelectionSnapshots
  )
}
export const sessionReplayCommandGroup = defineApplicationCommandGroup(
  'session-replay',
  Object.values(sessionReplayCommands)
)
export const registerSessionReplayCommands = (
  registrar: ApplicationCommandRegistrar,
  owner: SessionReplayCommandOwner
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(sessionReplayCommandGroup, {
      'session-replay:read-observation-bindings': ({ args }) =>
        owner.readObservationBindings(args[0]),
      'session-replay:set-research-membership': ({ args }) => owner.setResearchMembership(args[0]),
      'session-replay:find-discussion': ({ args }) => owner.findDiscussion(args[0]),
      'session-replay:unlink-session': ({ args }) => owner.unlinkSession(args[0]),
      'session-replay:get': ({ args }) => owner.get(args[0]),
      'session-replay:list': ({ args }) => owner.list(args[0]),
      'session-replay:save-view': ({ args }) => owner.saveView(args[0]),
      'session-replay:save-selection-snapshot': ({ args }) => owner.saveSelectionSnapshot(args[0]),
      'session-replay:get-selection-snapshot': ({ args }) => owner.getSelectionSnapshot(args[0]),
      'session-replay:list-selection-snapshots': ({ args }) => owner.listSelectionSnapshots(args[0])
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}
