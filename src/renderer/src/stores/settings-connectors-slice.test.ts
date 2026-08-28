import { createStore, type StoreApi } from 'zustand/vanilla'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ConnectorApprovalRequest,
  ConnectorDetailView,
  ConnectorView,
  ConnectorsSnapshot,
  CustomServerView
} from '../../../shared/settings'
import {
  createInitialSettingsConnectorsState,
  createSettingsConnectorsSlice,
  type SettingsConnectorsActions,
  type SettingsConnectorsState
} from './settings-connectors-slice'

type TestStore = SettingsConnectorsState & SettingsConnectorsActions
type ConnectorCommands = Parameters<
  typeof createSettingsConnectorsSlice
>[0]['getCommands'] extends () => infer T
  ? T
  : never

const connector = (
  id: string,
  { enabled = true, autoAllow = false }: { enabled?: boolean; autoAllow?: boolean } = {}
): ConnectorView => ({
  id,
  name: id,
  displayName: id,
  description: `${id} description`,
  sources: [],
  requiresNcbi: false,
  enabled,
  autoAllow,
  group: 'featured'
})

const server = (id: string, enabled = true): CustomServerView => ({
  id,
  name: id,
  displayName: id,
  transport: 'stdio',
  enabled,
  command: 'npx'
})

const snapshot = (
  connectors: ConnectorView[] = [],
  customServers: CustomServerView[] = []
): ConnectorsSnapshot => ({ connectors, customServers, ncbi: { hasApiKey: false } })

const detail: ConnectorDetailView = {
  ...connector('pubmed'),
  useWhen: 'searching PubMed',
  tools: []
}

const createCommands = (): ConnectorCommands => ({
  listConnectors: vi.fn(async () => snapshot()),
  setConnectorEnabled: vi.fn(async () => snapshot()),
  setConnectorAutoAllow: vi.fn(async () => snapshot()),
  setToolPermission: vi.fn(async () => detail),
  setNcbiCredentials: vi.fn(async () => snapshot()),
  setOpenAlexCredential: vi.fn(async () => snapshot()),
  validateOpenAlexCredential: vi.fn(async () => ({ valid: true as const })),
  addCustomServer: vi.fn(async () => snapshot()),
  updateCustomServer: vi.fn(async () => snapshot()),
  authenticateCustomServer: vi.fn(async () => snapshot()),
  retryCustomServer: vi.fn(async () => snapshot()),
  onConnectorRuntimeChanged: vi.fn(() => () => undefined),
  cancelCustomServerAuthentication: vi.fn(async () => undefined),
  setCustomServerEnabled: vi.fn(async () => snapshot()),
  removeCustomServer: vi.fn(async () => snapshot()),
  respondConnectorApproval: vi.fn(async () => undefined),
  respondConnectorCredentialRequest: vi.fn(async () => undefined)
})

const createHarness = (
  commands: ConnectorCommands
): { store: StoreApi<TestStore>; commands: ConnectorCommands } => {
  const store = createStore<TestStore>((set, get) => ({
    ...createInitialSettingsConnectorsState(),
    ...createSettingsConnectorsSlice({
      getState: get,
      setState: (patch) => set(patch),
      getCommands: () => commands
    })
  }))

  return { store, commands }
}

