import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { MEDICAL_PROVIDERS, MEDICAL_ROUTES } from '@aipoch/connector-builtins/medical-data'
import {
  checkMedicalPython,
  createMedicalDataHandlers,
  validateMedicalRuntimeReport
} from './medical-data-adapter'

function fixture() {
  const call = vi.fn(async () => ({ status: 'queued', job_id: 'job' }))
  const close = vi.fn(async () => {})
  const checkRuntime = vi.fn(async () => {})
  const environment = {
    PHYSIONET_USERNAME: 'account-sentinel',
    PHYSIONET_PASSWORD: 'password-sentinel',
    OPENFDA_API_KEY: 'key-sentinel',
    CHARLS_COOKIE: 'cookie-sentinel',
    UNRELATED_SECRET: 'unrelated-sentinel'
  }
  const handlers = createMedicalDataHandlers({
    client: { call, close },
    checkRuntime,
    python: () => 'prepared-python',
    script: () => 'bootstrap.py',
    dataRoot: () => '/data/medical-data',
    environment: () => environment
  })
  return { handlers, call, close, checkRuntime }
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

  it('replaces an idle cached worker when the interpreter, root or credentials change', async () => {
    let python = 'python-a'
    let root = '/data/a'
    let key = 'key-a'
    const call = vi.fn(async (_config: unknown, _method: string) => ({ tables: [] }))
    const close = vi.fn(async () => {})
    const checkRuntime = vi.fn(async () => {})
    const handlers = createMedicalDataHandlers({
      client: { call, close },
      checkRuntime,
      python: () => python,
      script: () => 'bootstrap.py',
      dataRoot: () => root,
      environment: () => ({ OPENFDA_API_KEY: key })
    })
    await handlers['faers/list_tables']({}, {})
    await handlers['faers/list_tables']({}, {})
    expect(checkRuntime).toHaveBeenCalledTimes(1)
    python = 'python-b'
    await handlers['faers/list_tables']({}, {})
    root = '/data/b'
    await handlers['faers/list_tables']({}, {})
    key = 'key-b'
    await handlers['faers/list_tables']({}, {})
    expect(close).toHaveBeenCalledTimes(3)
    expect(call.mock.calls.at(-1)?.[0]).toMatchObject({
      command: 'python-b',
      env: { OPENFDA_API_KEY: 'key-b' }
    })
  })

  it('retains an active job worker through configuration changes and rotates after completion', async () => {
    let root = '/data/a'
    const configs: { args: string[] }[] = []
    const call = vi.fn(async (config: { args: string[] }, method: string) => {
      configs.push(config)
      return method === 'download_file'
        ? { job_id: 'job', status: 'queued' }
        : method === 'get_job'
        ? { job_id: 'job', status: 'ready' }
        : { tables: [] }
    })
    const close = vi.fn(async () => {})
    const handlers = createMedicalDataHandlers({
      client: { call, close },
      checkRuntime: async () => {},
      python: () => 'python',
      script: () => 'bootstrap.py',
      dataRoot: () => root
    })
    await handlers['nhanes/download_file']({ url: 'official-file', filename: 'source.xpt' }, {})
    root = '/data/b'
    await expect(handlers['nhanes/list_tables']({}, {})).rejects.toThrow(
      'background jobs are active'
    )
    expect(close).not.toHaveBeenCalled()
    await handlers['nhanes/get_job']({ job_id: 'job' }, {})
    expect(configs[1].args).toContain('/data/a')
    await handlers['nhanes/list_tables']({}, {})
    expect(close).toHaveBeenCalledOnce()
    expect(configs[2].args).toContain('/data/b')
  })

  it('waits for an in-flight request before replacing its worker', async () => {
    let root = '/data/a'
    let started!: () => void
    let release!: () => void
    const firstStarted = new Promise<void>((done) => {
      started = done
    })
    const blocked = new Promise<void>((done) => {
      release = done
    })
    const events: string[] = []
    const call = async (config: { args: string[] }) => {
      const selected = config.args.at(-1)!
      events.push(`start:${selected}`)
      if (selected === '/data/a') {
        started()
        await blocked
      }
      events.push(`finish:${selected}`)
      return { tables: [] }
    }
    const close = async () => {
      events.push('close')
    }
    const handlers = createMedicalDataHandlers({
      client: { call, close },
      checkRuntime: async () => {},
      python: () => 'python',
      script: () => 'bootstrap.py',
      dataRoot: () => root
    })
    const first = handlers['nhanes/list_tables']({}, {})
    await firstStarted
    root = '/data/b'
    const second = handlers['nhanes/list_tables']({}, {})
    expect(events).toEqual(['start:/data/a'])
    release()
    await Promise.all([first, second])
    expect(events).toEqual([
      'start:/data/a',
      'finish:/data/a',
      'close',
      'start:/data/b',
      'finish:/data/b'
    ])
  })

  it('cancels a queued caller immediately without dispatching it or interrupting another caller', async () => {
    let started!: () => void
    let release!: () => void
    const firstStarted = new Promise<void>((done) => {
      started = done
    })
    const blocked = new Promise<void>((done) => {
      release = done
    })
    const call = vi.fn(async () => {
      started()
      await blocked
      return { tables: [] }
    })
    const handlers = createMedicalDataHandlers({
      client: { call, close: async () => {} },
      checkRuntime: async () => {},
      python: () => 'python',
      script: () => 'bootstrap.py',
      dataRoot: () => '/data'
    })
    const first = handlers['nhanes/list_tables']({}, {})
    await firstStarted
    const controller = new AbortController()
    const second = handlers['nhanes/list_tables']({}, {}, controller.signal)
    controller.abort(new Error('queued caller cancelled'))
    try {
      await expect(second).rejects.toThrow('queued caller cancelled')
    } finally {
      release()
    }
    await first
    expect(call).toHaveBeenCalledOnce()
  })
})

describe('medical Python readiness validation', () => {
  it('rejects a relative interpreter command without starting a process', async () => {
    await expect(checkMedicalPython('python')).rejects.toThrow('absolute Python executable path')
  })
  const valid = () => ({
    python: [3, 13, 0],
    packages: [
      { name: 'mcp', version: '1.30.1', imported: true },
      { name: 'duckdb', version: '1.4.1', imported: true },
      { name: 'pandas', version: '2.3.3', imported: true },
      { name: 'httpx', version: '0.28.1', imported: true },
      { name: 'pyreadstat', version: '1.3.6', imported: true }
    ]
  })
  it('accepts supported loaded packages', () =>
    expect(() => validateMedicalRuntimeReport(valid())).not.toThrow())
  it('rejects old Python before dispatch', () => {
    const report = valid()
    report.python = [3, 10, 9]
    expect(() => validateMedicalRuntimeReport(report)).toThrow('Python 3.11')
  })
  it.each([
    { version: '3.0.0', imported: true },
    { version: '2.2.2', imported: true },
    { version: '2.3.3', imported: false }
  ])('rejects incompatible or unloadable pandas: %j', (failure) => {
    const report = valid()
    Object.assign(report.packages[2], failure)
    expect(() => validateMedicalRuntimeReport(report)).toThrow('pandas>=2.2.3,<3')
  })
  it('rejects malformed reports without echoing probe content', () => {
    expect(() =>
      validateMedicalRuntimeReport({ python: [3, 13, 0], packages: [{ name: 'secret-sentinel' }] })
    ).toThrow('invalid dependency check')
  })
})
