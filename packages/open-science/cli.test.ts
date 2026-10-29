import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readdirSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { PUBLIC_TERMINAL_FIXTURE } from './test/fixtures'
import {
  CliUsageError,
  initCommand,
  parseCliArgs,
  reportCliError,
  runCli,
  runTaskCommand,
  startCommand,
  stopCommand,
  statusCommand
} from './cli.mjs'

const listProjects = async (): Promise<Array<{ id: string; name: string }>> => [
  { id: 'project-1', name: 'Research' }
]

describe('CLI help', () => {
  it.each([undefined, 'run', 'project', 'version', 'paths', 'mcp'])(
    'makes help %s equivalent to the help flag',
    async (command) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      try {
        await runCli([...(command ? [command] : []), '--help'])
        const expected = log.mock.calls.at(-1)?.[0]
        await runCli(['help', ...(command ? [command] : [])])
        expect(log).toHaveBeenLastCalledWith(expected)
        await expect(runCli(['help', 'unknown-command'])).rejects.toThrow('Unknown command')
      } finally {
        log.mockRestore()
      }
    }
  )

  it.each([
    ['--version', 'start'],
    ['version', '--port', '44100'],
    ['version', '--prompt', 'hello'],
    ['mcp', '--json'],
    ['mcp', '--port', '44100'],
    ['mcp', 'extra'],
    ['paths', '--force'],
    ['paths', 'extra'],
    ['paths', '--jsonl'],
    ['help', 'run', 'extra'],
    ['help', '--json'],
    ['start', '--version'],
    ['run', '-v']
  ])('rejects unrelated inputs to local commands: %j', (...argv) => {
    expect(() => parseCliArgs(argv)).toThrow(CliUsageError)
  })

  it('preserves version-looking prompt values', () => {
    expect(parseCliArgs(['run', '--project', 'demo', '--prompt', '--version'])).toMatchObject({
      command: 'run',
      options: { prompt: '--version' }
    })
  })

  it('omits the application update command while retaining resource updates', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await runCli(['--help'])
      const help = log.mock.calls.flat().join('\n')
      expect(help).not.toMatch(/^\s+update\s/m)
      expect(help).not.toContain('start/update')
      expect(help).toContain('project update')
      expect(help).toContain('session config update')
      expect(help).toContain('connector add | update')
      expect(help).toContain('credential list | add | update')
    } finally {
      log.mockRestore()
    }
  })

  it.each([
    'project',
    'runtime',
    'provider',
    'connector',
    'credential',
    'cli',
    'codex',
    'session',
    'settings',
    'plan',
    'artifacts'
  ])(
    'recognizes help flags for the %s group without consuming them as subcommands',
    async (command) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      try {
        for (const flag of ['--help', '-h']) {
          expect(parseCliArgs([command, flag])).toMatchObject({ command, options: { help: true } })
          expect(parseCliArgs([command, flag]).subcommand).toBeUndefined()
          await runCli([command, flag])
          expect(log).toHaveBeenLastCalledWith(
            expect.stringContaining(`Usage: open-science ${command} <subcommand>`)
          )
        }
      } finally {
        log.mockRestore()
      }
    }
  )

  it.each([
    ['doctor', '--help'],
    ['project', 'create', '--help'],
    ['project', 'session-defaults', 'update', '--help'],
    ['session', 'config', 'update', '--help'],
    ['provider', 'add', '--help'],
    ['run', '--help']
  ])('prints help for %j without execution arguments or backend access', async (...argv) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await runCli(argv)
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`Usage: open-science ${argv[0]}`))
    } finally {
      log.mockRestore()
    }
  })

  it('limits project help to project commands and retains errors for unknown input', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await runCli(['project', '--help'])
      const output = String(log.mock.calls[0][0])
      expect(output).toContain('project create <name>')
      expect(output).toContain('project session-defaults update')
      expect(output).not.toContain('runtime install')
      await expect(runCli(['unknown-command', '--help'])).rejects.toThrow('Unknown command')
      expect(() => parseCliArgs(['project', '--typo'])).toThrow('Unknown option')
      expect(() => parseCliArgs(['doctor'])).toThrow('doctor requires --json.')
    } finally {
      log.mockRestore()
    }
  })
})