describe('settings Connectors slice', () => {
  let store: StoreApi<TestStore>
  let commands: ConnectorCommands

  beforeEach(() => {
    ;({ store, commands } = createHarness(createCommands()))
  })

  it('loads the authoritative Connector, custom-server, and NCBI projection', async () => {
    const result: ConnectorsSnapshot = {
      ...snapshot([connector('pubmed')], [server('custom')]),
      reservedCustomServerIds: ['pending-delete'],
      ncbi: { contactEmail: 'science@example.test', hasApiKey: true }
    }
    vi.mocked(commands.listConnectors).mockResolvedValue(result)

    await store.getState().loadConnectors()

    expect(store.getState()).toMatchObject(result)
  })

  it('reuses the in-memory projection when the panel loads again', async () => {
    vi.mocked(commands.listConnectors).mockResolvedValue(snapshot([connector('pubmed')]))

    await store.getState().loadConnectors()
    await store.getState().loadConnectors()

    expect(commands.listConnectors).toHaveBeenCalledOnce()
    expect(store.getState().connectors).toEqual([connector('pubmed')])
  })

  it('deduplicates overlapping initial catalog loads', async () => {
    let settle!: (snapshot: ConnectorsSnapshot) => void
    vi.mocked(commands.listConnectors).mockReturnValue(
      new Promise((resolve) => {
        settle = resolve
      })
    )

    const first = store.getState().loadConnectors()
    const second = store.getState().loadConnectors()
    settle(snapshot([connector('pubmed')]))
    await Promise.all([first, second])

    expect(commands.listConnectors).toHaveBeenCalledOnce()
  })

  it('rejects a missing Settings command surface as a promise', async () => {
    const { store } = createHarness({
      ...createCommands(),
      onConnectorRuntimeChanged: () => {
        throw new Error('settings unavailable')
      }
    })

    const result = store.getState().loadConnectors()
    expect(result).toBeInstanceOf(Promise)
    await expect(result).rejects.toThrow('settings unavailable')
  })

  it('reloads the authoritative snapshot when runtime availability changes', async () => {
    let runtimeChanged: (() => void) | undefined
    const onConnectorRuntimeChanged = vi.fn((listener: () => void) => {
      runtimeChanged = listener
      return () => {
        runtimeChanged = undefined
      }
    })
    const runtimeCommands: ConnectorCommands = {
      ...createCommands(),
      onConnectorRuntimeChanged
    }
    ;({ store, commands } = createHarness(runtimeCommands))
    vi.mocked(commands.listConnectors)
      .mockResolvedValueOnce(snapshot([], [server('custom')]))
      .mockResolvedValueOnce(snapshot([], [{ ...server('custom'), availability: 'unavailable' }]))

    await store.getState().loadConnectors()
    runtimeChanged?.()

    await vi.waitFor(() =>
      expect(store.getState().customServers).toEqual([
        { ...server('custom'), availability: 'unavailable' }
      ])
    )
    expect(onConnectorRuntimeChanged).toHaveBeenCalledOnce()
    expect(commands.listConnectors).toHaveBeenCalledTimes(2)
  })

  it('notices when runtime invalidates a previously authenticated OAuth Connector', async () => {
    let runtimeChanged: (() => void) | undefined
    const authenticated = {
      ...server('oauth'),
      displayName: 'OAuth MCP',
      transport: 'streamable_http' as const,
      url: 'https://mcp.example.test',
      oauth: { hasTokens: true }
    }
    const unauthenticated = {
      ...authenticated,
      enabled: false,
      availability: 'unauthenticated' as const
    }
    const runtimeCommands: ConnectorCommands = {
      ...createCommands(),
      listConnectors: vi
        .fn()
        .mockResolvedValueOnce(snapshot([], [authenticated]))
        .mockResolvedValueOnce(snapshot([], [unauthenticated]))
        .mockResolvedValueOnce(snapshot([], [unauthenticated])),
      onConnectorRuntimeChanged: vi.fn((listener: () => void) => {
        runtimeChanged = listener
        return () => undefined
      })
    }
    ;({ store, commands } = createHarness(runtimeCommands))

    await store.getState().loadConnectors()
    runtimeChanged?.()

    await vi.waitFor(() =>
      expect(store.getState().connectorAuthNotice).toEqual({
        id: 'oauth',
        displayName: 'OAuth MCP'
      })
    )
    store.getState().dismissConnectorAuthNotice()
    runtimeChanged?.()
    await vi.waitFor(() => expect(commands.listConnectors).toHaveBeenCalledTimes(3))
    expect(store.getState().connectorAuthNotice).toBeUndefined()
  })

  it('does not treat initial or mutation-owned unauthenticated state as token expiry', async () => {
    const unauthenticated = {
      ...server('oauth'),
      transport: 'streamable_http' as const,
      url: 'https://mcp.example.test',
      oauth: { hasTokens: false },
      availability: 'unauthenticated' as const
    }
    vi.mocked(commands.listConnectors).mockResolvedValue(snapshot([], [unauthenticated]))
    vi.mocked(commands.authenticateCustomServer).mockResolvedValue(snapshot([], [unauthenticated]))

    await store.getState().loadConnectors()
    await store.getState().authenticateCustomServer({ id: 'oauth' })

    expect(store.getState().connectorAuthNotice).toBeUndefined()
  })

  it('clears an auth notice when reauthentication succeeds', async () => {
    const authenticated = {
      ...server('oauth'),
      transport: 'streamable_http' as const,
      url: 'https://mcp.example.test',
      oauth: { hasTokens: true }
    }
    const unauthenticated = {
      ...authenticated,
      enabled: false,
      availability: 'unauthenticated' as const
    }
    store.setState({
      customServers: [unauthenticated],
      connectorAuthNotice: { id: 'oauth', displayName: 'oauth' }
    })
    vi.mocked(commands.authenticateCustomServer).mockResolvedValue(snapshot([], [authenticated]))

    await store.getState().authenticateCustomServer({ id: 'oauth' })

    expect(store.getState().connectorAuthNotice).toBeUndefined()
  })

  it('does not let an older runtime snapshot overwrite a newer mutation', async () => {
    let runtimeChanged: (() => void) | undefined
    let settleRuntimeSnapshot!: (result: ConnectorsSnapshot) => void
    const runtimeSnapshot = new Promise<ConnectorsSnapshot>((resolve) => {
      settleRuntimeSnapshot = resolve
    })
    const runtimeCommands: ConnectorCommands = {
      ...createCommands(),
      listConnectors: vi
        .fn()
        .mockResolvedValueOnce(snapshot([], [server('custom')]))
        .mockReturnValueOnce(runtimeSnapshot),
      setCustomServerEnabled: vi.fn(async () => snapshot([], [server('custom', false)])),
      onConnectorRuntimeChanged: vi.fn((listener: () => void) => {
        runtimeChanged = listener
        return () => undefined
      })
    }
    ;({ store, commands } = createHarness(runtimeCommands))

    await store.getState().loadConnectors()
    runtimeChanged?.()
    await vi.waitFor(() => expect(commands.listConnectors).toHaveBeenCalledTimes(2))
    await store.getState().setCustomServerEnabled('custom', false)

    settleRuntimeSnapshot(snapshot([], [server('custom')]))
    await Promise.resolve()
    await Promise.resolve()

    expect(store.getState().customServers).toEqual([server('custom', false)])
  })

  it('defers runtime refreshes until an in-flight mutation has reconciled', async () => {
    let runtimeChanged: (() => void) | undefined
    let settleMutation!: (result: ConnectorsSnapshot) => void
    let settleDeferredRefresh!: (result: ConnectorsSnapshot) => void
    const mutation = new Promise<ConnectorsSnapshot>((resolve) => {
      settleMutation = resolve
    })
    const deferredRefresh = new Promise<ConnectorsSnapshot>((resolve) => {
      settleDeferredRefresh = resolve
    })
    const runtimeCommands: ConnectorCommands = {
      ...createCommands(),
      listConnectors: vi
        .fn()
        .mockResolvedValueOnce(snapshot([], [server('custom')]))
        .mockReturnValueOnce(deferredRefresh),
      setCustomServerEnabled: vi.fn(() => mutation),
      onConnectorRuntimeChanged: vi.fn((listener: () => void) => {
        runtimeChanged = listener
        return () => undefined
      })
    }
    ;({ store, commands } = createHarness(runtimeCommands))

    await store.getState().loadConnectors()
    const pendingMutation = store.getState().setCustomServerEnabled('custom', false)
    runtimeChanged?.()

    expect(commands.listConnectors).toHaveBeenCalledOnce()
    settleMutation(snapshot([], [server('custom', false)]))
    await pendingMutation

    expect(store.getState().customServers).toEqual([server('custom', false)])
    await vi.waitFor(() => expect(commands.listConnectors).toHaveBeenCalledTimes(2))

    settleDeferredRefresh(snapshot([], [server('custom', false)]))
    await vi.waitFor(() =>
      expect(store.getState().customServers).toEqual([server('custom', false)])
    )
  })

  it('preserves OAuth expiry observed during an in-flight mutation', async () => {
    let runtimeChanged: (() => void) | undefined
    let settleMutation!: (result: ConnectorsSnapshot) => void
    let settleDeferredRefresh!: (result: ConnectorsSnapshot) => void
    const mutation = new Promise<ConnectorsSnapshot>((resolve) => {
      settleMutation = resolve
    })
    const deferredRefresh = new Promise<ConnectorsSnapshot>((resolve) => {
      settleDeferredRefresh = resolve
    })
    const authenticated = {
      ...server('oauth'),
      transport: 'streamable_http' as const,
      url: 'https://mcp.example.test',
      oauth: { hasTokens: true }
    }
    const unauthenticated = {
      ...authenticated,
      enabled: false,
      availability: 'unauthenticated' as const
    }
    const runtimeCommands: ConnectorCommands = {
      ...createCommands(),
      listConnectors: vi
        .fn()
        .mockResolvedValueOnce(snapshot([], [authenticated]))
        .mockReturnValueOnce(deferredRefresh),
      setCustomServerEnabled: vi.fn(() => mutation),
      onConnectorRuntimeChanged: vi.fn((listener: () => void) => {
        runtimeChanged = listener
        return () => undefined
      })
    }
    ;({ store, commands } = createHarness(runtimeCommands))

    await store.getState().loadConnectors()
    const pendingMutation = store.getState().setCustomServerEnabled('oauth', false)
    runtimeChanged?.()
    settleMutation(snapshot([], [unauthenticated]))
    await pendingMutation

    expect(store.getState().connectorAuthNotice).toEqual({
      id: 'oauth',
      displayName: 'oauth'
    })
    settleDeferredRefresh(snapshot([], [unauthenticated]))
    await vi.waitFor(() => expect(commands.listConnectors).toHaveBeenCalledTimes(2))
    expect(store.getState().connectorAuthNotice).toEqual({
      id: 'oauth',
      displayName: 'oauth'
    })
  })

  it('optimistically enables a Connector before authoritative reconciliation', async () => {
    let settle!: (result: ConnectorsSnapshot) => void
    vi.mocked(commands.setConnectorEnabled).mockReturnValue(
      new Promise((resolve) => {
        settle = resolve
      })
    )
    store.setState({ connectors: [connector('pubmed', { enabled: false })] })

    const pending = store.getState().setConnectorEnabled('pubmed', true)

    expect(store.getState().connectors).toEqual([connector('pubmed')])
    expect(commands.setConnectorEnabled).toHaveBeenCalledWith({ id: 'pubmed', enabled: true })

    settle(snapshot([connector('authoritative')]))
    await pending
    expect(store.getState().connectors).toEqual([connector('authoritative')])
  })

  it('rolls back an optimistic Connector toggle when main rejects it', async () => {
    vi.mocked(commands.setConnectorEnabled).mockRejectedValue(new Error('toggle failed'))
    store.setState({ connectors: [connector('pubmed')] })

    await expect(store.getState().setConnectorEnabled('pubmed', false)).rejects.toThrow(
      'toggle failed'
    )

    expect(store.getState().connectors).toEqual([connector('pubmed')])
  })

  it('does not let an older rejected Connector toggle overwrite a newer success', async () => {
    let rejectOlder!: (error: Error) => void
    let settleNewer!: (result: ConnectorsSnapshot) => void
    vi.mocked(commands.setConnectorEnabled)
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectOlder = reject
        })
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          settleNewer = resolve
        })
      )
    store.setState({ connectors: [connector('pubmed')] })

    const older = store.getState().setConnectorEnabled('pubmed', false)
    const newer = store.getState().setConnectorEnabled('pubmed', true)

    settleNewer(snapshot([connector('pubmed')]))
    await newer
    rejectOlder(new Error('older toggle failed'))
    await expect(older).rejects.toThrow('older toggle failed')

    expect(store.getState().connectors).toEqual([connector('pubmed')])
  })

  it('does not let an older Connector toggle overwrite a newer authoritative refresh', async () => {
    let settleOlder!: (result: ConnectorsSnapshot) => void
    vi.mocked(commands.setConnectorEnabled).mockReturnValue(
      new Promise((resolve) => {
        settleOlder = resolve
      })
    )
    vi.mocked(commands.listConnectors).mockResolvedValue(snapshot([connector('pubmed')]))
    store.setState({ connectors: [connector('pubmed')] })

    const older = store.getState().setConnectorEnabled('pubmed', false)
    await store.getState().loadConnectors()

    settleOlder(snapshot([connector('pubmed', { enabled: false })]))
    await older

    expect(store.getState().connectors).toEqual([connector('pubmed')])
  })

  it('returns to the confirmed Connector value when overlapping toggles all fail', async () => {
    let rejectOlder!: (error: Error) => void
    let rejectNewer!: (error: Error) => void
    vi.mocked(commands.setConnectorEnabled)
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectOlder = reject
        })
      )
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectNewer = reject
        })
      )
    store.setState({ connectors: [connector('pubmed')] })

    const older = store.getState().setConnectorEnabled('pubmed', false)
    const newer = store.getState().setConnectorEnabled('pubmed', true)

    rejectNewer(new Error('newer toggle failed'))
    await expect(newer).rejects.toThrow('newer toggle failed')
    expect(store.getState().connectors).toEqual([connector('pubmed', { enabled: false })])

    rejectOlder(new Error('older toggle failed'))
    await expect(older).rejects.toThrow('older toggle failed')
    expect(store.getState().connectors).toEqual([connector('pubmed')])
  })

  it('rolls back an optimistic auto-allow change when main rejects it', async () => {
    vi.mocked(commands.setConnectorAutoAllow).mockRejectedValue(new Error('policy failed'))
    store.setState({ connectors: [connector('pubmed')] })

    await expect(store.getState().setConnectorAutoAllow('pubmed', true)).rejects.toThrow(
      'policy failed'
    )

    expect(commands.setConnectorAutoAllow).toHaveBeenCalledWith({
      id: 'pubmed',
      autoAllow: true
    })
    expect(store.getState().connectors).toEqual([connector('pubmed')])
  })

  it('returns tool permission detail without adding component-owned detail state', async () => {
    store.setState({ connectors: [connector('pubmed')] })

    await expect(store.getState().setToolPermission('pubmed/search', 'ask')).resolves.toBe(detail)

    expect(commands.setToolPermission).toHaveBeenCalledWith({
      toolId: 'pubmed/search',
      permission: 'ask'
    })
    expect(store.getState().connectors).toEqual([connector('pubmed')])
  })

  it('reconciles credentials and custom-server CRUD from authoritative snapshots', async () => {
    const withCredentials: ConnectorsSnapshot = {
      ...snapshot(),
      ncbi: { contactEmail: 'science@example.test', hasApiKey: true }
    }
    const created = server('created')
    const updated = { ...created, description: 'Updated' }
    vi.mocked(commands.setNcbiCredentials).mockResolvedValue(withCredentials)
    vi.mocked(commands.addCustomServer).mockResolvedValue(snapshot([], [created]))
    vi.mocked(commands.updateCustomServer).mockResolvedValue(snapshot([], [updated]))
    vi.mocked(commands.removeCustomServer).mockResolvedValue(snapshot())

    await store
      .getState()
      .setNcbiCredentials({ contactEmail: 'science@example.test', apiKey: 'secret' })
    expect(store.getState().ncbi).toEqual(withCredentials.ncbi)

    await expect(
      store.getState().addCustomServer({
        name: 'created',
        displayName: 'Created',
        transport: 'stdio',
        command: 'npx'
      })
    ).resolves.toEqual(created)
    expect(store.getState().customServers).toEqual([created])

    await store.getState().updateCustomServer({
      id: 'created',
      description: 'Updated',
      transport: 'stdio',
      command: 'npx'
    })
    expect(store.getState().customServers).toEqual([updated])

    await store.getState().removeCustomServer('created')
    expect(commands.removeCustomServer).toHaveBeenCalledWith({ id: 'created' })
    expect(store.getState().customServers).toEqual([])
  })

  it('reconciles successful custom-server authentication', async () => {
    const authenticated = {
      ...server('oauth'),
      transport: 'streamable_http' as const,
      url: 'https://mcp.example.test',
      oauth: { hasTokens: true }
    }
    vi.mocked(commands.authenticateCustomServer).mockResolvedValue(snapshot([], [authenticated]))

    await store.getState().authenticateCustomServer({ id: 'oauth' })

    expect(commands.authenticateCustomServer).toHaveBeenCalledWith({ id: 'oauth' })
    expect(store.getState().customServers).toEqual([authenticated])
  })

  it('refreshes invalidated OAuth state and rethrows the authentication failure', async () => {
    const unauthenticated = {
      ...server('oauth'),
      transport: 'streamable_http' as const,
      url: 'https://mcp.example.test',
      oauth: { hasTokens: false }
    }
    const failure = new Error('authorization denied')
    vi.mocked(commands.authenticateCustomServer).mockRejectedValue(failure)
    vi.mocked(commands.listConnectors).mockResolvedValue(snapshot([], [unauthenticated]))

    await expect(store.getState().authenticateCustomServer({ id: 'oauth' })).rejects.toBe(failure)

    expect(commands.listConnectors).toHaveBeenCalledOnce()
    expect(store.getState().customServers).toEqual([unauthenticated])
  })

  it('keeps the authentication error when the fallback refresh also fails', async () => {
    const failure = new Error('authorization denied')
    vi.mocked(commands.authenticateCustomServer).mockRejectedValue(failure)
    vi.mocked(commands.listConnectors).mockRejectedValue(new Error('refresh failed'))

    await expect(store.getState().authenticateCustomServer({ id: 'oauth' })).rejects.toBe(failure)
  })

  it('forwards custom-server authentication cancellation', async () => {
    await store.getState().cancelCustomServerAuthentication({ id: 'oauth' })

    expect(commands.cancelCustomServerAuthentication).toHaveBeenCalledWith({ id: 'oauth' })
  })

  it('reconciles a custom Connector retry from the authoritative runtime status', async () => {
    const unavailable = { ...server('custom'), availability: 'unavailable' as const }
    const connected = server('custom')
    store.setState({ customServers: [unavailable] })
    vi.mocked(commands.retryCustomServer).mockResolvedValue(snapshot([], [connected]))

    await store.getState().retryCustomServer('custom')

    expect(commands.retryCustomServer).toHaveBeenCalledWith({ id: 'custom' })
    expect(store.getState().customServers).toEqual([connected])
  })

  it('optimistically toggles a custom server before authoritative reconciliation', async () => {
    let settle!: (result: ConnectorsSnapshot) => void
    vi.mocked(commands.setCustomServerEnabled).mockReturnValue(
      new Promise((resolve) => {
        settle = resolve
      })
    )
    store.setState({ customServers: [server('custom')] })

    const pending = store.getState().setCustomServerEnabled('custom', false)

    expect(store.getState().customServers).toEqual([server('custom', false)])
    expect(commands.setCustomServerEnabled).toHaveBeenCalledWith({ id: 'custom', enabled: false })

    settle(snapshot([], [server('authoritative', false)]))
    await pending
    expect(store.getState().customServers).toEqual([server('authoritative', false)])
  })

  it('rolls back an optimistic custom-server toggle when main rejects it', async () => {
    vi.mocked(commands.setCustomServerEnabled).mockRejectedValue(new Error('toggle failed'))
    store.setState({ customServers: [server('custom')] })

    await expect(store.getState().setCustomServerEnabled('custom', false)).rejects.toThrow(
      'toggle failed'
    )

    expect(store.getState().customServers).toEqual([server('custom')])
  })

  it('keeps approval ordering, ignores duplicates, and removes a response after main confirms', async () => {
    const first: ConnectorApprovalRequest = {
      id: 'first',
      connector: 'pubmed',
      method: 'search',
      argsPreview: '{}'
    }
    const second = { ...first, id: 'second' }
    let settle!: () => void
    vi.mocked(commands.respondConnectorApproval).mockReturnValue(
      new Promise((resolve) => {
        settle = resolve
      })
    )

    store.getState().enqueueApproval(first)
    store.getState().enqueueApproval(second)
    store.getState().enqueueApproval(first)
    expect(store.getState().pendingApprovals).toEqual([first, second])

    const pending = store.getState().respondApproval('first', 'session')
    expect(store.getState().pendingApprovals).toEqual([first, second])
    expect(commands.respondConnectorApproval).toHaveBeenCalledWith({
      id: 'first',
      decision: 'session'
    })

    settle()
    await pending
    expect(store.getState().pendingApprovals).toEqual([second])
  })

  it('retains an approval when main rejects the response', async () => {
    const request: ConnectorApprovalRequest = {
      id: 'request',
      connector: 'pubmed',
      method: 'search',
      argsPreview: '{}'
    }
    vi.mocked(commands.respondConnectorApproval).mockRejectedValue(new Error('response failed'))
    store.getState().enqueueApproval(request)

    await expect(store.getState().respondApproval('request', 'once')).rejects.toThrow(
      'response failed'
    )

    expect(store.getState().pendingApprovals).toEqual([request])
  })

  it('dismisses a settled approval idempotently', () => {
    const first: ConnectorApprovalRequest = {
      id: 'first',
      connector: 'pubmed',
      method: 'search',
      argsPreview: '{}'
    }
    const second = { ...first, id: 'second' }
    store.setState({ pendingApprovals: [first, second] })

    store.getState().dismissApproval('first')
    store.getState().dismissApproval('first')

    expect(store.getState().pendingApprovals).toEqual([second])
  })
})
