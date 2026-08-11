import { describe, expect, it, vi } from 'vitest'

import { PUBLIC_TERMINAL_FIXTURE } from '../../test/fixtures/renderer-contract-certification'
import {
  CliUsageError,
  parseCliArgs,
  reportCliError,
  rollbackCommand,
  runCli,
  runTaskCommand
} from './cli.mjs'

describe('task CLI', () => {
  it('parses the first milestone run interface', () => {
    expect(
      parseCliArgs([
        'run',
        '--project',
        'systematic-review',
        '--prompt-file',
        'task.md',
        '--session',
        'session-1',
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
        'citation-check'
      ])
    ).toMatchObject({
      command: 'run',
      options: {
        session: 'session-1',
        approvalProfile: 'full',
        skills: ['literature-review', 'citation-check']
      }
    })
    expect(() => parseCliArgs(['run', '--approval-profile', 'unsafe'])).toThrow(
      'Invalid approval profile: unsafe'
    )
    expect(() => parseCliArgs(['run', '--json', '--jsonl', '--wait'])).toThrow(
      'Use only one of --json or --jsonl.'
    )
    expect(() => parseCliArgs(['status', '--unknown'])).toThrow('Unknown option: --unknown')
  })

  it('reads a prompt file, waits for completion, and emits one JSON result', async () => {
    const client = {
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
      permissionProfile: 'auto'
    })
    expect(client.waitForRun).toHaveBeenCalledWith('run-1')
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ status: 'completed', output: 'Done' })
    expect(log).toHaveBeenCalledTimes(1)
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

  it('reads stdin, emits JSONL events, and sets a failed-run exit code', async () => {
    const client = {
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
      type: 'run.event',
      data: { sessionId: stableSessionId, kind: 'tool' }
    }
    const client = {
      events: async function* () {
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
      yield { type: 'permission.requested', data: { sessionId: 'session-1' } }
    }
    const client = {
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
    expect(warn).toHaveBeenCalledWith(
      'Run is waiting for approval. Approve the request in Open Science Desktop or the Web UI.'
    )
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

  it('explicitly cancels the server run after a wait timeout and preserves the timeout error', async () => {
    const timeout = Object.assign(new Error('Timed out waiting for run run-1.'), {
      code: 'timeout'
    })
    const client = {
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
      'runtime',
      'settings'
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