describe('task CLI', () => {
  it('prepares Codex through the public task client', async () => {
    const bootstrap = vi.fn().mockResolvedValue({ ok: true })
    await runTaskCommand(parseCliArgs(['runtime', 'install', 'codex', '--json']), {
      connect: async () => ({ bootstrap }),
      log: vi.fn()
    })
    expect(bootstrap).toHaveBeenCalledWith({ action: 'runtime' }, { timeoutMs: 600_000 })
  })

  it('reads only the named API credential environment variable and does not print it', async () => {
    const bootstrap = vi.fn().mockResolvedValue({ ok: true, providerId: 'cli-openai' })
    const log = vi.fn()
    await runTaskCommand(
      parseCliArgs([
        'provider',
        'add',
        '--type',
        'official',
        '--vendor',
        'openai',
        '--model',
        'gpt-test',
        '--api-key-env',
        'LAB_KEY',
        '--json'
      ]),
      {
        connect: async () => ({ bootstrap }),
        env: { LAB_KEY: 'synthetic-secret', OTHER_KEY: 'ambient' },
        log
      }
    )
    expect(bootstrap).toHaveBeenCalledWith(
      { action: 'provider', key: 'synthetic-secret', model: 'gpt-test' },
      expect.any(Object)
    )
    expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-secret')
    expect(() => parseCliArgs(['provider', 'add', '--api-key', 'secret'])).toThrow()
  })
  it('accepts --profile as the forward-compatible profile spelling', () => {
    expect(parseCliArgs(['init', '--profile', '/tmp/open-science-profile']).options).toMatchObject({
      configRoot: '/tmp/open-science-profile'
    })
  })

  it('initializes a config root without starting the desktop app', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-cli-init-'))
    const log = vi.fn()
    await expect(
      initCommand(
        { configRoot: root, json: true },
        { log, locateBackend: vi.fn().mockResolvedValue({ development: true }) }
      )
    ).resolves.toEqual({
      configRoot: root,
      initialized: true
    })
    expect(log).toHaveBeenCalledWith(JSON.stringify({ configRoot: root, initialized: true }))
    await expect(stat(root)).resolves.toMatchObject({ isDirectory: expect.any(Function) })
    await rm(root, { recursive: true, force: true })
  })

  it('allows an explicit profile for an installed Node backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-installed-profile-'))
    try {
      await expect(
        initCommand(
          { configRoot: root },
          { log: vi.fn(), locateBackend: vi.fn().mockResolvedValue({ development: false }) }
        )
      ).resolves.toMatchObject({ configRoot: root })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'closes the launch log descriptor when installation protection fails',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'open-science-start-protection-'))
      const stateFile = join(root, 'state-file')
      await writeFile(stateFile, '')
      vi.stubEnv('OPEN_SCIENCE_INSTALLATION_STATE_ROOT', stateFile)
      const openDescriptors = (): number => readdirSync('/dev/fd').length
      const before = openDescriptors()
      try {
        await expect(
          startCommand(
            { configRoot: join(root, 'profile'), port: 1 },
            {
              log: vi.fn(),
              warn: vi.fn(),
              findServiceState: vi.fn().mockResolvedValue(undefined),
              fetch: vi.fn().mockRejectedValue(new Error('offline')),
              locateBackend: vi.fn().mockResolvedValue({
                development: false,
                command: process.execPath,
                entry: join(root, 'backend/out/backend/index.cjs')
              })
            }
          )
        ).rejects.toThrow()
        expect(openDescriptors()).toBe(before)
      } finally {
        vi.unstubAllEnvs()
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('requires JSON output for doctor', () => {
    expect(() => parseCliArgs(['doctor'])).toThrow('doctor requires --json.')
  })

  it('prints the doctor readiness contract as valid JSON', async () => {
    const report = {
      ready: false,
      checks: {
        daemon: { status: 'ready' },
        runtime: { status: 'missing', framework: 'codex' },
        provider: { status: 'not_ready', reason: 'credential_invalid' },
        skills: { status: 'ready', enabled: ['literature-review'] }
      },
      next: [{ code: 'runtime_missing' }, { code: 'provider_not_ready' }]
    }
    const log = vi.fn()

    await runTaskCommand(parseCliArgs(['doctor', '--json']), {
      connect: vi.fn().mockResolvedValue({ doctor: vi.fn().mockResolvedValue(report) }),
      log,
      stdinIsTTY: true
    })

    expect(JSON.parse(log.mock.calls[0][0])).toEqual(report)
  })

  it('reports a concrete startup command when doctor cannot reach a daemon', async () => {
    const log = vi.fn()
    const setExitCode = vi.fn()
    await runTaskCommand(parseCliArgs(['doctor', '--json']), {
      connect: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('unavailable'), { code: 'daemon_unavailable' })),
      log,
      setExitCode
    })
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      ready: false,
      checks: { daemon: { status: 'missing' } },
      next: [{ code: 'daemon_unavailable', argv: ['start', '--no-open'] }]
    })
    expect(setExitCode).toHaveBeenCalledWith(3)
  })

  it.each([401, 403, 500])(
    'does not describe an HTTP %s health rejection as a missing daemon',
    async (status) => {
      const log = vi.fn()
      const error = Object.assign(new Error('health rejected'), {
        code: 'daemon_unavailable',
        status
      })
      await expect(
        runTaskCommand(parseCliArgs(['doctor', '--json']), {
          connect: vi.fn().mockRejectedValue(error),
          log
        })
      ).rejects.toBe(error)
      expect(log).not.toHaveBeenCalled()
    }
  )

  it('parses runtime list', () => {
    expect(parseCliArgs(['runtime', 'list'])).toMatchObject({
      command: 'runtime',
      subcommand: 'list',
      options: { json: false }
    })
    expect(parseCliArgs(['runtime', 'list', '--json'])).toMatchObject({
      command: 'runtime',
      subcommand: 'list',
      options: { json: true }
    })
  })

  it('prints runtime list in human-readable and JSON forms', async () => {
    const runtimes = [
      { framework: 'claude-code', status: 'ready', version: '2.1.0', source: 'managed' },
      { framework: 'codex', status: 'missing' }
    ]
    const listRuntimes = vi.fn().mockResolvedValue(runtimes)
    const humanLog = vi.fn()
    const jsonLog = vi.fn()

    await runTaskCommand(parseCliArgs(['runtime', 'list']), {
      connect: vi.fn().mockResolvedValue({ listRuntimes }),
      log: humanLog,
      stdinIsTTY: true
    })
    await runTaskCommand(parseCliArgs(['runtime', 'list', '--json']), {
      connect: vi.fn().mockResolvedValue({ listRuntimes }),
      log: jsonLog,
      stdinIsTTY: true
    })

    expect(humanLog.mock.calls.map(([line]) => line)).toEqual([
      'FRAMEWORK\tSTATUS\tVERSION\tSOURCE',
      'claude-code\tready\t2.1.0\tmanaged',
      'codex\tmissing\t-\t-'
    ])
    expect(JSON.parse(jsonLog.mock.calls[0][0])).toEqual(runtimes)
  })

  it('rejects ports that are not complete decimal values', () => {
    expect(() => parseCliArgs(['start', '--port', '44100xyz'])).toThrow('Invalid port: 44100xyz')
    expect(parseCliArgs(['start', '--port', '0']).options.port).toBe(0)
    expect(() => parseCliArgs(['start', '--port', '-1'])).toThrow('Invalid port: -1')
  })

  it.each([
    { argv: ['start', 'unexpected'], message: 'start accepts no arguments.' },
    { argv: ['stop', 'unexpected'], message: 'stop accepts no arguments.' },
    { argv: ['status', 'unexpected'], message: 'status accepts no arguments.' },
    { argv: ['url', 'unexpected'], message: 'url accepts no arguments.' },
    {
      argv: ['codex', 'login', 'unexpected'],
      message: 'codex login accepts no arguments.'
    },
    { argv: ['project', 'list', 'unexpected'], message: 'project list accepts no arguments.' },
    {
      argv: ['run', 'unexpected', '--project', 'project-1', '--prompt', 'Research this.'],
      message: 'run accepts no arguments.'
    },
    { argv: ['run', 'status', 'run-1', 'run-2'], message: 'run status accepts one argument.' },
    { argv: ['run', 'cancel', 'run-1', 'run-2'], message: 'run cancel accepts one argument.' },
    {
      argv: ['session', 'status', 'session-1', 'session-2'],
      message: 'session status accepts one argument.'
    },
    {
      argv: ['session', 'config', 'show', 'session-1', 'session-2'],
      message: 'session config accepts two arguments.'
    },
    {
      argv: ['session', 'config', 'update', 'session-1', 'session-2'],
      message: 'session config accepts two arguments.'
    },
    {
      argv: ['settings', 'agent-routing', 'show', 'unexpected'],
      message: 'settings agent-routing accepts one argument.'
    },
    {
      argv: ['settings', 'agent-routing', 'update', 'unexpected'],
      message: 'settings agent-routing accepts one argument.'
    },
    {
      argv: ['plan', 'show', 'session-1', 'session-2'],
      message: 'plan show accepts one argument.'
    },
    {
      argv: ['plan', 'approve', 'session-1', 'session-2'],
      message: 'plan approve accepts one argument.'
    },
    {
      argv: ['plan', 'reject', 'session-1', 'session-2'],
      message: 'plan reject accepts one argument.'
    },
    {
      argv: ['plan', 'revise', 'session-1', 'session-2'],
      message: 'plan revise accepts one argument.'
    },
    {
      argv: ['artifacts', 'list', 'session-1', 'session-2'],
      message: 'artifacts list accepts one argument.'
    },
    {
      argv: ['artifacts', 'download', 'artifact-1', 'artifact-2'],
      message: 'artifacts download accepts one argument.'
    }
  ])('rejects unused positional arguments before dispatch', ({ argv, message }) => {
    expect(() => parseCliArgs(argv)).toThrow(message)
  })

  it.each([
    ['create', ['project', 'create', 'Systematic', 'review'], ['Systematic', 'review']],
    ['update', ['project', 'update', 'Systematic', 'review'], ['Systematic', 'review']],
    [
      'session-defaults show',
      ['project', 'session-defaults', 'show', 'Systematic', 'review'],
      ['show', 'Systematic', 'review']
    ],
    [
      'session-defaults update',
      ['project', 'session-defaults', 'update', 'Systematic', 'review'],
      ['update', 'Systematic', 'review']
    ]
  ])('preserves a multi-word Project name for project %s', (_label, argv, positionals) => {
    expect(parseCliArgs(argv).positionals).toEqual(positionals)
  })

  it('parses the first milestone run interface', () => {
    expect(
      parseCliArgs(['project', 'create', 'Research', '--agent-context', 'Always cite sources.'])
    ).toMatchObject({
      command: 'project',
      subcommand: 'create',
      options: { agentContext: 'Always cite sources.' }
    })
    expect(
      parseCliArgs([
        'project',
        'update',
        'Research',
        '--name',
        'Evidence review',
        '--clear-agent-context'
      ])
    ).toMatchObject({
      command: 'project',
      subcommand: 'update',
      options: { name: 'Evidence review', clearAgentContext: true }
    })
    expect(() =>
      parseCliArgs([
        'project',
        'create',
        'Research',
        '--agent-context',
        'Inline',
        '--agent-context-file',
        'context.md'
      ])
    ).toThrow('Use only one Agent Context source.')
    expect(() =>
      parseCliArgs(['project', 'create', 'Research', '--agent-context', 'x'.repeat(16_001)])
    ).toThrow('Agent Context must not exceed 16000 characters.')
    expect(
      parseCliArgs([
        'run',
        '--project',
        'systematic-review',
        '--prompt-file',
        'task.md',
        '--session',
        'session-1',
        '--cwd',
        'workspace',
        '--approval-profile',
        'auto',
        '--wait',
        '--json'
      ])
    ).toEqual({
      command: 'run',
      options: {
        open: true,
        json: true,
        jsonl: false,
        wait: true,
        project: 'systematic-review',
        promptFile: 'task.md',
        session: 'session-1',
        cwd: 'workspace',
        approvalProfile: 'auto'
      }
    })
    expect(parseCliArgs(['run', 'status', 'run-1', '--json'])).toEqual({
      command: 'run',
      subcommand: 'status',
      positionals: ['run-1'],
      options: { open: true, json: true, jsonl: false, wait: false }
    })
    expect(parseCliArgs(['run', 'cancel', 'run-1', '--json'])).toEqual({
      command: 'run',
      subcommand: 'cancel',
      positionals: ['run-1'],
      options: { open: true, json: true, jsonl: false, wait: false }
    })
    expect(
      parseCliArgs([
        'run',
        '--project',
        'project-1',
        '--prompt',
        'Research this.',
        '--wait',
        '--timeout-ms',
        '60000'
      ]).options.timeoutMs
    ).toBe(60_000)
    expect(() => parseCliArgs(['run', '--jsonl'])).toThrow('--jsonl requires run --wait.')
    expect(() => parseCliArgs(['run', '--timeout-ms', '0', '--wait'])).toThrow('Invalid timeout: 0')
    expect(() => parseCliArgs(['run', '--timeout-ms', '1000'])).toThrow(
      '--timeout-ms requires run --wait or session export/import.'
    )
    expect(() => parseCliArgs(['run', '--cancel-on-timeout', '--wait'])).toThrow(
      '--cancel-on-timeout requires --timeout-ms.'
    )
    expect(
      parseCliArgs([
        'run',
        '--project',
        'project-1',
        '--prompt',
        'Research this.',
        '--wait',
        '--timeout-ms',
        '1000',
        '--cancel-on-timeout'
      ]).options.cancelOnTimeout
    ).toBe(true)
    expect(
      parseCliArgs([
        'run',
        '--project',
        'project-1',
        '--prompt',
        'Research this.',
        '--session',
        'session-1',
        '--approval-profile',
        'full',
        '--skill',
        'literature-review',
        '--skill',
        'citation-check',
        '--plan-first',
        '--auto-review',
        '--specialist',
        'literature-specialist',
        '--delegation',
        'deny',
        '--wait',
        '--return-on-attention'
      ])
    ).toMatchObject({
      command: 'run',
      options: {
        session: 'session-1',
        approvalProfile: 'full',
        skills: ['literature-review', 'citation-check'],
        planFirst: true,
        autoReviewEnabled: true,
        specialist: 'literature-specialist',
        delegation: 'deny',
        returnOnAttention: true
      }
    })
    expect(() => parseCliArgs(['run', '--delegation', 'sometimes'])).toThrow(
      'Invalid delegation policy: sometimes'
    )
    expect(() => parseCliArgs(['run', '--return-on-attention'])).toThrow(
      '--return-on-attention requires run --wait.'
    )
    expect(() => parseCliArgs(['run', '--auto-review', '--no-auto-review'])).toThrow(
      'Use only one of --auto-review or --no-auto-review.'
    )
    expect(parseCliArgs(['plan', 'show', 'session-1', '--json'])).toMatchObject({
      command: 'plan',
      subcommand: 'show',
      positionals: ['session-1']
    })
    expect(() => parseCliArgs(['run', '--approval-profile', 'unsafe'])).toThrow(
      'Invalid approval profile: unsafe'
    )
    expect(() => parseCliArgs(['run', '--json', '--jsonl', '--wait'])).toThrow(
      'Use only one of --json or --jsonl.'
    )
    expect(() => parseCliArgs(['run', 'status', 'run-1', '--cwd', '.'])).toThrow(
      '--cwd requires run.'
    )
    expect(() => parseCliArgs(['run', '--cwd', '   '])).toThrow('--cwd requires a non-empty path.')
    expect(() => parseCliArgs(['status', '--unknown'])).toThrow('Unknown option: --unknown')
    expect(parseCliArgs(['codex', 'login', '--force'])).toEqual({
      command: 'codex',
      subcommand: 'login',
      options: { open: true, json: false, force: true }
    })
    expect(() => parseCliArgs(['codex', 'login', '--json'])).toThrow(
      'codex login does not support machine-readable output.'
    )
    expect(() => parseCliArgs(['codex', 'login', 'extra'])).toThrow(
      'codex login accepts no arguments.'
    )
    expect(() => parseCliArgs(['status', '--force'])).toThrow(
      '--force requires stop or codex login.'
    )
    expect(
      parseCliArgs([
        'run',
        '--compute-host',
        'ssh:alpha',
        '--compute-host',
        'ssh:beta',
        '--compute-host',
        'ssh:alpha'
      ]).options.computeHosts
    ).toEqual(['ssh:alpha', 'ssh:beta', 'ssh:alpha'])
    expect(() => parseCliArgs(['run', '--compute-host'])).toThrow(
      '--compute-host requires a value.'
    )
  })

  it('parses Session, Project-default, and Agent-routing configuration commands', () => {
    expect(() => parseCliArgs(['run', '--provider', 'provider-1'])).toThrow(
      '--provider requires --model or --provider-default-model.'
    )
    expect(
      parseCliArgs([
        'session',
        'config',
        'update',
        'session-1',
        '--revision',
        '4',
        '--provider',
        'provider-1',
        '--provider-default-model',
        '--reasoning-effort',
        'high',
        '--no-memory',
        '--enable-compute-host',
        'ssh:alpha',
        '--compute-host',
        'ssh:alpha'
      ])
    ).toMatchObject({
      command: 'session',
      subcommand: 'config',
      positionals: ['update', 'session-1'],
      options: {
        revision: 4,
        provider: 'provider-1',
        providerDefaultModel: true,
        reasoningEffort: 'high',
        memoryEnabled: false,
        enabledComputeHosts: ['ssh:alpha'],
        computeHosts: ['ssh:alpha']
      }
    })
    expect(
      parseCliArgs([
        'project',
        'session-defaults',
        'update',
        'Research',
        '--clear-provider',
        '--clear-specialist'
      ])
    ).toMatchObject({
      command: 'project',
      subcommand: 'session-defaults',
      positionals: ['update', 'Research'],
      options: { clearProvider: true, clearSpecialist: true }
    })
    expect(
      parseCliArgs([
        'settings',
        'agent-routing',
        'update',
        '--framework',
        'codex',
        '--reviewer-inherit',
        '--subagent-provider',
        'provider-1',
        '--subagent-model',
        'model-1'
      ])
    ).toMatchObject({
      command: 'settings',
      subcommand: 'agent-routing',
      positionals: ['update'],
      options: {
        framework: 'codex',
        reviewerInherit: true,
        subagentProvider: 'provider-1',
        subagentModel: 'model-1'
      }
    })
    expect(() =>
      parseCliArgs([
        'session',
        'config',
        'update',
        'session-1',
        '--revision',
        '4',
        '--clear-compute-hosts',
        '--enable-compute-host',
        'ssh:alpha'
      ])
    ).toThrow('Use only one of Compute Host selection options or --clear-compute-hosts.')
    expect(() =>
      parseCliArgs(['run', '--session', 'session-1', '--enable-compute-host', 'ssh:alpha'])
    ).toThrow('--enable-compute-host cannot update an existing Session; use session config update.')
    expect(() => parseCliArgs(['run', '--session', 'session-1', '--clear-compute-hosts'])).toThrow(
      '--clear-compute-hosts cannot update an existing Session; use session config update.'
    )
  })

  it('dispatches atomic configuration updates with their concurrency tokens', async () => {
    const client = {
      listProjects: vi.fn(listProjects),
      getProjectSessionDefaults: vi.fn().mockResolvedValue({
        projectId: 'project-1',
        updatedAt: 10,
        configured: { computeHosts: { enabled: [], selected: [] } }
      }),
      updateProjectSessionDefaults: vi.fn().mockResolvedValue({ projectId: 'project-1' }),
      getSessionConfiguration: vi.fn().mockResolvedValue({
        sessionId: 'session-1',
        revision: 4,
        persisted: { computeHosts: { enabled: ['ssh:alpha'], selected: [] } }
      }),
      updateSessionConfiguration: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      updateAgentRouting: vi.fn().mockResolvedValue({ configured: {} })
    }
    const deps = { connect: vi.fn().mockResolvedValue(client), log: vi.fn(), stdinIsTTY: true }

    await runTaskCommand(
      parseCliArgs([
        'project',
        'session-defaults',
        'update',
        'Research',
        '--approval-profile',
        'auto',
        '--clear-memory'
      ]),
      deps
    )
    expect(client.updateProjectSessionDefaults).toHaveBeenCalledWith('project-1', {
      expectedUpdatedAt: 10,
      patch: { permissionProfile: 'auto', memoryEnabled: null }
    })

    await runTaskCommand(
      parseCliArgs([
        'session',
        'config',
        'update',
        'session-1',
        '--revision',
        '4',
        '--compute-host',
        'ssh:alpha'
      ]),
      deps
    )
    expect(client.updateSessionConfiguration).toHaveBeenCalledWith('session-1', {
      expectedRevision: 4,
      computeHosts: { enabled: ['ssh:alpha'], selected: ['ssh:alpha'] }
    })

    await runTaskCommand(
      parseCliArgs([
        'settings',
        'agent-routing',
        'update',
        '--framework',
        'codex',
        '--reviewer-inherit'
      ]),
      deps
    )
    expect(client.updateAgentRouting).toHaveBeenCalledWith({
      framework: 'codex',
      reviewer: { mode: 'inherit' }
    })
  })

  it('sends Compute hosts only when the repeatable flag is present and prints authority JSON', async () => {
    const authorityRun = {
      id: 'run-compute',
      sessionId: 'session-compute',
      projectId: 'project-1',
      status: 'running',
      preferredComputeHostIds: ['ssh:authority'],
      artifacts: []
    }
    const client = {
      listProjects,
      startRun: vi.fn().mockResolvedValue(authorityRun)
    }
    const log = vi.fn()

    await runTaskCommand(
      {
        command: 'run',
        options: {
          project: 'project-1',
          prompt: 'Research this.',
          session: 'session-1',
          computeHosts: ['ssh:alpha', 'ssh:beta', 'ssh:alpha'],
          wait: false,
          json: true,
          jsonl: false
        }
      },
      { connect: vi.fn().mockResolvedValue(client), log, stdinIsTTY: true }
    )

    expect(client.startRun).toHaveBeenCalledWith({
      project: 'project-1',
      prompt: 'Research this.',
      sessionId: 'session-1',
      computeHostIds: ['ssh:alpha', 'ssh:beta', 'ssh:alpha']
    })
    expect(JSON.parse(log.mock.calls[0][0]).preferredComputeHostIds).toEqual(['ssh:authority'])
  })

  it('clears inherited Compute Host access and selection for a new Session', async () => {
    const client = {
      listProjects,
      startRun: vi
        .fn()
        .mockResolvedValue({ id: 'run-1', sessionId: 'session-1', status: 'running' })
    }

    await runTaskCommand(
      {
        command: 'run',
        options: {
          project: 'project-1',
          prompt: 'Run locally.',
          clearComputeHosts: true,
          wait: false,
          json: true,
          jsonl: false
        }
      },
      { connect: vi.fn().mockResolvedValue(client), log: vi.fn(), stdinIsTTY: true }
    )

    expect(client.startRun).toHaveBeenCalledWith({
      project: 'project-1',
      prompt: 'Run locally.',
      enabledComputeHostIds: [],
      computeHostIds: []
    })
  })

  it('rejects the startup sandbox option on other commands', () => {
    expect(() => parseCliArgs(['status', '--no-sandbox'])).toThrow('--no-sandbox requires start.')
  })

  it('reads a prompt file, waits for completion, and emits one JSON result', async () => {
    const client = {
      listProjects,
      startRun: vi.fn().mockResolvedValue({ id: 'run-1', status: 'running' }),
      waitForRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        status: 'completed',
        startedAt: 1,
        completedAt: 2,
        output: 'Done',
        artifacts: []
      })
    }
    const log = vi.fn()

    await runTaskCommand(
      {
        command: 'run',
        options: {
          project: 'project-1',
          promptFile: 'task.md',
          cwd: 'workspace',
          approvalProfile: 'auto',
          wait: true,
          json: true,
          jsonl: false
        }
      },
      {
        connect: vi.fn().mockResolvedValue(client),
        readFile: vi.fn().mockResolvedValue('Research this.\n'),
        log,
        stdinIsTTY: true
      }
    )

    expect(client.startRun).toHaveBeenCalledWith({
      project: 'project-1',
      prompt: 'Research this.',
      cwd: resolve('workspace'),
      permissionProfile: 'auto'
    })
    expect(client.waitForRun).toHaveBeenCalledWith('run-1')
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ status: 'completed', output: 'Done' })
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('resolves an exact project name to its id before starting a run', async () => {
    const client = {
      listProjects: vi.fn(listProjects),
      startRun: vi
        .fn()
        .mockResolvedValue({ id: 'run-1', sessionId: 'session-1', status: 'running' })
    }

    await runTaskCommand(
      {
        command: 'run',
        options: {
          project: 'Research',
          prompt: 'Review these papers.',
          wait: false,
          json: true,
          jsonl: false
        }
      },
      { connect: vi.fn().mockResolvedValue(client), log: vi.fn(), stdinIsTTY: true }
    )

    expect(client.startRun).toHaveBeenCalledWith({
      project: 'project-1',
      prompt: 'Review these papers.'
    })
  })

  it('requires an id when project names are duplicated', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue([
        { id: 'project-1', name: 'Research' },
        { id: 'project-2', name: 'Research' }
      ]),
      startRun: vi.fn()
    }

    await expect(
      runTaskCommand(
        {
          command: 'run',
          options: {
            project: 'Research',
            prompt: 'Review these papers.',
            wait: false,
            json: true,
            jsonl: false
          }
        },
        { connect: vi.fn().mockResolvedValue(client), stdinIsTTY: true }
      )
    ).rejects.toThrow('Project name is ambiguous: Research. Use a project ID.')
    expect(client.startRun).not.toHaveBeenCalled()
  })

  it('forwards execution controls and can return on actionable Plan attention', async () => {
    const attention = {
      kind: 'plan-approval',
      plan: { artifactVersionId: 'plan-version', revision: 4 }
    }
    const client = {
      listProjects,
      startRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        status: 'running'
      }),
      waitForRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        status: 'running',
        startedAt: 1,
        artifacts: [],
        attention
      })
    }
    const log = vi.fn()

    await runTaskCommand(
      {
        command: 'run',
        options: {
          project: 'project-1',
          prompt: 'Plan this.',
          wait: true,
          returnOnAttention: true,
          planFirst: true,
          autoReviewEnabled: true,
          specialist: 'literature-specialist',
          delegation: 'deny',
          json: false,
          jsonl: false
        }
      },
      {
        connect: vi.fn().mockResolvedValue(client),
        log,
        stdinIsTTY: true
      }
    )

    expect(client.startRun).toHaveBeenCalledWith({
      project: 'project-1',
      prompt: 'Plan this.',
      turnIntent: 'plan-first',
      autoReviewEnabled: true,
      specialist: 'literature-specialist',
      delegationPolicy: 'deny'
    })
    expect(client.waitForRun).toHaveBeenCalledWith('run-1', {
      returnOnAttention: true
    })
    expect(log).toHaveBeenCalledWith(
      'Run is waiting for Plan approval: open-science plan approve session-1 --artifact-version plan-version --revision 4'
    )
  })

  it('rejects the retired rollback command and its exclusive options', async () => {
    await expect(runCli(['rollback-to-0.7.3'])).rejects.toThrow(
      'Unknown command: rollback-to-0.7.3'
    )
    for (const option of ['--yes', '--data-root']) {
      expect(() => parseCliArgs(['status', option])).toThrow(`Unknown option: ${option}`)
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await runCli(['--help'])
      const help = log.mock.calls.flat().join('\n')
      expect(help).not.toMatch(/rollback-to-0\.7\.3|--yes|--data-root/)
      expect(help).toContain('--output <path>')
    } finally {
      log.mockRestore()
    }
  })

  it('dispatches project, session, and artifact commands through the SDK', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue([{ id: 'project-1', name: 'Research' }]),
      createProject: vi.fn().mockResolvedValue({ id: 'project-2', name: 'Created' }),
      getSession: vi.fn().mockResolvedValue({ id: 'session-1', status: 'idle' }),
      getRun: vi.fn().mockResolvedValue({ id: 'run-1', status: 'completed' }),
      cancelRun: vi.fn().mockResolvedValue({ id: 'run-1', status: 'cancelled' }),
      listArtifacts: vi.fn().mockResolvedValue([{ id: 'artifact-1', name: 'report.md' }]),
      downloadArtifact: vi.fn().mockResolvedValue(new Response('report'))
    }
    const connect = vi.fn().mockResolvedValue(client)
    const log = vi.fn()
    const writeDownload = vi.fn().mockResolvedValue(undefined)
    const deps = { connect, log, writeDownload }

    await runTaskCommand(
      { command: 'project', subcommand: 'list', options: { json: true, jsonl: false } },
      deps
    )
    await runTaskCommand(
      {
        command: 'run',
        subcommand: 'cancel',
        positionals: ['run-1'],
        options: { json: true, jsonl: false }
      },
      deps
    )
    await runTaskCommand(
      {
        command: 'project',
        subcommand: 'create',
        positionals: ['Created'],
        options: { json: true, jsonl: false }
      },
      deps
    )
    await runTaskCommand(
      {
        command: 'session',
        subcommand: 'status',
        positionals: ['session-1'],
        options: { json: true, jsonl: false }
      },
      deps
    )
    await runTaskCommand(
      {
        command: 'run',
        subcommand: 'status',
        positionals: ['run-1'],
        options: { json: true, jsonl: false }
      },
      deps
    )
    await runTaskCommand(
      {
        command: 'artifacts',
        subcommand: 'list',
        positionals: ['session-1'],
        options: { json: true, jsonl: false }
      },
      deps
    )
    await runTaskCommand(
      {
        command: 'artifacts',
        subcommand: 'download',
        positionals: ['artifact-1'],
        options: { output: 'report.md', json: true, jsonl: false }
      },
      deps
    )

    expect(client.createProject).toHaveBeenCalledWith({ name: 'Created', description: undefined })
    expect(client.getSession).toHaveBeenCalledWith('session-1')
    expect(client.getRun).toHaveBeenCalledWith('run-1')
    expect(client.cancelRun).toHaveBeenCalledWith('run-1')
    expect(client.listArtifacts).toHaveBeenCalledWith('session-1')
    expect(client.downloadArtifact).toHaveBeenCalledWith('artifact-1')
    expect(writeDownload).toHaveBeenCalledWith(expect.any(Response), 'report.md')
  })

  it('preserves an existing artifact output when the download stream fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-science-cli-download-'))
    const output = join(directory, 'report.md')
    await writeFile(output, 'existing report')
    const failure = new Error('download interrupted')
    let pullCount = 0
    const response = new Response(
      new ReadableStream({
        async pull(controller) {
          if (pullCount++ === 0) {
            controller.enqueue(new TextEncoder().encode('partial replacement'))
          } else {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
            controller.error(failure)
          }
        }
      })
    )
    const client = { downloadArtifact: vi.fn().mockResolvedValue(response) }

    try {
      await expect(
        runTaskCommand(
          {
            command: 'artifacts',
            subcommand: 'download',
            positionals: ['artifact-1'],
            options: { output, json: true, jsonl: false }
          },
          { connect: vi.fn().mockResolvedValue(client), log: vi.fn() }
        )
      ).rejects.toBe(failure)

      expect(await readFile(output, 'utf8')).toBe('existing report')
      expect(await readdir(directory)).toEqual(['report.md'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('replaces an existing artifact output after the complete download succeeds', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-science-cli-download-'))
    const output = join(directory, 'report.md')
    await writeFile(output, 'existing report')
    const client = {
      downloadArtifact: vi.fn().mockResolvedValue(new Response('replacement report'))
    }

    try {
      await runTaskCommand(
        {
          command: 'artifacts',
          subcommand: 'download',
          positionals: ['artifact-1'],
          options: { output, json: true, jsonl: false }
        },
        { connect: vi.fn().mockResolvedValue(client), log: vi.fn() }
      )

      expect(await readFile(output, 'utf8')).toBe('replacement report')
      expect(await readdir(directory)).toEqual(['report.md'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform !== 'win32')(
    'preserves existing artifact output permissions after replacement',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'open-science-cli-download-'))
      const output = join(directory, 'report.md')
      await writeFile(output, 'existing report')
      await chmod(output, 0o600)
      const client = {
        downloadArtifact: vi.fn().mockResolvedValue(new Response('replacement report'))
      }

      try {
        await runTaskCommand(
          {
            command: 'artifacts',
            subcommand: 'download',
            positionals: ['artifact-1'],
            options: { output, json: true, jsonl: false }
          },
          { connect: vi.fn().mockResolvedValue(client), log: vi.fn() }
        )

        expect((await stat(output)).mode & 0o777).toBe(0o600)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it.runIf(process.platform !== 'win32')(
    'follows an existing artifact output symlink',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'open-science-cli-download-'))
      const target = join(directory, 'target.md')
      const output = join(directory, 'report.md')
      await writeFile(target, 'existing report')
      await symlink('target.md', output)
      const client = {
        downloadArtifact: vi.fn().mockResolvedValue(new Response('replacement report'))
      }

      try {
        await runTaskCommand(
          {
            command: 'artifacts',
            subcommand: 'download',
            positionals: ['artifact-1'],
            options: { output, json: true, jsonl: false }
          },
          { connect: vi.fn().mockResolvedValue(client), log: vi.fn() }
        )

        expect(await readlink(output)).toBe('target.md')
        expect(await readFile(target, 'utf8')).toBe('replacement report')
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it.runIf(process.platform !== 'win32')('follows a dangling artifact output symlink', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-science-cli-download-'))
    const target = join(directory, 'target.md')
    const output = join(directory, 'report.md')
    await symlink('target.md', output)
    const client = {
      downloadArtifact: vi.fn().mockResolvedValue(new Response('downloaded report'))
    }

    try {
      await runTaskCommand(
        {
          command: 'artifacts',
          subcommand: 'download',
          positionals: ['artifact-1'],
          options: { output, json: true, jsonl: false }
        },
        { connect: vi.fn().mockResolvedValue(client), log: vi.fn() }
      )

      expect(await readlink(output)).toBe('target.md')
      expect(await readFile(target, 'utf8')).toBe('downloaded report')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform !== 'win32')(
    'follows a 40-link artifact output symlink chain',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'open-science-cli-download-'))
      const target = join(directory, 'target.md')
      const output = join(directory, 'link-0.md')
      await writeFile(target, 'existing report')
      for (let index = 39; index >= 0; index -= 1) {
        await symlink(
          index === 39 ? 'target.md' : `link-${index + 1}.md`,
          join(directory, `link-${index}.md`)
        )
      }
      const client = {
        downloadArtifact: vi.fn().mockResolvedValue(new Response('replacement report'))
      }

      try {
        await runTaskCommand(
          {
            command: 'artifacts',
            subcommand: 'download',
            positionals: ['artifact-1'],
            options: { output, json: true, jsonl: false }
          },
          { connect: vi.fn().mockResolvedValue(client), log: vi.fn() }
        )

        expect(await readlink(output)).toBe('link-1.md')
        expect(await readFile(target, 'utf8')).toBe('replacement report')
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it('creates, updates, and clears persistent Project Agent Context without printing it', async () => {
    const projects = [
      {
        id: 'project-1',
        name: 'Research',
        description: '',
        updatedAt: 7,
        hasAgentContext: false
      }
    ]
    const client = {
      listProjects: vi.fn().mockResolvedValue(projects),
      createProject: vi.fn().mockResolvedValue({
        ...projects[0],
        id: 'project-2',
        hasAgentContext: true
      }),
      updateProject: vi.fn().mockResolvedValue({ ...projects[0], hasAgentContext: true })
    }
    const log = vi.fn()
    const dependencies = {
      connect: vi.fn().mockResolvedValue(client),
      readBinaryFile: vi.fn().mockResolvedValue(new TextEncoder().encode('Prefer Python.\n')),
      log,
      stdinIsTTY: true
    }

    await runTaskCommand(
      {
        command: 'project',
        subcommand: 'create',
        positionals: ['Created'],
        options: {
          agentContext: 'Always cite sources.',
          json: true,
          jsonl: false
        }
      },
      dependencies
    )
    await runTaskCommand(
      {
        command: 'project',
        subcommand: 'update',
        positionals: ['Research'],
        options: {
          agentContextFile: 'context.md',
          json: true,
          jsonl: false
        }
      },
      dependencies
    )
    await runTaskCommand(
      {
        command: 'project',
        subcommand: 'update',
        positionals: ['project-1'],
        options: {
          clearAgentContext: true,
          json: true,
          jsonl: false
        }
      },
      dependencies
    )

    expect(client.createProject).toHaveBeenCalledWith({
      name: 'Created',
      description: undefined,
      agentContext: 'Always cite sources.'
    })
    expect(client.updateProject).toHaveBeenNthCalledWith(1, 'project-1', {
      expectedUpdatedAt: 7,
      agentContext: 'Prefer Python.'
    })
    expect(client.updateProject).toHaveBeenNthCalledWith(2, 'project-1', {
      expectedUpdatedAt: 7,
      agentContext: ''
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain('Always cite sources.')
    expect(JSON.stringify(log.mock.calls)).not.toContain('Prefer Python.')
  })

  it('rejects invalid Agent Context files before mutating a Project', async () => {
    const client = {
      listProjects: vi
        .fn()
        .mockResolvedValue([
          { id: 'project-1', name: 'Research', updatedAt: 7, hasAgentContext: false }
        ]),
      updateProject: vi.fn()
    }
    const readBinaryFile = vi
      .fn()
      .mockResolvedValueOnce(Uint8Array.from([0xc3, 0x28]))
      .mockResolvedValueOnce(new TextEncoder().encode('  \n'))
      .mockResolvedValueOnce(new TextEncoder().encode('x'.repeat(16_001)))
    const dependencies = {
      connect: vi.fn().mockResolvedValue(client),
      readBinaryFile,
      stdinIsTTY: true
    }
    const updateFrom = (agentContextFile: string): Promise<void> =>
      runTaskCommand(
        {
          command: 'project',
          subcommand: 'update',
          positionals: ['Research'],
          options: { agentContextFile, json: true, jsonl: false }
        },
        dependencies
      )

    await expect(updateFrom('invalid.md')).rejects.toThrow(
      'Agent Context file must contain valid UTF-8 text.'
    )
    await expect(updateFrom('empty.md')).rejects.toThrow('Agent Context must not be empty.')
    await expect(updateFrom('oversized.md')).rejects.toThrow(
      'Agent Context must not exceed 16000 characters.'
    )
    expect(client.updateProject).not.toHaveBeenCalled()
  })

  it('dispatches Plan show, decision, and revision feedback through the SDK', async () => {
    const client = {
      getSessionPlan: vi.fn().mockResolvedValue({
        artifactVersionId: 'plan-version',
        revision: 2
      }),
      respondSessionPlan: vi.fn().mockResolvedValue({ changed: true })
    }
    const deps = {
      connect: vi.fn().mockResolvedValue(client),
      log: vi.fn()
    }
    const outputOptions = { json: true, jsonl: false }

    await runTaskCommand(
      {
        command: 'plan',
        subcommand: 'show',
        positionals: ['session-1'],
        options: outputOptions
      },
      deps
    )
    await runTaskCommand(
      {
        command: 'plan',
        subcommand: 'approve',
        positionals: ['session-1'],
        options: {
          ...outputOptions,
          artifactVersion: 'plan-version',
          revision: 2
        }
      },
      deps
    )
    await runTaskCommand(
      {
        command: 'plan',
        subcommand: 'revise',
        positionals: ['session-1'],
        options: { ...outputOptions, feedback: 'Split the validation step.' }
      },
      deps
    )

    expect(client.getSessionPlan).toHaveBeenCalledWith('session-1')
    expect(client.respondSessionPlan).toHaveBeenNthCalledWith(1, 'session-1', {
      decision: 'approved',
      artifactVersionId: 'plan-version',
      expectedRevision: 2
    })
    expect(client.respondSessionPlan).toHaveBeenNthCalledWith(2, 'session-1', {
      feedback: 'Split the validation step.'
    })
  })

  it('reads stdin, emits JSONL events, and sets a failed-run exit code', async () => {
    const client = {
      listProjects,
      events: async function* () {
        yield PUBLIC_TERMINAL_FIXTURE
      },
      startRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        status: 'running'
      }),
      waitForRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        status: 'failed',
        error: 'Provider failed',
        artifacts: []
      })
    }
    const log = vi.fn()
    const setExitCode = vi.fn()

    await runTaskCommand(
      {
        command: 'run',
        options: {
          project: 'project-1',
          wait: true,
          json: false,
          jsonl: true
        }
      },
      {
        connect: vi.fn().mockResolvedValue(client),
        readStdin: vi.fn().mockResolvedValue('Research from stdin.\n'),
        stdinIsTTY: false,
        log,
        setExitCode
      }
    )

    expect(client.startRun).toHaveBeenCalledWith({
      project: 'project-1',
      prompt: 'Research from stdin.'
    })
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      PUBLIC_TERMINAL_FIXTURE,
      expect.objectContaining({ id: 'run-1', status: 'failed' })
    ])
    expect(setExitCode).toHaveBeenCalledWith(1)
  })

  it('keeps run --session on the stable app id for Task API calls and events', async () => {
    const stableSessionId = 'stable-app-session'
    const providerSessionId = 'provider-session'
    const stableEvent = {
      runId: 'run-1',
      sessionId: stableSessionId,
      projectId: 'project-1',
      type: 'run.event',
      data: { sessionId: stableSessionId, kind: 'tool' }
    }
    const client = {
      listProjects,
      events: async function* () {
        yield {
          runId: 'previous-run',
          sessionId: stableSessionId,
          projectId: 'project-1',
          type: 'run.event',
          data: { sessionId: stableSessionId, kind: 'tool' }
        }
        yield { type: 'run.event', data: { sessionId: providerSessionId, kind: 'tool' } }
        yield stableEvent
      },
      startRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: stableSessionId,
        status: 'running'
      }),
      waitForRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: stableSessionId,
        status: 'completed',
        output: 'Done',
        artifacts: []
      })
    }
    const log = vi.fn()

    await runTaskCommand(
      parseCliArgs([
        'run',
        '--project',
        'project-1',
        '--session',
        stableSessionId,
        '--prompt',
        'Continue research.',
        '--wait',
        '--jsonl'
      ]),
      { connect: vi.fn().mockResolvedValue(client), stdinIsTTY: true, log }
    )

    expect(client.startRun).toHaveBeenCalledWith({
      project: 'project-1',
      prompt: 'Continue research.',
      sessionId: stableSessionId
    })
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      stableEvent,
      expect.objectContaining({ id: 'run-1', sessionId: stableSessionId, status: 'completed' })
    ])
  })

  it('passes the wait timeout and warns when a run needs approval', async () => {
    const events = async function* (): AsyncGenerator<{
      type: string
      data: { sessionId: string }
    }> {
      yield {
        type: 'stream.resync-required',
        data: { sessionId: 'session-1' }
      }
      yield { type: 'permission.requested', data: { sessionId: 'session-1' } }
    }
    const client = {
      listProjects,
      events,
      startRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        status: 'running'
      }),
      waitForRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        status: 'completed',
        output: 'Done',
        artifacts: []
      })
    }
    const warn = vi.fn()

    await runTaskCommand(
      {
        command: 'run',
        options: {
          project: 'project-1',
          prompt: 'Research this.',
          wait: true,
          timeoutMs: 60_000,
          json: false,
          jsonl: false
        }
      },
      {
        connect: vi.fn().mockResolvedValue(client),
        stdinIsTTY: true,
        log: vi.fn(),
        warn
      }
    )

    expect(client.waitForRun).toHaveBeenCalledWith('run-1', { timeoutMs: 60_000 })
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      'Run event history could not be fully replayed. Final Run state will still be read from Open-Science.',
      'Run is waiting for approval. Approve the request in Open-Science Desktop or the Web UI.'
    ])
  })

  it('prints provider-neutral Run progress and liveness heartbeats while waiting', async () => {
    const events = async function* (): AsyncGenerator<{
      type: string
      data: Record<string, unknown>
    }> {
      yield {
        type: 'run.progress',
        data: {
          runId: 'run-1',
          sessionId: 'session-1',
          projectId: 'project-1',
          phase: 'prompt-dispatched',
          timestamp: 1,
          elapsedMs: 0,
          heartbeat: false
        }
      }
      yield {
        type: 'run.progress',
        data: {
          runId: 'run-1',
          sessionId: 'session-1',
          projectId: 'project-1',
          phase: 'prompt-dispatched',
          timestamp: 10_001,
          elapsedMs: 10_000,
          heartbeat: true
        }
      }
    }
    const client = {
      listProjects,
      events,
      startRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        status: 'running'
      }),
      waitForRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        status: 'completed',
        output: 'Done',
        artifacts: []
      })
    }
    const log = vi.fn()

    await runTaskCommand(
      parseCliArgs(['run', '--project', 'project-1', '--prompt', 'Research this.', '--wait']),
      { connect: vi.fn().mockResolvedValue(client), stdinIsTTY: true, log }
    )

    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'Prompt dispatched to the agent.',
      'Still waiting for the provider (10s elapsed).',
      'Done'
    ])
  })

  it('stops only the CLI event wait when a timeout occurs by default', async () => {
    const timeout = Object.assign(new Error('Timed out waiting for run run-1.'), {
      code: 'timeout'
    })
    let eventSignal: AbortSignal | undefined
    const events = vi.fn(({ signal }: { signal: AbortSignal }) => {
      eventSignal = signal
      return {
        ready: Promise.resolve(),
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              new Promise<IteratorResult<never>>((resolve) => {
                signal.addEventListener(
                  'abort',
                  () => resolve({ value: undefined as never, done: true }),
                  { once: true }
                )
              })
          }
        }
      }
    })
    const client = {
      listProjects,
      events,
      startRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        status: 'running'
      }),
      waitForRun: vi.fn().mockRejectedValue(timeout),
      cancelRun: vi.fn()
    }

    await expect(
      runTaskCommand(
        {
          command: 'run',
          options: {
            project: 'project-1',
            prompt: 'Research this.',
            wait: true,
            timeoutMs: 25,
            json: false,
            jsonl: false
          }
        },
        { connect: vi.fn().mockResolvedValue(client), stdinIsTTY: true }
      )
    ).rejects.toBe(timeout)

    expect(client.waitForRun).toHaveBeenCalledWith('run-1', { timeoutMs: 25 })
    expect(eventSignal?.aborted).toBe(true)
    expect(client.cancelRun).not.toHaveBeenCalled()
  })

  it('keeps the authoritative Run result when the event stream times out mid-run', async () => {
    const streamFailure = Object.assign(
      new Error('Open-Science event stream timed out after 30000 milliseconds.'),
      { code: 'timeout' }
    )
    const events = (): {
      ready: Promise<void>
      [Symbol.asyncIterator](): {
        next(): Promise<IteratorResult<never>>
      }
    } => ({
      ready: Promise.resolve(),
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<never>>((_, reject) => {
              setTimeout(() => reject(streamFailure), 5)
            })
        }
      }
    })
    const client = {
      listProjects,
      events,
      startRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        status: 'running'
      }),
      waitForRun: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  id: 'run-1',
                  sessionId: 'session-1',
                  status: 'completed',
                  output: 'Done',
                  artifacts: []
                }),
              15
            )
          })
      )
    }
    const log = vi.fn()
    const warn = vi.fn()
    const setExitCode = vi.fn()

    await runTaskCommand(
      {
        command: 'run',
        options: {
          project: 'project-1',
          prompt: 'Research this.',
          wait: true,
          json: false,
          jsonl: false
        }
      },
      {
        connect: vi.fn().mockResolvedValue(client),
        stdinIsTTY: true,
        log,
        warn,
        setExitCode
      }
    )

    expect(client.waitForRun).toHaveBeenCalledWith('run-1')
    expect(warn).toHaveBeenCalledWith(
      'Run event stream stopped: Open-Science event stream timed out after 30000 milliseconds. Final Run state will still be read from Open-Science.'
    )
    expect(log).toHaveBeenCalledWith('Done')
    expect(setExitCode).not.toHaveBeenCalled()
  })

  it('keeps the authoritative Run failure in JSONL when the event stream times out', async () => {
    const streamFailure = Object.assign(
      new Error('Open-Science event stream timed out after 30000 milliseconds.'),
      { code: 'timeout' }
    )
    const events = (): {
      ready: Promise<void>
      [Symbol.asyncIterator](): {
        next(): Promise<IteratorResult<never>>
      }
    } => ({
      ready: Promise.resolve(),
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<never>>((_, reject) => {
              setTimeout(() => reject(streamFailure), 5)
            })
        }
      }
    })
    const client = {
      listProjects,
      events,
      startRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        status: 'running'
      }),
      waitForRun: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  id: 'run-1',
                  sessionId: 'session-1',
                  status: 'failed',
                  error: 'Provider failed',
                  artifacts: []
                }),
              15
            )
          })
      )
    }
    const log = vi.fn()
    const warn = vi.fn()
    const setExitCode = vi.fn()

    await runTaskCommand(
      {
        command: 'run',
        options: {
          project: 'project-1',
          prompt: 'Research this.',
          wait: true,
          json: false,
          jsonl: true
        }
      },
      {
        connect: vi.fn().mockResolvedValue(client),
        stdinIsTTY: true,
        log,
        warn,
        setExitCode
      }
    )

    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      id: 'run-1',
      status: 'failed',
      error: 'Provider failed'
    })
    expect(JSON.parse(warn.mock.calls[0][0])).toEqual({
      warning: { code: 'event_stream_stopped', message: streamFailure.message }
    })
    expect(setExitCode).toHaveBeenCalledWith(1)
  })

  it('explicitly cancels the server run after a wait timeout and preserves the timeout error', async () => {
    const timeout = Object.assign(new Error('Timed out waiting for run run-1.'), {
      code: 'timeout'
    })
    const client = {
      listProjects,
      startRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        status: 'running'
      }),
      waitForRun: vi.fn().mockRejectedValue(timeout),
      cancelRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        status: 'cancelled'
      })
    }

    await expect(
      runTaskCommand(
        {
          command: 'run',
          options: {
            project: 'project-1',
            prompt: 'Research this.',
            wait: true,
            timeoutMs: 25,
            cancelOnTimeout: true,
            json: true,
            jsonl: false
          }
        },
        { connect: vi.fn().mockResolvedValue(client), stdinIsTTY: true }
      )
    ).rejects.toBe(timeout)

    expect(client.waitForRun).toHaveBeenCalledWith('run-1', { timeoutMs: 25 })
    expect(client.cancelRun).toHaveBeenCalledWith('run-1')
  })

  it('reports when cancellation after a wait timeout also fails', async () => {
    const timeout = Object.assign(new Error('Timed out waiting for run run-1.'), {
      code: 'timeout'
    })
    const cancelError = new Error('daemon disconnected')
    const client = {
      listProjects,
      startRun: vi.fn().mockResolvedValue({
        id: 'run-1',
        sessionId: 'session-1',
        status: 'running'
      }),
      waitForRun: vi.fn().mockRejectedValue(timeout),
      cancelRun: vi.fn().mockRejectedValue(cancelError)
    }

    await expect(
      runTaskCommand(
        {
          command: 'run',
          options: {
            project: 'project-1',
            prompt: 'Research this.',
            wait: true,
            timeoutMs: 25,
            cancelOnTimeout: true,
            json: true,
            jsonl: false
          }
        },
        { connect: vi.fn().mockResolvedValue(client), stdinIsTTY: true }
      )
    ).rejects.toMatchObject({
      code: 'timeout',
      message: expect.stringContaining(
        'Timed out waiting for run run-1. Server run cancellation also failed: daemon disconnected'
      ),
      cause: cancelError
    })
  })

  it('accepts unattended runs and rejects incompatible prompt controls', () => {
    expect(parseCliArgs(['run', '--permission-prompts', 'none']).options.permissionPrompts).toBe(
      'none'
    )
    expect(() => parseCliArgs(['run', '--permission-prompts', 'all'])).toThrow(
      '--permission-prompts must be none'
    )
    expect(() => parseCliArgs(['run', '--permission-prompts', 'none', '--plan-first'])).toThrow(
      '--plan-first cannot be combined'
    )
    expect(() => parseCliArgs(['session', 'status', 's1', '--permission-prompts', 'none'])).toThrow(
      '--permission-prompts requires run'
    )
  })

  it('keeps capability management surfaces outside the CLI', async () => {
    for (const command of [
      'permission',
      'specialist',
      'compute',
      'notebook',
      'notebook-env',
      'reviewer'
    ]) {
      await expect(runCli([command])).rejects.toThrow(`Unknown command: ${command}`)
    }
  })

  it('emits structured machine errors with stable exit codes', () => {
    const error = vi.fn()
    const setExitCode = vi.fn()

    expect(
      reportCliError(new CliUsageError('--project is required.'), ['run', '--json'], {
        error,
        setExitCode
      })
    ).toBe(2)
    expect(JSON.parse(error.mock.calls[0][0])).toEqual({
      error: { code: 'invalid_cli_usage', message: '--project is required.' },
      exitCode: 2
    })
    expect(setExitCode).toHaveBeenCalledWith(2)

    const cases = [
      { code: 'daemon_unavailable', exitCode: 3 },
      { code: 'project_not_found', exitCode: 4 },
      { code: 'session_not_found', exitCode: 4 },
      { code: 'run_not_found', exitCode: 4 },
      { code: 'artifact_not_found', exitCode: 4 },
      { code: 'timeout', exitCode: 1 },
      { code: 'session_busy', exitCode: 1 },
      { code: 'command_failed', exitCode: 1 }
    ]
    for (const contract of cases) {
      error.mockClear()
      setExitCode.mockClear()
      const failure = Object.assign(new Error(`${contract.code} message`), {
        code: contract.code
      })
      expect(reportCliError(failure, ['run', '--json'], { error, setExitCode })).toBe(
        contract.exitCode
      )
      expect(JSON.parse(error.mock.calls[0][0])).toEqual({
        error: { code: contract.code, message: `${contract.code} message` },
        exitCode: contract.exitCode
      })
      expect(setExitCode).toHaveBeenCalledWith(contract.exitCode)
    }
  })
})

