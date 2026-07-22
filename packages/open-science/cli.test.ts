import { describe, expect, it, vi } from 'vitest'

import { CliUsageError, parseCliArgs, reportCliError, runTaskCommand } from './cli.mjs'

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

  it('dispatches project, session, and artifact commands through the SDK', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue([{ id: 'project-1', name: 'Research' }]),
      createProject: vi.fn().mockResolvedValue({ id: 'project-2', name: 'Created' }),
      getSession: vi.fn().mockResolvedValue({ id: 'session-1', status: 'idle' }),
      getRun: vi.fn().mockResolvedValue({ id: 'run-1', status: 'completed' }),
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
    expect(client.listArtifacts).toHaveBeenCalledWith('session-1')
    expect(client.downloadArtifact).toHaveBeenCalledWith('artifact-1')
    expect(writeDownload).toHaveBeenCalledWith(expect.any(Response), 'report.md')
  })

  it('reads stdin, emits JSONL events, and sets a failed-run exit code', async () => {
    const client = {
      events: async function* () {
        yield { type: 'run.event', data: { sessionId: 'session-1', kind: 'tool' } }
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
      { type: 'run.event', data: { sessionId: 'session-1', kind: 'tool' } },
      expect.objectContaining({ id: 'run-1', status: 'failed' })
    ])
    expect(setExitCode).toHaveBeenCalledWith(1)
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
  })
})
