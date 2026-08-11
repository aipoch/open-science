import type {
  AddCustomServerRequest,
  ApprovalDecision,
  AuthenticateCustomServerRequest,
  ConnectorApprovalRequest,
  ConnectorDetailView,
  ConnectorView,
  CustomServerView,
  NcbiCredentialsView,
  SetNcbiCredentialsRequest,
  ToolPermission,
  UpdateCustomServerRequest
} from '../../../shared/settings'

type SettingsConnectorsProjection = {
  connectors: ConnectorView[]
  customServers: CustomServerView[]
  ncbi: NcbiCredentialsView
}

export type SettingsConnectorsState = SettingsConnectorsProjection & {
  pendingApprovals: ConnectorApprovalRequest[]
}

export type SettingsConnectorsActions = {
  loadConnectors: () => Promise<void>
  setConnectorEnabled: (id: string, enabled: boolean) => Promise<void>
  setConnectorAutoAllow: (id: string, autoAllow: boolean) => Promise<void>
  setToolPermission: (toolId: string, permission: ToolPermission) => Promise<ConnectorDetailView>
  setNcbiCredentials: (request: SetNcbiCredentialsRequest) => Promise<void>
  addCustomServer: (request: AddCustomServerRequest) => Promise<void>
  updateCustomServer: (request: UpdateCustomServerRequest) => Promise<void>
  authenticateCustomServer: (request: AuthenticateCustomServerRequest) => Promise<void>
  cancelCustomServerAuthentication: (request: AuthenticateCustomServerRequest) => Promise<void>
  retryCustomServer: (id: string) => Promise<void>
  setCustomServerEnabled: (id: string, enabled: boolean) => Promise<void>
  removeCustomServer: (id: string) => Promise<void>
  enqueueApproval: (request: ConnectorApprovalRequest) => void
  respondApproval: (id: string, decision: ApprovalDecision) => Promise<void>
}

type SettingsConnectorsCommands = Pick<
  Window['api']['settings'],
  | 'listConnectors'
  | 'setConnectorEnabled'
  | 'setConnectorAutoAllow'
  | 'setToolPermission'
  | 'setNcbiCredentials'
  | 'addCustomServer'
  | 'updateCustomServer'
  | 'authenticateCustomServer'
  | 'cancelCustomServerAuthentication'
  | 'retryCustomServer'
  | 'onConnectorRuntimeChanged'
  | 'setCustomServerEnabled'
  | 'removeCustomServer'
  | 'respondConnectorApproval'
>

type SettingsConnectorsSliceOptions = {
  setState: (
    patch:
      | Partial<SettingsConnectorsState>
      | ((state: SettingsConnectorsState) => Partial<SettingsConnectorsState>)
  ) => void
  getCommands: () => SettingsConnectorsCommands
}

export const createInitialSettingsConnectorsState = (): SettingsConnectorsState => ({
  connectors: [],
  customServers: [],
  pendingApprovals: [],
  ncbi: { hasApiKey: false }
})

// Owns the renderer projection for Connector catalogs, custom servers, NCBI credentials, and the
// approval queue. Main remains authoritative for every catalog mutation and trust decision.
export const createSettingsConnectorsSlice = ({
  setState,
  getCommands
}: SettingsConnectorsSliceOptions): SettingsConnectorsActions => {
  let reconcileGeneration = 0
  const reconcile = async (command: () => Promise<SettingsConnectorsProjection>): Promise<void> => {
    const generation = ++reconcileGeneration
    const projection = await command()
    if (generation === reconcileGeneration) setState(projection)
  }
  let mutationsInFlight = 0
  let runtimeRefreshPending = false
  const reconcileRuntimeChange = (): void => {
    if (mutationsInFlight > 0) {
      runtimeRefreshPending = true
      return
    }
    void reconcile(() => getCommands().listConnectors()).catch(() => undefined)
  }
  const runMutation = async (mutation: () => Promise<void>): Promise<void> => {
    mutationsInFlight += 1
    try {
      await mutation()
    } finally {
      mutationsInFlight -= 1
      if (mutationsInFlight === 0 && runtimeRefreshPending) {
        runtimeRefreshPending = false
        reconcileRuntimeChange()
      }
    }
  }
  const reconcileMutation = (command: () => Promise<SettingsConnectorsProjection>): Promise<void> =>
    runMutation(() => reconcile(command))
  let removeRuntimeChangedListener: (() => void) | undefined
  const subscribeToRuntimeChanges = (): void => {
    removeRuntimeChangedListener ??= getCommands().onConnectorRuntimeChanged(() => {
      reconcileRuntimeChange()
    })
  }

  return {
    loadConnectors: () => {
      subscribeToRuntimeChanges()
      return reconcile(() => getCommands().listConnectors())
    },
    setConnectorEnabled: async (id, enabled) => {
      setState((state) => ({
        connectors: state.connectors.map((connector) =>
          connector.id === id ? { ...connector, enabled } : connector
        )
      }))
      await reconcileMutation(() => getCommands().setConnectorEnabled({ id, enabled }))
    },
    setConnectorAutoAllow: async (id, autoAllow) => {
      setState((state) => ({
        connectors: state.connectors.map((connector) =>
          connector.id === id ? { ...connector, autoAllow } : connector
        )
      }))
      await reconcileMutation(() => getCommands().setConnectorAutoAllow({ id, autoAllow }))
    },
    setToolPermission: async (toolId, permission) =>
      getCommands().setToolPermission({ toolId, permission }),
    setNcbiCredentials: (request) =>
      reconcileMutation(() => getCommands().setNcbiCredentials(request)),
    addCustomServer: (request) => reconcileMutation(() => getCommands().addCustomServer(request)),
    updateCustomServer: (request) =>
      reconcileMutation(() => getCommands().updateCustomServer(request)),
    authenticateCustomServer: (request) =>
      runMutation(async () => {
        try {
          await reconcile(() => getCommands().authenticateCustomServer(request))
        } catch (error) {
          // Authentication can invalidate stale tokens before failing. Refresh the projection so the
          // connector does not remain visibly "Connected" after main has cleared its credentials.
          await reconcile(() => getCommands().listConnectors()).catch(() => undefined)
          throw error
        }
      }),
    cancelCustomServerAuthentication: (request) =>
      getCommands().cancelCustomServerAuthentication(request),
    retryCustomServer: (id) => reconcileMutation(() => getCommands().retryCustomServer({ id })),
    setCustomServerEnabled: async (id, enabled) => {
      setState((state) => ({
        customServers: state.customServers.map((server) =>
          server.id === id ? { ...server, enabled } : server
        )
      }))
      await reconcileMutation(() => getCommands().setCustomServerEnabled({ id, enabled }))
    },
    removeCustomServer: (id) => reconcileMutation(() => getCommands().removeCustomServer({ id })),
    enqueueApproval: (request) => {
      setState((state) =>
        state.pendingApprovals.some(({ id }) => id === request.id)
          ? state
          : { pendingApprovals: [...state.pendingApprovals, request] }
      )
    },
    respondApproval: async (id, decision) => {
      setState((state) => ({
        pendingApprovals: state.pendingApprovals.filter((request) => request.id !== id)
      }))
      await getCommands().respondConnectorApproval({ id, decision })
    }
  }
}
