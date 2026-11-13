import { notebookNetworkAudit } from './notebook/network-audit'
import { resolveConfigRoot } from './storage-root'
import type {
  NotebookNetworkAuditQuery,
  NotebookNetworkAuditPage
} from '../shared/notebook-network-audit'
import { ipcMainHandle } from './ipc-handler-registry'

import { startDiagnosticOperation } from '@aipoch/diagnostics/node'
import { createLogger, type Logger } from '@aipoch/diagnostics/node'
import { checkInternetReachability, getNetworkInfo } from './net/network-info'

import type { NetworkInfo } from '../shared/network'

type NetworkCommandOwner = Readonly<{
  queryNotebookLogs: (query: NotebookNetworkAuditQuery) => Promise<NotebookNetworkAuditPage>
  setNotebookLogRetention: (days: number) => Promise<number>
  getInfo: () => Promise<NetworkInfo>
  checkConnectivity: () => Promise<boolean>
}>

type NetworkIpcDiagnostics = Readonly<{
  log?: Logger
  now?: () => number
}>

// Network status for the settings Network panel. getInfo answers from local OS state (no
// internet required); checkConnectivity is a real end-to-end HTTPS probe reused from the
// onboarding environment check, so it can tell "internet broken" apart from "link is up".
const createNetworkCommandOwner = (): NetworkCommandOwner => ({
  queryNotebookLogs: (query) => notebookNetworkAudit(resolveConfigRoot()).query(query),
  setNotebookLogRetention: (days) => notebookNetworkAudit(resolveConfigRoot()).setRetention(days),
  async getInfo() {
    const operation = startDiagnosticOperation(createLogger('network'), {
      operation: 'local-network-info'
    })
    try {
      const info = await getNetworkInfo()
      operation.complete({
        connectionType: info.connectionType,
        hasAddress: info.ipAddress !== null
      })
      return info
    } catch (error) {
      operation.fail(error)
      throw error
    }
  },
  checkConnectivity: checkInternetReachability
})

const registerNetworkIpcHandlers = (
  owner: NetworkCommandOwner = createNetworkCommandOwner(),
  diagnostics: NetworkIpcDiagnostics = {}
): NetworkCommandOwner => {
  const log = diagnostics.log ?? createLogger('network')
  ipcMainHandle('network:query-notebook-logs', (_event, query: NotebookNetworkAuditQuery) =>
    owner.queryNotebookLogs(query)
  )
  ipcMainHandle('network:set-notebook-log-retention', (_event, days: number) =>
    owner.setNotebookLogRetention(days)
  )
  ipcMainHandle('network:get-info', () => owner.getInfo())
  ipcMainHandle('network:check-connectivity', async () => {
    const operation = startDiagnosticOperation(log, {
      operation: 'connectivity-check',
      now: diagnostics.now
    })
    try {
      const reachable = await owner.checkConnectivity()
      operation.complete({ reachable })
      return reachable
    } catch (error) {
      operation.fail(error)
      throw error
    }
  })
  return owner
}

export type { NetworkCommandOwner }
export { registerNetworkIpcHandlers, createNetworkCommandOwner }
