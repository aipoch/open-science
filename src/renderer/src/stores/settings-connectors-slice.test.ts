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
  slug: id,
  name: id,
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
  addCustomServer: vi.fn(async () => snapshot()),
  updateCustomServer: vi.fn(async () => snapshot()),
  authenticateCustomServer: vi.fn(async () => snapshot()),
  cancelCustomServerAuthentication: vi.fn(async () => undefined),
  setCustomServerEnabled: vi.fn(async () => snapshot()),
  removeCustomServer: vi.fn(async () => snapshot()),
  respondConnectorApproval: vi.fn(async () => undefined)
})

const createHarness = (
  commands: ConnectorCommands
): { store: StoreApi<TestStore>; commands: ConnectorCommands } => {
  const store = createStore<TestStore>((set) => ({
    ...createInitialSettingsConnectorsState(),
    ...createSettingsConnectorsSlice({
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
      ncbi: { contactEmail: 'science@example.test', hasApiKey: true }
    }
    vi.mocked(commands.listConnectors).mockResolvedValue(result)

    await store.getState().loadConnectors()

    expect(store.getState()).toMatchObject(result)
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

  it('retains an optimistic Connector toggle when main rejects it', async () => {
    vi.mocked(commands.setConnectorEnabled).mockRejectedValue(new Error('toggle failed'))
    store.setState({ connectors: [connector('pubmed')] })

    await expect(store.getState().setConnectorEnabled('pubmed', false)).rejects.toThrow(
      'toggle failed'
    )

    expect(store.getState().connectors).toEqual([connector('pubmed', { enabled: false })])
  })

  it('optimistically changes auto-allow and retains it after rejection', async () => {
    vi.mocked(commands.setConnectorAutoAllow).mockRejectedValue(new Error('policy failed'))
    store.setState({ connectors: [connector('pubmed')] })

    await expect(store.getState().setConnectorAutoAllow('pubmed', true)).rejects.toThrow(
      'policy failed'
    )

    expect(commands.setConnectorAutoAllow).toHaveBeenCalledWith({
      id: 'pubmed',
      autoAllow: true
    })
    expect(store.getState().connectors).toEqual([connector('pubmed', { autoAllow: true })])
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

    await store.getState().addCustomServer({ name: 'Created', transport: 'stdio', command: 'npx' })
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

  it('retains an optimistic custom-server toggle when main rejects it', async () => {
    vi.mocked(commands.setCustomServerEnabled).mockRejectedValue(new Error('toggle failed'))
    store.setState({ customServers: [server('custom')] })

    await expect(store.getState().setCustomServerEnabled('custom', false)).rejects.toThrow(
      'toggle failed'
    )

    expect(store.getState().customServers).toEqual([server('custom', false)])
  })

  it('keeps approval ordering, ignores duplicates, and removes a response immediately', async () => {
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
    expect(store.getState().pendingApprovals).toEqual([second])
    expect(commands.respondConnectorApproval).toHaveBeenCalledWith({
      id: 'first',
      decision: 'session'
    })

    settle()
    await pending
  })

  it('retains immediate approval removal when main rejects the response', async () => {
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

    expect(store.getState().pendingApprovals).toEqual([])
  })
})
