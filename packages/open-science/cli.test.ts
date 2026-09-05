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
import { describe, expect, it, vi } from 'vitest'

import { PUBLIC_TERMINAL_FIXTURE } from '../../test/fixtures/renderer-contract-certification'
import {
  CliUsageError,
  parseCliArgs,
  reportCliError,
  rollbackCommand,
  runCli,
  runTaskCommand,
  updateCommand
} from './cli.mjs'

const listProjects = async (): Promise<Array<{ id: string; name: string }>> => [
  { id: 'project-1', name: 'Research' }
]

describe('task CLI', () => {
  it('rejects ports that are not complete decimal values', () => {
    expect(() => parseCliArgs(['start', '--port', '44100xyz'])).toThrow('Invalid port: 44100xyz')
    expect(() => parseCliArgs(['start', '--port', '0'])).toThrow('Invalid port: 0')
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
      '--timeout-ms requires run --wait.'
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
    expect(() => parseCliArgs(['status', '--force'])).toThrow('--force requires codex login.')
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

  it('parses application update output and rejects positional arguments', () => {
    expect(parseCliArgs(['update', '--json', '--no-sandbox'])).toEqual({
      command: 'update',
      options: { open: true, json: true, noSandbox: true }
    })
    expect(() => parseCliArgs(['update', 'latest'])).toThrow('update accepts no arguments.')
    expect(() => parseCliArgs(['status', '--no-sandbox'])).toThrow(
      '--no-sandbox requires start or update.'
    )
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

  it('parses and runs the explicit offline rollback command', async () => {
    const parsed = parseCliArgs([
      'rollback-to-0.7.3',
      '--yes',
      '--config-root',
      '/config',
      '--data-root',
      '/data',
      '--output',
      '/rollback'
    ])
    expect(parsed).toEqual({
      command: 'rollback-to-0.7.3',
      options: {
        open: true,
        json: false,
        yes: true,
        configRoot: '/config',
        dataRoot: '/data',
        output: '/rollback'
      }
    })

    const runRollback = vi.fn().mockResolvedValue({
      targetVersion: '0.7.3',
      rollbackDataRoot: '/rollback',
      preservedConfigRoot: '/config.before-rollback',
      preservedDataRoot: '/data',
      sessionsConverted: 4
    })
    const log = vi.fn()
    await rollbackCommand(parsed.options, { runRollback, log })

    expect(runRollback).toHaveBeenCalledWith({
      configRoot: '/config',
      dataRoot: '/data',
      output: '/rollback',
      confirm: true
    })
    expect(log.mock.calls.map(([line]) => line)).toContain(
      'Preserved newer Config Root: /config.before-rollback'
    )
    expect(() => parseCliArgs(['rollback-to-0.7.3'])).not.toThrow()
    expect(() => parseCliArgs(['status', '--yes'])).toThrow('--yes requires rollback-to-0.7.3.')
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
      'Run event history could not be fully replayed. Final Run state will still be read from Open Science.',
      'Run is waiting for approval. Approve the request in Open Science Desktop or the Web UI.'
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
      new Error('Open Science event stream timed out after 30000 milliseconds.'),
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
      'Run event stream stopped: Open Science event stream timed out after 30000 milliseconds. Final Run state will still be read from Open Science.'
    )
    expect(log).toHaveBeenCalledWith('Done')
    expect(setExitCode).not.toHaveBeenCalled()
  })

  it('keeps the authoritative Run failure in JSONL when the event stream times out', async () => {
    const streamFailure = Object.assign(
      new Error('Open Science event stream timed out after 30000 milliseconds.'),
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

    expect(warn).toHaveBeenCalledWith(
      'Run event stream stopped: Open Science event stream timed out after 30000 milliseconds. Final Run state will still be read from Open Science.'
    )
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      id: 'run-1',
      status: 'failed',
      error: 'Provider failed'
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
      message:
        'Timed out waiting for run run-1. Server run cancellation also failed: daemon disconnected',
      cause: cancelError
    })
  })

  it('keeps capability management surfaces outside the CLI', async () => {
    for (const command of [
      'permission',
      'specialist',
      'compute',
      'notebook',
      'notebook-env',
      'reviewer',
      'runtime'
    ]) {
      await expect(runCli([command])).rejects.toThrow(`Unknown command: ${command}`)
    }
  })

  it('applies an in-place update without relaunching the desktop app', async () => {
    const invokeCommand = vi.fn(async (_client, channel: string, args?: unknown[]) => {
      if (channel === 'update:check') {
        return {
          state: 'ready',
          current: '1.0.0',
          latest: '1.1.0',
          applyKind: 'restart'
        }
      }
      if (channel === 'update:apply') {
        expect(args).toEqual([{ relaunch: false }])
        return {
          state: 'applying',
          current: '1.0.0',
          latest: '1.1.0',
          applyKind: 'restart'
        }
      }
      throw new Error(`Unexpected command: ${channel}`)
    })
    const log = vi.fn()

    await expect(
      updateCommand(
        { open: true, json: true },
        {
          ensureService: vi.fn().mockResolvedValue({ started: true }),
          connect: vi.fn().mockResolvedValue({}),
          getBootstrap: vi.fn().mockResolvedValue({
            appVersion: '1.0.0',
            rpcCapabilities: ['update-cli-v1']
          }),
          supportsCommand: vi.fn().mockResolvedValue(true),
          invokeCommand,
          log,
          setExitCode: vi.fn()
        }
      )
    ).resolves.toEqual({ outcome: 'install-started', current: '1.0.0', latest: '1.1.0' })

    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      outcome: 'install-started',
      current: '1.0.0',
      latest: '1.1.0'
    })
  })

  it('uses the authenticated local Web RPC envelope for update commands', async () => {
    const fetch = vi.fn(async (url: string) => {
      const channel = decodeURIComponent(url.split('/rpc/')[1] ?? '')
      const result =
        channel === 'update:check'
          ? {
              state: 'ready',
              current: '1.0.0',
              latest: '1.1.0',
              applyKind: 'restart'
            }
          : {
              state: 'applying',
              current: '1.0.0',
              latest: '1.1.0',
              applyKind: 'restart'
            }
      return new Response(JSON.stringify({ protocolVersion: 1, ok: true, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    const client = {
      health: vi.fn().mockResolvedValue({
        appVersion: '1.0.0',
        rpcProtocolVersion: 1,
        rpcCapabilities: ['update-cli-v1'],
        rpcChannels: ['update:check', 'update:apply']
      }),
      baseUrl: 'http://127.0.0.1:44100',
      token: 'local-token',
      fetch
    }

    await updateCommand(
      { open: true, json: true },
      {
        ensureService: vi.fn().mockResolvedValue({ started: false }),
        connect: vi.fn().mockResolvedValue(client),
        log: vi.fn(),
        setExitCode: vi.fn()
      }
    )

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:44100/rpc/update%3Acheck')
    expect(fetch.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        authorization: 'Bearer local-token',
        'x-open-science-client': 'open-science-cli'
      }),
      body: JSON.stringify({ protocolVersion: 1, args: [{ relaunch: false }] })
    })
  })

  it('downloads a manual installer non-interactively and returns exit code 6', async () => {
    const invokeCommand = vi.fn(async (_client, channel: string, args?: unknown[]) => {
      if (channel === 'update:check') {
        return {
          state: 'available',
          current: '1.0.0',
          latest: '1.1.0',
          applyKind: 'installer'
        }
      }
      if (channel === 'update:download') {
        expect(args).toEqual([{ nonInteractive: true }])
        return {
          state: 'ready',
          current: '1.0.0',
          latest: '1.1.0',
          applyKind: 'installer',
          localPath: 'C:\\Users\\test\\Downloads\\Open-Science.exe'
        }
      }
      if (channel === 'storage:detect-active') return []
      throw new Error(`Unexpected command: ${channel}`)
    })
    const setExitCode = vi.fn()
    const stopService = vi.fn().mockResolvedValue(undefined)

    const result = await updateCommand(
      { open: true, json: true },
      {
        ensureService: vi.fn().mockResolvedValue({
          started: true,
          state: { configRoot: '/data/open-science-owned' }
        }),
        connect: vi.fn().mockResolvedValue({}),
        getBootstrap: vi.fn().mockResolvedValue({
          appVersion: '1.0.0',
          rpcCapabilities: ['update-cli-v1']
        }),
        supportsCommand: vi.fn().mockResolvedValue(true),
        invokeCommand,
        sleep: vi.fn().mockResolvedValue(undefined),
        stopService,
        log: vi.fn(),
        setExitCode
      }
    )

    expect(result).toMatchObject({
      outcome: 'manual-action-required',
      installerPath: 'C:\\Users\\test\\Downloads\\Open-Science.exe'
    })
    expect(stopService).toHaveBeenCalledWith(
      expect.objectContaining({
        open: true,
        json: true,
        configRoot: '/data/open-science-owned'
      })
    )
    expect(setExitCode).toHaveBeenCalledWith(6)
  })

  it('requires stopping a pre-existing service before running a manual installer', async () => {
    const installerPath = '/data/update/Open-Science.dmg'
    const stopService = vi.fn()
    const result = await updateCommand(
      { open: true, json: true },
      {
        ensureService: vi.fn().mockResolvedValue({ started: false }),
        stopService,
        connect: vi.fn().mockResolvedValue({}),
        getBootstrap: vi.fn().mockResolvedValue({
          appVersion: '1.0.0',
          rpcCapabilities: ['update-cli-v1']
        }),
        supportsCommand: vi.fn().mockResolvedValue(true),
        invokeCommand: vi.fn().mockResolvedValue({
          state: 'ready',
          current: '1.0.0',
          latest: '1.1.0',
          applyKind: 'installer',
          localPath: installerPath
        }),
        log: vi.fn(),
        setExitCode: vi.fn()
      }
    )

    expect(stopService).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      installerPath,
      nextAction: expect.stringContaining('open-science stop')
    })
  })

  it('requires quitting an attached desktop app before running a manual installer', async () => {
    const installerPath = '/data/update/Open-Science.dmg'
    const stopService = vi.fn()
    const result = await updateCommand(
      { open: true, json: true },
      {
        ensureService: vi.fn().mockResolvedValue({
          started: true,
          state: { attached: true }
        }),
        stopService,
        connect: vi.fn().mockResolvedValue({}),
        getBootstrap: vi.fn().mockResolvedValue({
          appVersion: '1.0.0',
          rpcCapabilities: ['update-cli-v1']
        }),
        supportsCommand: vi.fn().mockResolvedValue(true),
        invokeCommand: vi.fn().mockResolvedValue({
          state: 'ready',
          current: '1.0.0',
          latest: '1.1.0',
          applyKind: 'installer',
          localPath: installerPath
        }),
        log: vi.fn(),
        setExitCode: vi.fn()
      }
    )

    expect(stopService).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      installerPath,
      nextAction: expect.stringContaining('Quit the running Open Science app')
    })
  })

  it('keeps the installer handoff when stopping a service started by update fails', async () => {
    const installerPath = '/data/update/Open-Science.dmg'
    const stopService = vi.fn().mockRejectedValue(new Error('service still running'))
    const result = await updateCommand(
      { open: true, json: true },
      {
        ensureService: vi.fn().mockResolvedValue({
          started: true,
          state: { configRoot: '/data/open-science-owned' }
        }),
        stopService,
        connect: vi.fn().mockResolvedValue({}),
        getBootstrap: vi.fn().mockResolvedValue({
          appVersion: '1.0.0',
          rpcCapabilities: ['update-cli-v1']
        }),
        supportsCommand: vi.fn().mockResolvedValue(true),
        invokeCommand: vi.fn().mockResolvedValue({
          state: 'ready',
          current: '1.0.0',
          latest: '1.1.0',
          applyKind: 'installer',
          localPath: installerPath
        }),
        log: vi.fn(),
        setExitCode: vi.fn()
      }
    )

    expect(stopService).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      installerPath,
      nextAction: expect.stringContaining('open-science stop')
    })
  })

  it('reports an already-current installation without downloading or applying', async () => {
    const invokeCommand = vi.fn(async (_client, channel: string) => {
      if (channel === 'update:check') {
        return { state: 'up-to-date', current: '1.1.0', latest: '1.1.0' }
      }
      throw new Error(`Unexpected command: ${channel}`)
    })

    const ensureService = vi.fn().mockResolvedValue({ started: false })
    const result = await updateCommand(
      { open: true, json: true, noSandbox: true },
      {
        ensureService,
        connect: vi.fn().mockResolvedValue({}),
        getBootstrap: vi.fn().mockResolvedValue({
          appVersion: '1.1.0',
          rpcCapabilities: ['update-cli-v1']
        }),
        supportsCommand: vi.fn().mockResolvedValue(true),
        invokeCommand,
        log: vi.fn(),
        setExitCode: vi.fn()
      }
    )

    expect(result).toEqual({ outcome: 'up-to-date', current: '1.1.0', latest: '1.1.0' })
    expect(ensureService).toHaveBeenCalledWith(
      expect.objectContaining({ open: false, noSandbox: true })
    )
    expect(invokeCommand).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a failed transfer', 'Network connection lost'],
    ['a checksum failure', 'Downloaded update checksum mismatch']
  ])('surfaces %s as a command failure', async (_case, message) => {
    const invokeCommand = vi.fn(async (_client, channel: string) => {
      if (channel === 'update:check') {
        return {
          state: 'available',
          current: '1.0.0',
          latest: '1.1.0',
          applyKind: 'installer'
        }
      }
      if (channel === 'update:download') {
        return {
          state: 'error',
          current: '1.0.0',
          latest: '1.1.0',
          applyKind: 'installer',
          error: message
        }
      }
      throw new Error(`Unexpected command: ${channel}`)
    })

    await expect(
      updateCommand(
        { open: true, json: true },
        {
          ensureService: vi.fn().mockResolvedValue({ started: true }),
          connect: vi.fn().mockResolvedValue({}),
          getBootstrap: vi.fn().mockResolvedValue({
            appVersion: '1.0.0',
            rpcCapabilities: ['update-cli-v1']
          }),
          supportsCommand: vi.fn().mockResolvedValue(true),
          invokeCommand,
          sleep: vi.fn().mockResolvedValue(undefined),
          log: vi.fn(),
          setExitCode: vi.fn()
        }
      )
    ).rejects.toThrow(message)
  })

  it('prints observable download progress in human-readable mode', async () => {
    const ready = {
      state: 'ready',
      current: '1.0.0',
      latest: '1.1.0',
      applyKind: 'installer',
      localPath: '/data/update/Open-Science.dmg'
    }
    let finishDownload: ((status: typeof ready) => void) | undefined
    const download = new Promise<typeof ready>((resolve) => {
      finishDownload = resolve
    })
    const invokeCommand = vi.fn(async (_client, channel: string) => {
      if (channel === 'update:check') {
        return {
          state: 'available',
          current: '1.0.0',
          latest: '1.1.0',
          applyKind: 'installer'
        }
      }
      if (channel === 'update:download') return download
      if (channel === 'update:get-status') {
        finishDownload?.(ready)
        return {
          state: 'downloading',
          current: '1.0.0',
          latest: '1.1.0',
          applyKind: 'installer',
          progress: 37
        }
      }
      throw new Error(`Unexpected command: ${channel}`)
    })
    const log = vi.fn()

    await updateCommand(
      { open: true, json: false },
      {
        ensureService: vi.fn().mockResolvedValue({ started: true }),
        connect: vi.fn().mockResolvedValue({}),
        getBootstrap: vi.fn().mockResolvedValue({
          appVersion: '1.0.0',
          rpcCapabilities: ['update-cli-v1']
        }),
        supportsCommand: vi.fn().mockResolvedValue(true),
        invokeCommand,
        sleep: vi.fn().mockResolvedValue(undefined),
        log,
        setExitCode: vi.fn()
      }
    )

    expect(log).toHaveBeenCalledWith('Downloading update: 37%')
  })

  it('reports active research blockers with exit code 5 and keeps the service running', async () => {
    const invokeCommand = vi.fn(async (_client, channel: string) => {
      if (channel === 'update:check') {
        return {
          state: 'ready',
          current: '1.0.0',
          latest: '1.1.0',
          applyKind: 'restart'
        }
      }
      if (channel === 'update:apply') {
        return {
          state: 'error',
          current: '1.0.0',
          latest: '1.1.0',
          applyKind: 'restart',
          blockedBy: ['agent', 'notebook'],
          error: 'Research work is still running.'
        }
      }
      if (channel === 'storage:detect-active') return [{ kind: 'agent' }]
      throw new Error(`Unexpected command: ${channel}`)
    })
    const setExitCode = vi.fn()

    const result = await updateCommand(
      { open: true, json: true },
      {
        ensureService: vi.fn().mockResolvedValue({ started: true }),
        connect: vi.fn().mockResolvedValue({}),
        getBootstrap: vi.fn().mockResolvedValue({
          appVersion: '1.0.0',
          rpcCapabilities: ['update-cli-v1']
        }),
        supportsCommand: vi.fn().mockResolvedValue(true),
        invokeCommand,
        log: vi.fn(),
        setExitCode
      }
    )

    expect(result).toEqual({
      outcome: 'blocked',
      current: '1.0.0',
      latest: '1.1.0',
      blockedBy: ['agent', 'notebook']
    })
    expect(setExitCode).toHaveBeenCalledWith(5)
    expect(invokeCommand).not.toHaveBeenCalledWith({}, 'storage:detect-active')
  })

  it('falls back when a legacy app advertises update channels without the CLI capability', async () => {
    const setExitCode = vi.fn()
    const supportsCommand = vi.fn().mockResolvedValue(true)
    const invokeCommand = vi.fn()

    const result = await updateCommand(
      { open: true, json: true },
      {
        ensureService: vi.fn().mockResolvedValue({ started: true }),
        connect: vi.fn().mockResolvedValue({ bootstrap: { appVersion: '0.9.0' } }),
        getBootstrap: vi.fn().mockResolvedValue({
          appVersion: '0.9.0',
          rpcChannels: ['update:check', 'update:download', 'update:apply']
        }),
        supportsCommand,
        invokeCommand,
        log: vi.fn(),
        setExitCode
      }
    )

    expect(result).toMatchObject({ outcome: 'manual-action-required', current: '0.9.0' })
    expect(setExitCode).toHaveBeenCalledWith(6)
    expect(supportsCommand).not.toHaveBeenCalled()
    expect(invokeCommand).not.toHaveBeenCalled()
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
