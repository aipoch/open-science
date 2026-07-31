import { describe, expect, it, vi } from 'vitest'

import {
  buildMacElevationBatchScript,
  buildMacElevationScript,
  detectRemoteIt,
  disableRemoteItConnectLink,
  enableRemoteItService,
  enableRemoteItServices,
  ensureRemoteItConnectLink,
  knownBinaryPaths,
  parseRemoteItJson,
  runRemoteItMutationBatch,
  runRemoteItMutation,
  type RemoteItCommandRunner
} from './remoteit'

const status = (services: Record<string, unknown>[] = []): string =>
  JSON.stringify({
    code: 0,
    data: {
      owner: 'person@example.com',
      device: { id: 'device-1', type: 35, state: 4, isEnabled: true },
      services: [{ id: 'device-1', type: 35, state: 4, isEnabled: true }, ...services]
    }
  })

describe('Remote.It adapter', () => {
  it('retries privileged mutations through the native macOS administrator prompt', async () => {
    const permissionError = {
      stdout: '{"code":7003,"message":"cmd - you must run this command with elevated privileges"}'
    }
    const run = vi.fn<RemoteItCommandRunner>(async (command) => {
      if (command === '/usr/local/bin/remoteit') throw permissionError
      return { stdout: '{"code":0}', stderr: '' }
    })

    await expect(
      runRemoteItMutation(
        '/usr/local/bin/remoteit',
        ['service', 'modify', '--id', 'service-1', '--enable', 'true', '--json'],
        run,
        'darwin'
      )
    ).resolves.toEqual({ stdout: '{"code":0}', stderr: '' })
    expect(run).toHaveBeenLastCalledWith(
      '/usr/bin/osascript',
      [
        '-e',
        buildMacElevationScript('/usr/local/bin/remoteit', [
          'service',
          'modify',
          '--id',
          'service-1',
          '--enable',
          'true',
          '--json'
        ])
      ],
      { timeoutMs: 120_000 }
    )
    expect(run.mock.calls.at(-1)?.[1][1]).toContain('with administrator privileges')
  })

  it('does not accept a JSON mutation error returned with exit code zero', async () => {
    const run = vi.fn<RemoteItCommandRunner>(async (command) => {
      if (command === '/usr/local/bin/remoteit') {
        return {
          stdout:
            '{"code":7003,"message":"cmd - you must run this command with elevated privileges"}',
          stderr: ''
        }
      }
      return { stdout: '{"code":0}', stderr: '' }
    })

    await expect(
      runRemoteItMutation(
        '/usr/local/bin/remoteit',
        ['service', 'modify', '--id', 'service-1', '--enable', 'true', '--json'],
        run,
        'darwin'
      )
    ).resolves.toEqual({ stdout: '{"code":0}', stderr: '' })
    expect(run.mock.calls.some(([command]) => command === '/usr/bin/osascript')).toBe(true)
  })

  it('prepares both service mutations through one native macOS administrator prompt', async () => {
    const permissionError = {
      stdout: '{"code":7003,"message":"cmd - you must run this command with elevated privileges"}'
    }
    const marker = '__OPEN_SCIENCE_REMOTEIT_BATCH_COMMAND_END__'
    const run = vi.fn<RemoteItCommandRunner>(async (command) => {
      if (command === '/usr/local/bin/remoteit') throw permissionError
      return {
        stdout: `{"code":0,"data":{"serviceId":"app-service"}}\n${marker}\n{"code":0,"data":{"serviceId":"browser-service"}}\n${marker}\n`,
        stderr: ''
      }
    })
    const commands = [
      ['service', 'add', '--name', 'Open Science Remote', '--json'],
      ['service', 'add', '--name', 'System Service', '--json']
    ]

    await expect(
      runRemoteItMutationBatch('/usr/local/bin/remoteit', commands, run, 'darwin')
    ).resolves.toHaveLength(2)
    expect(run.mock.calls.filter(([command]) => command === '/usr/bin/osascript')).toHaveLength(1)
    expect(run).toHaveBeenLastCalledWith(
      '/usr/bin/osascript',
      ['-e', buildMacElevationBatchScript('/usr/local/bin/remoteit', commands)],
      { timeoutMs: 120_000 }
    )
    const script = String(run.mock.calls.at(-1)?.[1][1])
    expect(script).toContain('Open Science Remote')
    expect(script).toContain('System Service')
    expect(script).toContain('with administrator privileges')
  })

  it('uses the Remote.It non-admin channel for Windows service mutations', async () => {
    const run = vi.fn<RemoteItCommandRunner>().mockResolvedValue({
      stdout: '{"code":0,"message":"netxt"}',
      stderr: ''
    })

    await expect(
      runRemoteItMutation(
        'C:\\Program Files\\Remote.It\\resources\\remoteit.exe',
        ['service', 'modify', '--id', 'service-1', '--enable', 'true', '--json'],
        run,
        'win32'
      )
    ).resolves.toMatchObject({ stdout: expect.stringContaining('"code":0') })
    expect(run).toHaveBeenCalledWith(
      'C:\\Program Files\\Remote.It\\resources\\remoteit.exe',
      ['service', 'modify', '--id', 'service-1', '--enable', 'true', '--json', '--noAdmin'],
      { timeoutMs: 30_000 }
    )
    expect(run.mock.calls.some(([command]) => command === '/usr/bin/osascript')).toBe(false)
  })

  it('uses the expected Windows Desktop CLI installation paths', () => {
    expect(
      knownBinaryPaths('win32', {
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)'
      })
    ).toEqual(
      expect.arrayContaining([
        'C:\\Program Files\\Remote.It\\resources\\remoteit.exe',
        'C:\\Program Files (x86)\\Remote.It\\resources\\remoteit.exe'
      ])
    )
  })

  it('parses noisy JSON and detects a user-installed signed-in CLI', async () => {
    expect(parseRemoteItJson(`notice\n${status()}\n`)).toMatchObject({ code: 0 })
    const run = vi.fn<RemoteItCommandRunner>(async (_command, args) => {
      if (args[0] === 'which') return { stdout: '', stderr: '' }
      if (args[0] === 'version') return { stdout: '4.1.0\n', stderr: '' }
      if (args.join(' ') === 'status --json') return { stdout: status(), stderr: '' }
      throw new Error(`Unexpected command: ${args.join(' ')}`)
    })

    await expect(
      detectRemoteIt(undefined, run, 'darwin', {
        OPEN_SCIENCE_REMOTEIT_BIN: process.execPath
      })
    ).resolves.toMatchObject({
      installed: true,
      loggedIn: true,
      registered: true,
      binaryPath: process.execPath,
      version: '4.1.0',
      account: 'person@example.com',
      deviceId: 'device-1'
    })
  })

  it('turns an unreachable background agent response into an actionable status error', async () => {
    const run = vi.fn<RemoteItCommandRunner>(async (_command, args) => {
      if (args[0] === 'version') return { stdout: '4.1.0\n', stderr: '' }
      if (args.join(' ') === 'status --json') {
        throw { stdout: '{"code":101,"message":"agent not reachable"}' }
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      detectRemoteIt(undefined, run, 'darwin', {
        OPEN_SCIENCE_REMOTEIT_BIN: process.execPath
      })
    ).resolves.toMatchObject({
      installed: true,
      loggedIn: false,
      registered: false,
      error:
        'Remote.It is still switching its background service mode. Wait a few seconds, then click Detect again. Do not add the device again.'
    })
  })

  it('enables and returns the Remote.It Persistent Public URL without administrator elevation', async () => {
    const run = vi.fn<RemoteItCommandRunner>().mockResolvedValue({
      stdout: JSON.stringify({
        code: 0,
        data: JSON.stringify({
          data: {
            setConnectLink: {
              enabled: true,
              url: 'https://open-science.connect.remote.it',
              service: { id: 'service-1' }
            }
          }
        })
      }),
      stderr: ''
    })

    await expect(
      ensureRemoteItConnectLink('/usr/local/bin/remoteit', 'service-1', run)
    ).resolves.toBe('https://open-science.connect.remote.it')
    expect(run).toHaveBeenCalledWith(
      '/usr/local/bin/remoteit',
      [
        'exec-gql',
        '--noAdmin',
        '--json',
        '--query',
        expect.stringContaining('setConnectLink(serviceId: "service-1", enabled: true)')
      ],
      { timeoutMs: 30_000 }
    )
    expect(run.mock.calls.some(([command]) => command === '/usr/bin/osascript')).toBe(false)
  })

  it('surfaces Remote.It cloud errors from a successful CLI process', async () => {
    const run = vi.fn<RemoteItCommandRunner>().mockResolvedValue({
      stdout: JSON.stringify({
        code: 0,
        data: JSON.stringify({
          errors: [{ message: 'Persistent Public URLs are unavailable for this account.' }]
        })
      }),
      stderr: ''
    })

    await expect(
      ensureRemoteItConnectLink('/usr/local/bin/remoteit', 'service-1', run)
    ).rejects.toThrow('Persistent Public URLs are unavailable for this account.')
  })

  it('repairs and enables the stored localhost HTTP service', async () => {
    let modified = false
    const service = {
      id: 'service-1',
      type: 7,
      addressHost: '127.0.0.1',
      addressPort: 80,
      isEnabled: true,
      state: 4
    }
    const run = vi.fn<RemoteItCommandRunner>(async (_command, args) => {
      if (args.join(' ') === 'status --json') {
        return {
          stdout: status([{ ...service, addressPort: modified ? 4180 : 80 }]),
          stderr: ''
        }
      }
      if (args[0] === 'version') return { stdout: '4.1.0\n', stderr: '' }
      if (args[0] === 'service' && args[1] === 'modify') {
        modified = true
      }
      return { stdout: '{"code":0}', stderr: '' }
    })

    await expect(
      enableRemoteItService(
        '/usr/local/bin/remoteit',
        4180,
        { name: 'Open Science Remote', preferredServiceId: 'service-1' },
        run,
        'linux'
      )
    ).resolves.toMatchObject({
      serviceId: 'service-1',
      installation: {
        service: {
          id: 'service-1',
          host: '127.0.0.1',
          port: 4180,
          enabled: true,
          ready: true
        }
      }
    })
    expect(run).toHaveBeenCalledWith(
      '/usr/local/bin/remoteit',
      [
        'service',
        'modify',
        '--id',
        'service-1',
        '--port',
        '4180',
        '--hostname',
        '127.0.0.1',
        '--type',
        'HTTP',
        '--enable',
        'true',
        '--json'
      ],
      { timeoutMs: 30_000 }
    )
  })

  it('reuses an already-correct enabled service without a privileged mutation', async () => {
    const run = vi.fn<RemoteItCommandRunner>(async (_command, args) => {
      if (args.join(' ') === 'status --json') {
        return {
          stdout: status([
            {
              id: 'service-1',
              type: 7,
              addressHost: '127.0.0.1',
              addressPort: 4180,
              isEnabled: true,
              state: 4
            }
          ]),
          stderr: ''
        }
      }
      if (args[0] === 'version') return { stdout: '4.1.0\n', stderr: '' }
      throw new Error(`Unexpected mutation: ${args.join(' ')}`)
    })

    await expect(
      enableRemoteItService(
        '/usr/local/bin/remoteit',
        4180,
        { name: 'Open Science Remote', preferredServiceId: 'service-1' },
        run
      )
    ).resolves.toMatchObject({
      serviceId: 'service-1',
      installation: {
        service: {
          id: 'service-1',
          port: 4180,
          enabled: true,
          ready: true
        }
      }
    })
    expect(
      run.mock.calls.filter(([, args]) => args[0] === 'service' && args[1] === 'modify')
    ).toHaveLength(0)
    expect(run.mock.calls.some(([command]) => command === '/usr/bin/osascript')).toBe(false)
  })

  it('creates a dedicated service when no exact managed service exists', async () => {
    let added = false
    const run = vi.fn<RemoteItCommandRunner>(async (_command, args) => {
      if (args.join(' ') === 'status --json') {
        return {
          stdout: status(
            added
              ? [
                  {
                    id: 'service-new',
                    type: 7,
                    addressHost: '127.0.0.1',
                    addressPort: 4180,
                    isEnabled: true,
                    state: 4
                  }
                ]
              : []
          ),
          stderr: ''
        }
      }
      if (args[0] === 'version') return { stdout: '4.1.0\n', stderr: '' }
      if (args[0] === 'service' && args[1] === 'add') {
        added = true
        return { stdout: '{"code":0}', stderr: '' }
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`)
    })

    await expect(
      enableRemoteItService('/usr/local/bin/remoteit', 4180, { name: 'Open Science Remote' }, run)
    ).resolves.toMatchObject({ serviceId: 'service-new' })
    expect(run).toHaveBeenCalledWith(
      '/usr/local/bin/remoteit',
      expect.arrayContaining([
        'service',
        'add',
        '--name',
        'Open Science Remote',
        '--port',
        '4180',
        '--type',
        'HTTP'
      ]),
      { timeoutMs: 30_000 }
    )
  })

  it('creates a separate Browser service when the App service already uses the same port', async () => {
    let added = false
    const appService = {
      id: 'app-service',
      type: 7,
      addressHost: '127.0.0.1',
      addressPort: 4180,
      isEnabled: true,
      state: 4
    }
    const run = vi.fn<RemoteItCommandRunner>(async (_command, args) => {
      if (args.join(' ') === 'status --json') {
        return {
          stdout: status([
            appService,
            ...(added
              ? [
                  {
                    ...appService,
                    id: 'browser-service'
                  }
                ]
              : [])
          ]),
          stderr: ''
        }
      }
      if (args[0] === 'version') return { stdout: '4.1.0\n', stderr: '' }
      if (args[0] === 'service' && args[1] === 'add') {
        added = true
        return { stdout: '{"code":0}', stderr: '' }
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`)
    })

    await expect(
      enableRemoteItService('/usr/local/bin/remoteit', 4180, { name: 'System Service' }, run)
    ).resolves.toMatchObject({ serviceId: 'browser-service' })
    expect(run).toHaveBeenCalledWith(
      '/usr/local/bin/remoteit',
      expect.arrayContaining(['service', 'add', '--name', 'System Service']),
      { timeoutMs: 30_000 }
    )
  })

  it('creates the App and Browser services together with one administrator approval', async () => {
    let added = false
    const marker = '__OPEN_SCIENCE_REMOTEIT_BATCH_COMMAND_END__'
    const permissionError = {
      stdout: '{"code":7003,"message":"cmd - you must run this command with elevated privileges"}'
    }
    const services = [
      {
        id: 'app-service',
        type: 7,
        addressHost: '127.0.0.1',
        addressPort: 4180,
        isEnabled: true,
        state: 4
      },
      {
        id: 'browser-service',
        type: 7,
        addressHost: '127.0.0.1',
        addressPort: 4180,
        isEnabled: true,
        state: 4
      }
    ]
    const run = vi.fn<RemoteItCommandRunner>(async (command, args) => {
      if (args.join(' ') === 'status --json') {
        return { stdout: status(added ? services : []), stderr: '' }
      }
      if (args[0] === 'version') return { stdout: '4.1.0\n', stderr: '' }
      if (command === '/usr/bin/osascript') {
        added = true
        return {
          stdout: `{"code":0,"data":{"serviceId":"app-service"}}\n${marker}\n{"code":0,"data":{"serviceId":"browser-service"}}\n${marker}\n`,
          stderr: ''
        }
      }
      if (args[0] === 'service' && args[1] === 'add') throw permissionError
      throw new Error(`Unexpected command: ${args.join(' ')}`)
    })

    await expect(
      enableRemoteItServices('/usr/local/bin/remoteit', 4180, { active: 'app' }, run, 'darwin')
    ).resolves.toMatchObject({
      appServiceId: 'app-service',
      browserServiceId: 'browser-service',
      installation: {
        service: {
          id: 'app-service',
          port: 4180,
          enabled: true,
          ready: true
        }
      }
    })
    expect(run.mock.calls.filter(([command]) => command === '/usr/bin/osascript')).toHaveLength(1)
    const script = String(
      run.mock.calls.find(([command]) => command === '/usr/bin/osascript')?.[1][1]
    )
    expect(script).toContain('Open Science Remote')
    expect(script).toContain('System Service')
  })

  it('waits for both existing services to report ready before returning', async () => {
    let statusReads = 0
    const services = [
      {
        id: 'app-service',
        type: 7,
        addressHost: '127.0.0.1',
        addressPort: 4180,
        isEnabled: true
      },
      {
        id: 'browser-service',
        type: 7,
        addressHost: '127.0.0.1',
        addressPort: 4180,
        isEnabled: true
      }
    ]
    const run = vi.fn<RemoteItCommandRunner>(async (_command, args) => {
      if (args.join(' ') === 'status --json') {
        statusReads += 1
        return {
          stdout: status(
            services.map((service, index) => ({
              ...service,
              state: statusReads >= (index === 0 ? 2 : 3) ? 4 : 2
            }))
          ),
          stderr: ''
        }
      }
      if (args[0] === 'version') return { stdout: '4.1.0\n', stderr: '' }
      throw new Error(`Unexpected mutation: ${args.join(' ')}`)
    })

    vi.useFakeTimers()
    try {
      const result = enableRemoteItServices(
        '/usr/local/bin/remoteit',
        4180,
        {
          active: 'app',
          appServiceId: 'app-service',
          browserServiceId: 'browser-service'
        },
        run
      )
      await vi.runAllTimersAsync()

      await expect(result).resolves.toMatchObject({
        installation: { service: { id: 'app-service', enabled: true, ready: true } }
      })
      expect(statusReads).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for asynchronous Windows service registration and keeps both mutations non-admin', async () => {
    const services = [
      {
        id: 'app-service',
        type: 7,
        addressHost: '127.0.0.1',
        addressPort: 44100,
        isEnabled: true,
        state: 4
      },
      {
        id: 'browser-service',
        type: 7,
        addressHost: '127.0.0.1',
        addressPort: 44100,
        isEnabled: true,
        state: 4
      }
    ]
    let statusReads = 0
    const run = vi.fn<RemoteItCommandRunner>(async (_command, args) => {
      if (args.join(' ') === 'status --json') {
        statusReads += 1
        const visibleServices =
          statusReads === 1 ? [] : statusReads === 2 ? services.slice(0, 1) : services
        return { stdout: status(visibleServices), stderr: '' }
      }
      if (args[0] === 'version') return { stdout: '4.1.0\n', stderr: '' }
      if (args[0] === 'service' && args[1] === 'add') {
        return { stdout: '{"code":0,"message":"netxt"}', stderr: '' }
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`)
    })

    vi.useFakeTimers()
    try {
      const result = expect(
        enableRemoteItServices(
          'C:\\Program Files\\Remote.It\\resources\\remoteit.exe',
          44100,
          { active: 'app' },
          run,
          'win32'
        )
      ).resolves.toMatchObject({
        appServiceId: 'app-service',
        browserServiceId: 'browser-service'
      })
      await vi.runAllTimersAsync()
      await result
    } finally {
      vi.useRealTimers()
    }

    const mutations = run.mock.calls.filter(([, args]) => args[0] === 'service')
    expect(mutations).toHaveLength(2)
    expect(mutations.every(([, args]) => args.includes('--noAdmin'))).toBe(true)
    expect(statusReads).toBe(3)
  })

  it('recovers existing named Windows services when local status omits their names', async () => {
    const services = [
      {
        id: 'app-service',
        type: 7,
        addressHost: '127.0.0.1',
        addressPort: 44100,
        isEnabled: true,
        state: 4
      },
      {
        id: 'browser-service',
        type: 7,
        addressHost: '127.0.0.1',
        addressPort: 44100,
        isEnabled: true,
        state: 4
      }
    ]
    const cloudResponse = JSON.stringify({
      code: 0,
      data: JSON.stringify({
        data: {
          login: {
            devices: {
              items: [
                {
                  id: 'device-1',
                  services: [
                    { id: 'app-service', name: 'Open Science Remote' },
                    { id: 'browser-service', name: 'System Service' }
                  ]
                }
              ]
            }
          }
        }
      })
    })
    const run = vi.fn<RemoteItCommandRunner>(async (_command, args) => {
      if (args.join(' ') === 'status --json') {
        return { stdout: status(services), stderr: '' }
      }
      if (args[0] === 'version') return { stdout: '4.1.0\n', stderr: '' }
      if (args[0] === 'exec-gql') return { stdout: cloudResponse, stderr: '' }
      throw new Error(`Unexpected command: ${args.join(' ')}`)
    })

    await expect(
      enableRemoteItServices(
        'C:\\Program Files\\Remote.It\\resources\\remoteit.exe',
        44100,
        { active: 'app' },
        run,
        'win32'
      )
    ).resolves.toMatchObject({
      appServiceId: 'app-service',
      browserServiceId: 'browser-service'
    })
    expect(run.mock.calls.filter(([, args]) => args[0] === 'exec-gql')).toHaveLength(1)
    expect(run.mock.calls.some(([, args]) => args[0] === 'service')).toBe(false)
  })

  it('persists newly created service IDs before status recovery and reuses them on retry', async () => {
    const services = [
      {
        id: 'app-service',
        type: 7,
        addressHost: '127.0.0.1',
        addressPort: 4180,
        isEnabled: true,
        state: 4
      },
      {
        id: 'browser-service',
        type: 7,
        addressHost: '127.0.0.1',
        addressPort: 4180,
        isEnabled: true,
        state: 4
      }
    ]
    let phase: 'initial' | 'restarting' | 'stable' = 'initial'
    let addCount = 0
    let persisted: { appServiceId?: string; browserServiceId?: string } = {}
    const run = vi.fn<RemoteItCommandRunner>(async (_command, args) => {
      if (args.join(' ') === 'status --json') {
        if (phase === 'initial') return { stdout: status(), stderr: '' }
        if (phase === 'stable') return { stdout: status(services), stderr: '' }
        throw new Error('Command failed: /usr/local/bin/remoteit status --json')
      }
      if (args[0] === 'version') return { stdout: '4.1.0\n', stderr: '' }
      if (args[0] === 'service' && args[1] === 'add') {
        addCount += 1
        if (addCount === 2) phase = 'restarting'
        const serviceId = args.includes('Open Science Remote') ? 'app-service' : 'browser-service'
        return { stdout: JSON.stringify({ code: 0, data: { serviceId } }), stderr: '' }
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`)
    })
    const remember = vi.fn(async (servicesToSave: typeof persisted) => {
      persisted = { ...persisted, ...servicesToSave }
    })

    vi.useFakeTimers()
    try {
      const firstAttempt = expect(
        enableRemoteItServices(
          '/usr/local/bin/remoteit',
          4180,
          { active: 'app', onServiceIdsDiscovered: remember },
          run,
          'linux'
        )
      ).rejects.toThrow('saved the new Service IDs')
      await vi.runAllTimersAsync()
      await firstAttempt
    } finally {
      vi.useRealTimers()
    }

    expect(persisted).toEqual({
      appServiceId: 'app-service',
      browserServiceId: 'browser-service'
    })
    expect(addCount).toBe(2)

    phase = 'stable'
    await expect(
      enableRemoteItServices(
        '/usr/local/bin/remoteit',
        4180,
        { active: 'app', ...persisted, onServiceIdsDiscovered: remember },
        run,
        'linux'
      )
    ).resolves.toMatchObject({
      appServiceId: 'app-service',
      browserServiceId: 'browser-service'
    })
    expect(addCount).toBe(2)
  })

  it('requires a pre-registered Device before preparing both services', async () => {
    const run = vi.fn<RemoteItCommandRunner>(async (_command, args) => {
      if (args.join(' ') === 'status --json') {
        return {
          stdout: JSON.stringify({
            code: 0,
            data: {
              owner: 'person@example.com',
              services: []
            }
          }),
          stderr: ''
        }
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`)
    })

    await expect(
      enableRemoteItServices('/usr/local/bin/remoteit', 4180, { active: 'app' }, run, 'darwin')
    ).rejects.toThrow('select This system')
    expect(run.mock.calls.some(([command]) => command === '/usr/bin/osascript')).toBe(false)
    expect(run.mock.calls.some(([, args]) => args[0] === 'device')).toBe(false)
    expect(run.mock.calls.some(([, args]) => args[0] === 'service')).toBe(false)
  })

  it('does not elevate Device registration when only the Desktop app is signed in', async () => {
    const run = vi.fn<RemoteItCommandRunner>(async (_command, args) => {
      if (args.join(' ') === 'status --json') {
        return {
          stdout: JSON.stringify({
            code: 0,
            data: {
              owner: '',
              device: { id: '', type: 0, state: 0, isEnabled: false },
              services: []
            }
          }),
          stderr: ''
        }
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`)
    })

    await expect(
      enableRemoteItService('/usr/local/bin/remoteit', 4180, { name: 'Open Science Remote' }, run)
    ).rejects.toThrow('complete Add Device once')
    expect(run.mock.calls.some(([command]) => command === '/usr/bin/osascript')).toBe(false)
    expect(run.mock.calls.some(([, args]) => args[0] === 'device' && args[1] === 'register')).toBe(
      false
    )
  })

  it('treats a registered Device as signed in when Remote.It omits the owner field', async () => {
    const run = vi.fn<RemoteItCommandRunner>(async (_command, args) => {
      if (args[0] === 'which') return { stdout: '', stderr: '' }
      if (args[0] === 'version') return { stdout: '4.1.0\n', stderr: '' }
      if (args.join(' ') === 'status --json') {
        return {
          stdout: JSON.stringify({
            code: 0,
            data: {
              owner: '',
              device: { id: 'device-1', type: 35, state: 4, isEnabled: true },
              services: [{ id: 'device-1', type: 35, state: 4, isEnabled: true }]
            }
          }),
          stderr: ''
        }
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`)
    })

    await expect(
      detectRemoteIt(undefined, run, 'darwin', {
        OPEN_SCIENCE_REMOTEIT_BIN: process.execPath
      })
    ).resolves.toMatchObject({
      installed: true,
      loggedIn: true,
      registered: true,
      deviceId: 'device-1'
    })
  })

  it('recreates the managed service when its stored ID was deleted', async () => {
    let added = false
    const run = vi.fn<RemoteItCommandRunner>(async (_command, args) => {
      if (args.join(' ') === 'status --json') {
        return {
          stdout: status(
            added
              ? [
                  {
                    id: 'service-recreated',
                    type: 7,
                    addressHost: '127.0.0.1',
                    addressPort: 4180,
                    isEnabled: true,
                    state: 4
                  }
                ]
              : []
          ),
          stderr: ''
        }
      }
      if (args[0] === 'version') return { stdout: '4.1.0\n', stderr: '' }
      if (args[0] === 'service' && args[1] === 'add') {
        added = true
        return { stdout: '{"code":0}', stderr: '' }
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`)
    })

    await expect(
      enableRemoteItService(
        '/usr/local/bin/remoteit',
        4180,
        { name: 'Open Science Remote', preferredServiceId: 'service-that-was-deleted' },
        run
      )
    ).resolves.toMatchObject({ serviceId: 'service-recreated' })
  })

  it('disables a service Persistent Public URL without administrator elevation', async () => {
    const run = vi.fn<RemoteItCommandRunner>().mockResolvedValue({
      stdout: JSON.stringify({
        code: 0,
        data: JSON.stringify({
          data: {
            setConnectLink: {
              enabled: false,
              service: { id: 'service-1' }
            }
          }
        })
      }),
      stderr: ''
    })

    await expect(
      disableRemoteItConnectLink('/usr/local/bin/remoteit', 'service-1', run)
    ).resolves.toBeUndefined()
    expect(run).toHaveBeenCalledWith(
      '/usr/local/bin/remoteit',
      [
        'exec-gql',
        '--noAdmin',
        '--json',
        '--query',
        expect.stringContaining('setConnectLink(serviceId: "service-1", enabled: false)')
      ],
      { timeoutMs: 30_000 }
    )
    expect(run.mock.calls.some(([command]) => command === '/usr/bin/osascript')).toBe(false)
  })
})
