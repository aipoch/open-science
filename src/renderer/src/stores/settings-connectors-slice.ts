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

import { createOptimisticBooleanCoordinator } from './settings-optimistic-boolean'

type SettingsConnectorsProjection = {
  connectors: ConnectorView[]
  customServers: CustomServerView[]
  reservedCustomServerIds?: string[]
  ncbi: NcbiCredentialsView
}

export type SettingsConnectorsState = SettingsConnectorsProjection & {
  connectorsLoaded: boolean
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
  dismissApproval: (id: string) => void
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
  getState: () => SettingsConnectorsState
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
  reservedCustomServerIds: [],
  connectorsLoaded: false,
  pendingApprovals: [],
  ncbi: { hasApiKey: false }
})

// Owns the renderer projection for Connector catalogs, custom servers, NCBI credentials, and the
// approval queue. Main remains authoritative for every catalog mutation and trust decision.
export const createSettingsConnectorsSlice = ({
  getState,
  setState,
  getCommands
}: SettingsConnectorsSliceOptions): SettingsConnectorsActions => {
  const toggleWrites = createOptimisticBooleanCoordinator()
  const connectorEnabledKey = (id: string): string => `connector:${id}:enabled`
  const connectorAutoAllowKey = (id: string): string => `connector:${id}:autoAllow`
  const customServerEnabledKey = (id: string): string => `custom-server:${id}:enabled`
  const projectOptimisticToggles = (
    projection: SettingsConnectorsProjection,
    generation: number
  ): SettingsConnectorsProjection => ({
    ...projection,
    reservedCustomServerIds: projection.reservedCustomServerIds ?? [],
    connectors: projection.connectors.map((connector) => ({
      ...connector,
      enabled: toggleWrites.project(
        connectorEnabledKey(connector.id),
        connector.enabled,
        generation
      ),
      autoAllow: toggleWrites.project(
        connectorAutoAllowKey(connector.id),
        connector.autoAllow,
        generation
      )
    })),
    customServers: projection.customServers.map((server) => ({
      ...server,
      enabled: toggleWrites.project(customServerEnabledKey(server.id), server.enabled, generation)
    }))
  })
  let reconcileGeneration = 0
  const reconcile = async (
    command: () => Promise<SettingsConnectorsProjection>
  ): Promise<SettingsConnectorsProjection> => {
    const generation = ++reconcileGeneration
    const projectionGeneration = toggleWrites.beginProjection()
    const projection = await command()
    if (generation === reconcileGeneration)
      setState({
        ...projectOptimisticToggles(projection, projectionGeneration),
        connectorsLoaded: true
      })
    return projection
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
  const runMutation = async <Result>(mutation: () => Promise<Result>): Promise<Result> => {
    mutationsInFlight += 1
    try {
      return await mutation()
    } finally {
      mutationsInFlight -= 1
      if (mutationsInFlight === 0 && runtimeRefreshPending) {
        runtimeRefreshPending = false
        reconcileRuntimeChange()
      }
    }
  }
  const reconcileMutation = async (
    command: () => Promise<SettingsConnectorsProjection>
  ): Promise<void> => {
    await runMutation(() => reconcile(command))
  }
  let removeRuntimeChangedListener: (() => void) | undefined
  let catalogLoadRequest: Promise<void> | undefined
  const subscribeToRuntimeChanges = (): void => {
    removeRuntimeChangedListener ??= getCommands().onConnectorRuntimeChanged(() => {
      reconcileRuntimeChange()
    })
  }

  return {
    loadConnectors: () => {
      subscribeToRuntimeChanges()
      if (getState().connectorsLoaded) return Promise.resolve()
      if (catalogLoadRequest) return catalogLoadRequest
      const request = reconcile(() => getCommands().listConnectors()).then(() => undefined)
      const trackedRequest = request.finally(() => {
        if (catalogLoadRequest === trackedRequest) catalogLoadRequest = undefined
      })
      catalogLoadRequest = trackedRequest
      return trackedRequest
    },
    setConnectorEnabled: async (id, enabled) => {
      const key = connectorEnabledKey(id)
      let confirmed: boolean | undefined
      setState((state) => ({
        connectors: state.connectors.map((connector) => {
          if (connector.id !== id) return connector
          confirmed = connector.enabled
          return { ...connector, enabled }
        })
      }))
      if (confirmed === undefined) {
        await reconcileMutation(() => getCommands().setConnectorEnabled({ id, enabled }))
        return
      }

      const token = toggleWrites.begin(key, confirmed, enabled)
      try {
        const projection = await runMutation(() =>
          reconcile(() => getCommands().setConnectorEnabled({ id, enabled }))
        )
        const authoritative =
          projection.connectors.find((connector) => connector.id === id)?.enabled ?? confirmed
        const projected = toggleWrites.succeed(token, authoritative)
        setState((state) => ({
          connectors: state.connectors.map((connector) =>
            connector.id === id ? { ...connector, enabled: projected } : connector
          )
        }))
      } catch (error) {
        const projected = toggleWrites.fail(token)
        setState((state) => ({
          connectors: state.connectors.map((connector) =>
            connector.id === id ? { ...connector, enabled: projected } : connector
          )
        }))
        throw error
      }
    },
    setConnectorAutoAllow: async (id, autoAllow) => {
      const key = connectorAutoAllowKey(id)
      let confirmed: boolean | undefined
      setState((state) => ({
        connectors: state.connectors.map((connector) => {
          if (connector.id !== id) return connector
          confirmed = connector.autoAllow
          return { ...connector, autoAllow }
        })
      }))
      if (confirmed === undefined) {
        await reconcileMutation(() => getCommands().setConnectorAutoAllow({ id, autoAllow }))
        return
      }

      const token = toggleWrites.begin(key, confirmed, autoAllow)
      try {
        const projection = await runMutation(() =>
          reconcile(() => getCommands().setConnectorAutoAllow({ id, autoAllow }))
        )
        const authoritative =
          projection.connectors.find((connector) => connector.id === id)?.autoAllow ?? confirmed
        const projected = toggleWrites.succeed(token, authoritative)
        setState((state) => ({
          connectors: state.connectors.map((connector) =>
            connector.id === id ? { ...connector, autoAllow: projected } : connector
          )
        }))
      } catch (error) {
        const projected = toggleWrites.fail(token)
        setState((state) => ({
          connectors: state.connectors.map((connector) =>
            connector.id === id ? { ...connector, autoAllow: projected } : connector
          )
        }))
        throw error
      }
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
      const key = customServerEnabledKey(id)
      let confirmed: boolean | undefined
      setState((state) => ({
        customServers: state.customServers.map((server) => {
          if (server.id !== id) return server
          confirmed = server.enabled
          return { ...server, enabled }
        })
      }))
      if (confirmed === undefined) {
        await reconcileMutation(() => getCommands().setCustomServerEnabled({ id, enabled }))
        return
      }

      const token = toggleWrites.begin(key, confirmed, enabled)
      try {
        const projection = await runMutation(() =>
          reconcile(() => getCommands().setCustomServerEnabled({ id, enabled }))
        )
        const authoritative =
          projection.customServers.find((server) => server.id === id)?.enabled ?? confirmed
        const projected = toggleWrites.succeed(token, authoritative)
        setState((state) => ({
          customServers: state.customServers.map((server) =>
            server.id === id ? { ...server, enabled: projected } : server
          )
        }))
      } catch (error) {
        const projected = toggleWrites.fail(token)
        setState((state) => ({
          customServers: state.customServers.map((server) =>
            server.id === id ? { ...server, enabled: projected } : server
          )
        }))
        throw error
      }
    },
    removeCustomServer: (id) => reconcileMutation(() => getCommands().removeCustomServer({ id })),
    enqueueApproval: (request) => {
      setState((state) =>
        state.pendingApprovals.some(({ id }) => id === request.id)
          ? state
          : { pendingApprovals: [...state.pendingApprovals, request] }
      )
    },
    dismissApproval: (id) => {
      setState((state) => ({
        pendingApprovals: state.pendingApprovals.filter((request) => request.id !== id)
      }))
    },
    respondApproval: async (id, decision) => {
      await getCommands().respondConnectorApproval({ id, decision })
      setState((state) => ({
        pendingApprovals: state.pendingApprovals.filter((request) => request.id !== id)
      }))
    }
  }
}
