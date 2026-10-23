import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { MEDICAL_PROVIDERS, MEDICAL_ROUTES } from '@aipoch/connector-builtins/medical-data'
import { createMedicalDataHandlers } from './medical-data-adapter'

function fixture() {
  const call = vi.fn(async () => ({ status: 'queued', job_id: 'job' }))
  const checkRuntime = vi.fn(async () => {})
  const environment = {
    PHYSIONET_USERNAME: 'account-sentinel',
    PHYSIONET_PASSWORD: 'password-sentinel',
    OPENFDA_API_KEY: 'key-sentinel',
    CHARLS_COOKIE: 'cookie-sentinel',
    UNRELATED_SECRET: 'unrelated-sentinel'
  }
  const handlers = createMedicalDataHandlers({
    client: { call },
    checkRuntime,
    python: () => 'prepared-python',
    script: () => 'bootstrap.py',
    dataRoot: () => '/data/medical-data',
    environment: () => environment
  })
  return { handlers, call, checkRuntime }
}

describe('bundled medical data host adapter', () => {
  it('registers every provider and tool without custom MCP configuration', async () => {
    const { handlers, call, checkRuntime } = fixture()
    expect(MEDICAL_PROVIDERS).toHaveLength(14)
    expect(Object.keys(handlers)).toHaveLength(MEDICAL_ROUTES.length)
    for (const provider of MEDICAL_PROVIDERS) {
      const result = await handlers[`${provider.id}/provider_info`]({}, {})
      expect(result).toMatchObject({
        provider: provider.id,
        incoming_directory: join('/data/medical-data', provider.id, 'incoming')
      })
      expect(JSON.stringify(result)).not.toContain('sentinel')
    }
    expect(call).not.toHaveBeenCalled()
    expect(checkRuntime).not.toHaveBeenCalled()
  })

  it('only forwards this provider credentials and keeps full patient data local', async () => {
    const { handlers, call } = fixture()
    await handlers['mimic/list_tables']({}, {})
    const [config, method] = call.mock.calls[0] as unknown as [
      { env: Record<string, string>; args: string[]; id: string },
      string
    ]
    expect(config.env.PHYSIONET_USERNAME).toBe('account-sentinel')
    expect(config.env.PHYSIONET_PASSWORD).toBe('password-sentinel')
    expect(config.env).not.toHaveProperty('OPENFDA_API_KEY')
    expect(config.env).not.toHaveProperty('CHARLS_COOKIE')
    expect(config.env).not.toHaveProperty('UNRELATED_SECRET')
    expect(config.args).not.toContain('--return-rows')
    expect(config.id).toBe('builtin-medical:mimic')
    expect(method).toBe('list_tables')
  })

  it('reports presence without granting approval or exposing credential values', async () => {
    const { handlers } = fixture()
    const result = await handlers['mimic/access_requirements'](
      { include_related_services: true },
      {}
    )
    expect(result).toMatchObject({
      permission_status: 'not_verified',
      credentials: { PHYSIONET_PASSWORD: { configured: true } },
      related_credentials_status: 'not_checked_managed_by_host_app'
    })
    expect(JSON.stringify(result)).not.toContain('sentinel')
  })

  it('does not require an API key or run Python for public access guidance', async () => {
    const { handlers, checkRuntime } = fixture()
    expect(await handlers['nhanes/access_requirements']({}, {})).toMatchObject({
      kind: 'public',
      credentials: {}
    })
    expect(await handlers['faers/access_requirements']({}, {})).toMatchObject({
      kind: 'recommended_api_key'
    })
    expect(checkRuntime).not.toHaveBeenCalled()
  })

  it('does not start a worker after runtime failure or cancellation', async () => {
    const { handlers, call, checkRuntime } = fixture()
    checkRuntime.mockRejectedValueOnce(new Error('missing packages'))
    await expect(handlers['nhanes/list_tables']({}, {})).rejects.toThrow('missing packages')
    const controller = new AbortController()
    controller.abort()
    await expect(handlers['nhanes/list_tables']({}, {}, controller.signal)).rejects.toThrow()
    expect(call).not.toHaveBeenCalled()
  })
})
