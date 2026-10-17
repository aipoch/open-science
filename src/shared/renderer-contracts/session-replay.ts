import type { PersistedChatSession } from '../session-persistence'
import type {
  SetResearchMembershipRequest,
  UnlinkSessionReadingRequest,
  SessionReplayRequest,
  SessionDiscussionMatch,
  SessionReplayListRequest,
  SessionReplaySnapshot,
  SaveSessionReplayProgressRequest,
  SaveSessionReplayProgressResult,
  SessionDiscussionSnapshot,
  SaveSessionDiscussionSnapshotRequest,
  GetSessionDiscussionSnapshotRequest
} from '../session-replay'
import { callable, WEB, RUNTIME_VALIDATED } from './definition'

export const contracts = {
  'sessionReplay.setResearchMembership': callable<
    (request: SetResearchMembershipRequest) => Promise<PersistedChatSession>
  >()('session-replay', [
    'session-replay:set-research-membership',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'sessionReplay.findDiscussion': callable<
    (request: SessionReplayRequest) => Promise<SessionDiscussionMatch>
  >()('session-replay', [
    'session-replay:find-discussion',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'sessionReplay.unlinkSession': callable<
    (request: UnlinkSessionReadingRequest) => Promise<void>
  >()('session-replay', [
    'session-replay:unlink-session',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'sessionReplay.get': callable<
    (request: SessionReplayRequest) => Promise<SessionReplaySnapshot>
  >()('session-replay', ['session-replay:get', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'sessionReplay.list': callable<
    (request: SessionReplayListRequest) => Promise<SessionReplaySnapshot[]>
  >()('session-replay', ['session-replay:list', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'sessionReplay.saveView': callable<
    (request: SaveSessionReplayProgressRequest) => Promise<SaveSessionReplayProgressResult>
  >()('session-replay', ['session-replay:save-view', WEB, undefined, undefined, RUNTIME_VALIDATED]),
  'sessionReplay.saveSelectionSnapshot': callable<
    (request: SaveSessionDiscussionSnapshotRequest) => Promise<void>
  >()('session-replay', [
    'session-replay:save-selection-snapshot',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'sessionReplay.getSelectionSnapshot': callable<
    (request: GetSessionDiscussionSnapshotRequest) => Promise<SessionDiscussionSnapshot | undefined>
  >()('session-replay', [
    'session-replay:get-selection-snapshot',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ]),
  'sessionReplay.listSelectionSnapshots': callable<
    (request: SessionReplayRequest) => Promise<SessionDiscussionSnapshot[]>
  >()('session-replay', [
    'session-replay:list-selection-snapshots',
    WEB,
    undefined,
    undefined,
    RUNTIME_VALIDATED
  ])
} as const