describe('Session package CLI', () => {
  it('requires confirmation and rejects conflicting destinations', () => {
    expect(() => parseCliArgs(['session', 'import', 'input.science'])).toThrow(
      '--non-interactive is required.'
    )
    expect(() =>
      parseCliArgs([
        'session',
        'import',
        'input.science',
        '--non-interactive',
        '--project',
        'existing',
        '--new-project',
        'Restored'
      ])
    ).toThrow('Use only one of --project and --new-project.')
  })

  it('passes resolved paths, destinations and transfer deadlines to the SDK', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue([{ id: 'project-1', name: 'Research' }]),
      exportSessionPackage: vi.fn().mockResolvedValue({ saved: true }),
      importSessionPackage: vi
        .fn()
        .mockResolvedValue({ projectId: 'project-2', sessionId: 'session-2' })
    }
    const deps = { connect: vi.fn().mockResolvedValue(client), log: vi.fn() }
    await runTaskCommand(
      parseCliArgs([
        'session',
        'export',
        'session-1',
        '--project',
        'Research',
        '--output',
        'out.science',
        '--timeout-ms',
        '7200000'
      ]),
      deps
    )
    expect(client.exportSessionPackage).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      resolve('out.science'),
      { timeoutMs: 7200000 }
    )
    for (const [flags, target] of [
      [[], {}],
      [['--project', 'Research'], { projectId: 'project-1' }],
      [['--new-project', 'Restored'], { projectName: 'Restored' }]
    ] as const) {
      await runTaskCommand(
        parseCliArgs([
          'session',
          'import',
          'in.science',
          '--non-interactive',
          '--timeout-ms',
          '7200000',
          ...flags
        ]),
        deps
      )
      expect(client.importSessionPackage).toHaveBeenLastCalledWith(
        target,
        resolve('in.science'),
        { nonInteractive: true },
        { timeoutMs: 7200000 }
      )
    }
  })
})

