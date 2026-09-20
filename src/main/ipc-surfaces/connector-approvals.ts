import type {
  ConversationSkillImportApprovalResponse,
  RespondApprovalRequest,
  RespondConnectorCredentialRequest
} from '../../shared/settings'
import type { ApprovalBroker } from '../connectors/approval-broker'
import type { CredentialRequestBroker } from '../connectors/credential-request-broker'
import { ipcMainHandle } from '../ipc-handler-registry'
import type { NamedElectronSurfaceAdapter } from '../runtime-electron-wiring'
import type { SkillImportApprovalBroker } from '../skills/conversation-import'
import { createElectronSurfaceAdapter } from './adapter'

// The surface owns only the handlers; pending requests remain owned by ConnectorApplication.
export const createConnectorApprovalElectronSurface = (
  approvalBroker: Pick<ApprovalBroker, 'respond' | 'getPending' | 'replayPending'>,
  credentialRequestBroker: Pick<CredentialRequestBroker, 'respond' | 'replayPending'>,
  skillImportApprovalBroker: Pick<SkillImportApprovalBroker, 'respond' | 'replayPending'>
): NamedElectronSurfaceAdapter =>
  createElectronSurfaceAdapter('connector-approvals', () => {
    ipcMainHandle('connectors:approval-respond', (_event, request: RespondApprovalRequest) => {
      approvalBroker.respond(request.id, request.decision)
    })
    ipcMainHandle('connectors:approval-replay', (_event, id: unknown) =>
      typeof id === 'string' ? approvalBroker.getPending(id) : null
    )
    ipcMainHandle('connectors:approval-replay-pending', () => approvalBroker.replayPending())
    ipcMainHandle(
      'connectors:credential-respond',
      (_event, request: RespondConnectorCredentialRequest) =>
        credentialRequestBroker.respond(request.id, request.configured)
    )
    ipcMainHandle('connectors:credential-replay-pending', () =>
      credentialRequestBroker.replayPending()
    )
    ipcMainHandle(
      'skills:conversation-import-respond',
      (_event, response: ConversationSkillImportApprovalResponse) => {
        skillImportApprovalBroker.respond(response)
      }
    )
    ipcMainHandle('skills:conversation-import-replay-pending', () => {
      skillImportApprovalBroker.replayPending()
    })
  })
