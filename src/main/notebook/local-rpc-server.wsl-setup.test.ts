import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotebookLocalRpcServer } from './local-rpc-server'

let server: NotebookLocalRpcServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

const call = async (
  connection: { endpoint: string; token: string },
  method: string,
  params: Record<string, unknown> = {}
): Promise<{ response: Response; body: Record<string, unknown> }> => {
  const response = await fetch(connection.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method, params })
  })
  return { response, body: (await response.json()) as Record<string, unknown> }
}

type WslSetupRpcHarness = Readonly<{
  connection: { endpoint: string; token: string }
  owner: Record<
    | 'getStatus'
    | 'probe'
    | 'createSupportHandoff'
    | 'installPlatform'
    | 'installRecommendedDistro'
    | 'select'
    | 'selectAtRevision'
    | 'openTerminal',
    ReturnType<typeof vi.fn>
  >
  openPowerShellTerminal: ReturnType<typeof vi.fn>
}>

const setup = async (bound: boolean, preview = true): Promise<WslSetupRpcHarness> => {
  const snapshot = {
    state: 'ready',
    distros: [{ name: 'Ubuntu', version: 2, isDefault: true }],
    operationReference: 'op-1'
  } as const
  const handoff = { schemaVersion: 1, revision: 7, supportReference: 'op-1' }
  const owner = {
    getStatus: vi.fn(() => ({ revision: 7, operation: { state: 'idle' } })),
    probe: vi.fn(async () => snapshot),
    createSupportHandoff: vi.fn(async () => handoff),
    installPlatform: vi.fn(async () => ({ outcome: 'completed', snapshot })),
    installRecommendedDistro: vi.fn(async () => snapshot),
    select: vi.fn(async () => snapshot),
    selectAtRevision: vi.fn(async () => snapshot),
    openTerminal: vi.fn(async () => snapshot)
  }
  const openPowerShellTerminal = vi.fn(async () => undefined)
  server = new NotebookLocalRpcServer({} as never, {
    transport: 'tcp',
    wslSetup: owner as never,
    wslSetupSessions: { isBound: vi.fn(async () => bound) },
    wslSetupPreviewAvailable: () => preview,
    openWslSetupPowerShellTerminal: openPowerShellTerminal
  })
  const connection = await server.issueSessionConnection(
    'setup-session',
    'project-1',
    'root-frame-setup-session'
  )
  return { connection, owner, openPowerShellTerminal }
}

describe('WSL setup RPC', () => {
  it('refreshes diagnostics only for a bound Windows preview setup Session', async () => {
    const { connection, owner } = await setup(true)
    const result = await call(connection, 'wslSetupDiagnostics')

    expect(result.response.status).toBe(200)
    expect(result.body).toEqual({
      result: { schemaVersion: 1, revision: 7, supportReference: 'op-1' }
    })
    expect(owner.probe).toHaveBeenCalledOnce()
    expect(owner.createSupportHandoff).toHaveBeenCalledOnce()
  })

  it.each([
    { bound: false, preview: true, message: 'bound local setup Session' },
    { bound: true, preview: false, message: 'preview is unavailable' }
  ])(
    'fails closed outside its local setup scope: $message',
    async ({ bound, preview, message }) => {
      const { connection, owner } = await setup(bound, preview)
      const result = await call(connection, 'wslSetupInstallPlatform')

      expect(result.response.status).toBe(403)
      expect(result.body.error).toContain(message)
      expect(owner.installPlatform).not.toHaveBeenCalled()
    }
  )

  it('routes owner operations and keeps activation outside the setup surface', async () => {
    const { connection, owner, openPowerShellTerminal } = await setup(true)

    expect((await call(connection, 'wslSetupInstallPlatform')).response.status).toBe(200)
    expect((await call(connection, 'wslSetupInstallRecommendedDistro')).response.status).toBe(200)
    expect(
      (
        await call(connection, 'wslSetupSelectProfile', {
          distro: 'Ubuntu',
          user: 'alice',
          expectedRevision: 7
        })
      ).response.status
    ).toBe(200)
    expect(
      (
        await call(connection, 'wslSetupOpenTerminal', {
          target: 'distro',
          distro: 'Ubuntu',
          user: 'alice'
        })
      ).response.status
    ).toBe(200)

    expect(owner.installPlatform).toHaveBeenCalledOnce()
    expect(owner.installRecommendedDistro).toHaveBeenCalledOnce()
    expect(owner.selectAtRevision).toHaveBeenCalledWith({ distro: 'Ubuntu', user: 'alice' }, 7)
    expect(owner.openTerminal).toHaveBeenCalledWith({ distro: 'Ubuntu', user: 'alice' })
    expect(await call(connection, 'wslSetupOpenTerminal', { target: 'powershell' })).toMatchObject({
      response: { status: 200 },
      body: { result: { target: 'powershell', state: 'opened' } }
    })
    expect(openPowerShellTerminal).toHaveBeenCalledOnce()
    const activation = await call(connection, 'wslSetupActivate')
    expect(activation.response.status).toBe(404)
  })

  it.each([
    { target: 'powershell', distro: 'Ubuntu' },
    { target: 'powershell', user: 'alice' },
    { target: 'distro' },
    { target: 'other', distro: 'Ubuntu' }
  ])('rejects invalid terminal target arguments: %j', async (input) => {
    const { connection, owner, openPowerShellTerminal } = await setup(true)
    const result = await call(connection, 'wslSetupOpenTerminal', input)

    expect(result.response.status).toBe(400)
    expect(owner.openTerminal).not.toHaveBeenCalled()
    expect(openPowerShellTerminal).not.toHaveBeenCalled()
  })

  it('refuses a stale profile selection before calling the owner', async () => {
    const { connection, owner } = await setup(true)
    const result = await call(connection, 'wslSetupSelectProfile', {
      distro: 'Ubuntu',
      user: 'alice',
      expectedRevision: 6
    })

    expect(result.response.status).toBe(409)
    expect(result.body).toEqual({ error: 'WSL_SETUP_DIAGNOSTICS_STALE' })
    expect(owner.selectAtRevision).not.toHaveBeenCalled()
  })
})