describe('service interruption results', () => {
  it.each(['ready', 'create'])(
    'releases event resources when stream %s fails before submission',
    async (phase) => {
      const failure = Object.assign(new Error('Event stream setup failed.'), { code: 'timeout' })
      let signal: AbortSignal | undefined
      const release = vi.fn().mockResolvedValue({ done: true })
      const startRun = vi.fn()
      await expect(
        runTaskCommand(
          parseCliArgs(['run', '--project', 'Research', '--prompt', 'work', '--wait']),
          {
            connect: async () => ({
              listProjects,
              startRun,
              events: (options: { signal: AbortSignal }) => {
                signal = options.signal
                if (phase === 'create') throw failure
                return { ready: Promise.reject(failure), return: release }
              }
            }),
            stdinIsTTY: true
          }
        )
      ).rejects.toBe(failure)
      expect(signal?.aborted).toBe(true)
      expect(startRun).not.toHaveBeenCalled()
      expect(failure).not.toHaveProperty('completionStatus')
      expect(failure).not.toHaveProperty('runId')
      if (phase === 'ready') expect(release).toHaveBeenCalledOnce()
    }
  )

  it('retains an acknowledged run ID when terminal state cannot be read, preserving the original error code', async () => {
    const failure = Object.assign(new Error('The local service is stopping.'), {
      code: 'command-unavailable',
      status: 503
    })
    const startRun = vi
      .fn()
      .mockResolvedValue({ id: 'run-accepted', sessionId: 'session-1', status: 'running' })
    await expect(
      runTaskCommand(
        parseCliArgs(['run', '--project', 'Research', '--prompt', 'work', '--wait', '--json']),
        {
          connect: async () => ({
            listProjects,
            startRun,
            waitForRun: async () => {
              throw failure
            }
          }),
          stdinIsTTY: true
        }
      )
    ).rejects.toMatchObject({
      code: 'command-unavailable',
      status: 503,
      runId: 'run-accepted',
      completionStatus: 'unconfirmed'
    })
    expect(startRun).toHaveBeenCalledOnce()
    const error = vi.fn(),
      setExitCode = vi.fn()
    reportCliError(failure, ['run', '--json'], { error, setExitCode })
    expect(JSON.parse(error.mock.calls[0][0]).error.code).toBe('command-unavailable')
    expect(setExitCode).toHaveBeenCalledWith(1)
  })

  it('keeps a known submission rejection distinct from a lost submission response', async () => {
    const failure = Object.assign(new Error('The local service is stopping.'), {
      code: 'command-unavailable',
      status: 503
    })
    const startRun = vi.fn().mockRejectedValue(failure)
    await expect(
      runTaskCommand(parseCliArgs(['run', '--project', 'Research', '--prompt', 'work', '--json']), {
        connect: async () => ({ listProjects, startRun }),
        stdinIsTTY: true
      })
    ).rejects.toBe(failure)
    expect(failure).not.toHaveProperty('completionStatus')
    expect(failure).not.toHaveProperty('runId')
    expect(startRun).toHaveBeenCalledOnce()
  })

  it('returns nonzero for a cancelled wait while keeping a successful cancel command successful', async () => {
    const cancelled = { id: 'run-1', sessionId: 'session-1', status: 'cancelled' }
    const client = {
      listProjects,
      startRun: async () => ({ ...cancelled, status: 'running' }),
      waitForRun: async () => cancelled,
      cancelRun: async () => cancelled
    }
    const setExitCode = vi.fn(),
      log = vi.fn()
    await runTaskCommand(
      parseCliArgs(['run', '--project', 'Research', '--prompt', 'work', '--wait', '--json']),
      {
        connect: async () => client,
        stdinIsTTY: true,
        setExitCode,
        log
      }
    )
    expect(setExitCode).toHaveBeenCalledExactlyOnceWith(1)
    setExitCode.mockClear()
    await runTaskCommand(parseCliArgs(['run', 'cancel', 'run-1', '--json']), {
      connect: async () => client,
      setExitCode,
      log
    })
    expect(setExitCode).not.toHaveBeenCalled()
  })

  it.each(['text', 'json'])('explains submit-only Plan attention in %s output', async (format) => {
    const started = {
      id: 'run-1',
      sessionId: 'session-1',
      status: 'running',
      attention: { kind: 'plan-approval', plan: { artifactVersionId: 'plan-1', revision: 1 } }
    }
    const log = vi.fn()
    await runTaskCommand(
      parseCliArgs([
        'run',
        '--project',
        'Research',
        '--prompt',
        'work',
        ...(format === 'text' ? [] : [`--${format}`])
      ]),
      {
        connect: async () => ({ listProjects, startRun: async () => started }),
        stdinIsTTY: true,
        log
      }
    )
    if (format === 'text') {
      expect(log).toHaveBeenCalledWith(expect.stringContaining('waiting for Plan approval'))
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('Exiting the App may interrupt this work')
      )
    } else {
      expect(log).toHaveBeenCalledOnce()
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
        id: 'run-1',
        submissionStatus: 'submitted-not-completed',
        next: ['run', 'status', 'run-1'],
        notice: expect.stringContaining('Exiting the App')
      })
    }
  })

  it.each([true, false])(
    'reports an unconfirmed result without fabricating an ID (submitted=%s)',
    async (submitted) => {
      const failure = Object.assign(new Error('Local service disconnected.'), {
        code: 'daemon_unavailable'
      })
      const client = {
        listProjects,
        startRun: submitted
          ? vi
              .fn()
              .mockResolvedValue({ id: 'run-observed', sessionId: 'session-1', status: 'running' })
          : vi.fn().mockRejectedValue(failure),
        waitForRun: vi.fn().mockRejectedValue(failure)
      }
      await expect(
        runTaskCommand(
          parseCliArgs(['run', '--project', 'Research', '--prompt', 'work', '--wait', '--json']),
          {
            connect: async () => client,
            stdinIsTTY: true
          }
        )
      ).rejects.toBe(failure)
      expect(failure).toMatchObject({
        code: 'daemon_unavailable',
        completionStatus: submitted ? 'unconfirmed' : 'submission-unconfirmed'
      })
      if (submitted) expect(failure).toHaveProperty('runId', 'run-observed')
      else expect(failure).not.toHaveProperty('runId')
      expect(client.startRun).toHaveBeenCalledOnce()
      const error = vi.fn()
      const setExitCode = vi.fn()
      reportCliError(failure, ['run', '--json'], { error, setExitCode })
      expect(JSON.parse(error.mock.calls[0][0]).error.completionStatus).toBe(
        submitted ? 'unconfirmed' : 'submission-unconfirmed'
      )
      expect(setExitCode).not.toHaveBeenCalledWith(0)
    }
  )

  it('returns a confirmed terminal outcome even if the advisory event iterator never closes', async () => {
    const client = {
      listProjects,
      events: () => ({
        ready: Promise.resolve(),
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) })
      }),
      startRun: async () => ({ id: 'run-1', sessionId: 'session-1', status: 'running' }),
      waitForRun: async () => ({
        id: 'run-1',
        sessionId: 'session-1',
        status: 'completed',
        output: 'confirmed'
      })
    }
    const log = vi.fn()
    const started = Date.now()
    await runTaskCommand(
      parseCliArgs(['run', '--project', 'Research', '--prompt', 'work', '--wait']),
      {
        connect: async () => client,
        stdinIsTTY: true,
        log
      }
    )
    expect(Date.now() - started).toBeLessThan(1800)
    expect(log).toHaveBeenCalledWith('confirmed')
  })
})

describe('local service CLI status', () => {
  it('does not send a legacy shutdown request when the authenticated bootstrap belongs to another root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cli-legacy-root-unit-'))
    const copy = await mkdtemp(join(tmpdir(), 'cli-legacy-copy-unit-'))
    try {
      const fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ configRoot: root })
      })
      await expect(
        stopCommand(
          { json: true },
          {
            findServiceState: async () => ({ pid: 12345, port: 12345, configRoot: copy }),
            isAlive: () => true,
            requestServiceLifetime: async () => undefined,
            readWebToken: async () => 'fixture-token',
            fetch,
            log: vi.fn()
          }
        )
      ).rejects.toMatchObject({ code: 'service_identity_unverified' })
      expect(fetch.mock.calls.every(([url]) => url.endsWith('/api/bootstrap'))).toBe(true)
    } finally {
      await Promise.all([root, copy].map((path) => rm(path, { recursive: true, force: true })))
    }
  })

  it.each([false, true])(
    'marks accepted legacy shutdown as nonzero unconfirmed (json=%s)',
    async (json) => {
      const log = vi.fn(),
        setExitCode = vi.fn()
      await stopCommand(
        { json },
        {
          findServiceState: async () => ({
            pid: 12345,
            port: 12345,
            configRoot: '/private-fixture'
          }),
          isAlive: () => false,
          requestServiceLifetime: async () => undefined,
          readWebToken: async () => 'fixture-token',
          fetch: async () => ({
            ok: true,
            json: async () => ({ configRoot: '/private-fixture' }),
            arrayBuffer: async () => new ArrayBuffer(0)
          }),
          verifyServiceConfigRoot: async () => undefined,
          log,
          setExitCode
        }
      )
      expect(setExitCode).toHaveBeenCalledExactlyOnceWith(1)
      if (json)
        expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
          result: 'shutdown-requested',
          completionStatus: 'unconfirmed'
        })
      else expect(log).toHaveBeenCalledWith(expect.stringContaining('older service protocol'))
      expect(log.mock.calls.flat().join(' ')).not.toContain('Local service stopped.')
    }
  )

  it('waits for the accepted owner rather than reporting stopped from a stale discovery PID', async () => {
    let clock = 0
    const oldState = { pid: 11111, port: 12345, configRoot: '/private-fixture' }
    const generation = 'd1ed69cd-9883-452a-9ddd-e67c4a530a1e'
    const serviceGeneration = '042a3798-beda-4e60-9d8a-179223668d45'
    const service = {
      pid: 22222,
      generation,
      lifetime: {
        version: 1,
        generation: serviceGeneration,
        stopping: true,
        explicit: false,
        apps: 0
      },
      identity: {
        configRoot: oldState.configRoot,
        pid: 22222,
        generation,
        serviceGeneration,
        birthToken: 'birth-B',
        version: '9.2.1'
      }
    }
    const isAlive = vi.fn((pid) => pid === service.pid)
    const log = vi.fn()
    await expect(
      stopCommand(
        { json: true },
        {
          findServiceState: async () => oldState,
          isAlive,
          requestServiceLifetime: async () => service,
          log,
          now: () => clock,
          sleep: async (ms: number) => {
            clock += ms
          },
          readServiceProcessBirth: async () => 'birth-B',
          readRuntimeOwner: async () =>
            JSON.stringify({ generation, pid: service.pid, birthToken: 'birth-B' })
        }
      )
    ).rejects.toMatchObject({ code: 'service_stop_unconfirmed' })
    expect(isAlive).toHaveBeenCalledWith(service.pid)
    expect(log).not.toHaveBeenCalled()
    expect(clock).toBe(22_000)
  })

  it('reports a live but unreachable service as unknown rather than stopped', async () => {
    const state = { pid: 12345, port: 12345, configRoot: '/private-fixture' }
    const log = vi.fn(),
      setExitCode = vi.fn(),
      requestServiceLifetime = vi.fn()
    await statusCommand(
      { json: true },
      {
        findServiceState: async () => state,
        isAlive: () => true,
        readWebToken: async () => 'fixture-token',
        fetch: async () => ({ ok: false }),
        log,
        setExitCode,
        requestServiceLifetime
      }
    )
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      ...state,
      running: null,
      status: 'unreachable',
      lifetime: 'unknown'
    })
    expect(setExitCode).toHaveBeenCalledWith(1)
    expect(requestServiceLifetime).not.toHaveBeenCalled()
  })

  it('emits a single JSON result when start reuses an existing App service', async () => {
    const state = { pid: 12345, port: 12345, configRoot: '/private-fixture' }
    const lifetime = {
      version: 1,
      generation: 'fixture-generation',
      explicit: true,
      stopping: false,
      apps: 1
    }
    const requestServiceLifetime = vi.fn().mockResolvedValue({ lifetime })
    const locateBackend = vi.fn().mockRejectedValue(new Error('No local backend is installed'))
    const log = vi.fn()
    await startCommand(parseCliArgs(['start', '--json', '--no-open']).options, {
      findServiceState: async () => state,
      isAlive: () => true,
      readWebToken: async () => 'fixture-token',
      fetch: async () => ({ ok: true }),
      log,
      requestServiceLifetime,
      locateBackend
    })
    expect(requestServiceLifetime).toHaveBeenCalledWith(
      state.configRoot,
      'start',
      expect.any(Function)
    )
    expect(log).toHaveBeenCalledOnce()
    expect(locateBackend).not.toHaveBeenCalled()
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      result: 'already-running',
      ...state,
      lifetime
    })
  })
})
