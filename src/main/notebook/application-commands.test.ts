import { describe, expect, it, vi } from 'vitest'

import { ApplicationCommandError } from '../../shared/application-command-contract'
import {
  createApplicationCommandRouter,
  type ApplicationInvocation
} from '../application-command-router'
import { createCallerContext, type CallerContext } from '../caller-context'
import {
  installNotebookApplicationCommands,
  notebookAppendCodeCellCommand,
  notebookApplicationCommands,
  notebookBeginCodeCellCommand,
  notebookExecuteCommand,
  notebookExportIpynbAllCommand,
  notebookExportIpynbCommand,
  notebookAbortCodeCellCommand,
  notebookFinishCodeCellCommand,
  notebookInspectNamespaceCommand,
  notebookReadInputPreviewCommand,
  notebookReferenceCommand,
  notebookRestartCommand,
  notebookRunCellCommand,
  notebookShutdownCommand,
  notebookStateCommand
} from './application-commands'
import {
  installNotebookEnvironmentApplicationCommands,
  notebookEnvironmentApplicationCommands,
  notebookEnvironmentCancelCommand,
  notebookEnvironmentProvisionCommand,
  notebookEnvironmentRepairCommand,
  notebookEnvironmentStatusCommand
} from './environment-application-commands'
import type { NotebookEnvironmentLifecycle } from './environment-lifecycle-workflows'
import {
  createNotebookCommandWorkflows,
  type NotebookCommandRuntime,
  type NotebookCommandWorkflows
} from './notebook-workflows'

const localCaller = createCallerContext({
  clientId: 'renderer-1',
  lifecycleClientId: 'web:renderer-1',
  leaseId: 'renderer-lease-1',
  surface: 'web',
  location: 'local',
  principalKind: 'human',
  actionOrigin: 'human'
})

const remoteCaller = createCallerContext({
  clientId: 'renderer-remote',
  lifecycleClientId: 'web:renderer-remote',
  leaseId: 'renderer-remote-lease',
  surface: 'web',
  location: 'remote',
  principalKind: 'human',
  actionOrigin: 'human'
})

const invocation = <Args extends readonly unknown[]>(
  args: Args,
  callerContext: CallerContext = localCaller
): ApplicationInvocation<Args> => ({
  callerContext,
  callerLease: {
    leaseId: callerContext.leaseId,
    generation: 1,
    signal: new AbortController().signal,
    isCurrent: () => true
  },
  args
})

describe('Notebook application commands', () => {
  it('owns exactly the 18 renderer-callable Notebook and Environment commands', () => {
    expect([
      ...notebookApplicationCommands.commands,
      ...notebookEnvironmentApplicationCommands.commands
    ]).toEqual([
      expect.objectContaining({ name: 'notebook:state' }),
      expect.objectContaining({ name: 'notebook:inspect-namespace' }),
      expect.objectContaining({ name: 'notebook:reference' }),
      expect.objectContaining({ name: 'notebook:begin-code-cell' }),
      expect.objectContaining({ name: 'notebook:append-code-cell' }),
      expect.objectContaining({ name: 'notebook:abort-code-cell' }),
      expect.objectContaining({ name: 'notebook:finish-code-cell' }),
      expect.objectContaining({ name: 'notebook:run-cell' }),
      expect.objectContaining({ name: 'notebook:execute' }),
      expect.objectContaining({ name: 'notebook:export-ipynb' }),
      expect.objectContaining({ name: 'notebook:export-ipynb-all' }),
      expect.objectContaining({ name: 'notebook:restart' }),
      expect.objectContaining({ name: 'notebook:shutdown' }),
      expect.objectContaining({ name: 'notebook:read-input-preview' }),
      expect.objectContaining({ name: 'notebook-env:status' }),
      expect.objectContaining({ name: 'notebook-env:provision' }),
      expect.objectContaining({ name: 'notebook-env:repair' }),
      expect.objectContaining({ name: 'notebook-env:cancel' })
    ])
  })

  it('routes Notebook commands through the owner workflows and input-preview port', async () => {
    const workflowMethods = [
      'state',
      'inspectNamespace',
      'reference',
      'beginCodeCell',
      'appendCodeCell',
      'abortCodeCell',
      'finishCodeCell',
      'runCell',
      'execute',
      'exportIpynb',
      'exportIpynbAll',
      'restart',
      'shutdown'
    ] as const
    const workflows = Object.fromEntries(
      workflowMethods.map((method) => [
        method,
        vi.fn(async (request: unknown) => ({ method, request }))
      ])
    ) as unknown as NotebookCommandWorkflows
    const readInputPreview = vi.fn(async (request: unknown) => ({
      content: JSON.stringify(request),
      encoding: 'utf8' as const,
      size: 1,
      truncated: false
    }))
    const router = createApplicationCommandRouter()
    installNotebookApplicationCommands(router.registrar, { workflows, readInputPreview })
    const session = { sessionId: 'session-1', workspaceCwd: '/workspace' }
    const cases = [
      [notebookStateCommand, [session], 'state'],
      [
        notebookInspectNamespaceCommand,
        [{ ...session, language: 'python', environment: 'default-python' }],
        'inspectNamespace'
      ],
      [notebookReferenceCommand, [session], 'reference'],
      [notebookBeginCodeCellCommand, [session], 'beginCodeCell'],
      [
        notebookAppendCodeCellCommand,
        [{ ...session, cellId: 'cell-1', writeId: 'write-1', delta: 'print(1)' }],
        'appendCodeCell'
      ],
      [
        notebookFinishCodeCellCommand,
        [{ ...session, cellId: 'cell-1', writeId: 'write-1' }],
        'finishCodeCell'
      ],
      [
        notebookAbortCodeCellCommand,
        [{ ...session, cellId: 'cell-1', writeId: 'write-1' }],
        'abortCodeCell'
      ],
      [notebookRunCellCommand, [{ ...session, cellId: 'cell-1' }], 'runCell'],
      [notebookExecuteCommand, [{ ...session, code: 'print(1)' }], 'execute'],
      [notebookExportIpynbCommand, [{ ...session, kernel: 'python' }], 'exportIpynb'],
      [notebookExportIpynbAllCommand, [session], 'exportIpynbAll'],
      [notebookRestartCommand, [session], 'restart'],
      [notebookShutdownCommand, [session], 'shutdown']
    ] as const

    for (const [command, args, method] of cases) {
      await expect(
        router.dispatcher.invoke(command as never, invocation(args) as never)
      ).resolves.toEqual({ method, request: args[0] })
      expect(
        (workflows as unknown as Record<string, ReturnType<typeof vi.fn>>)[method]
      ).toHaveBeenCalledWith(args[0])
    }

    const previewRequest = { path: 'notebook-input:key', maxBytes: 1024 }
    await router.dispatcher.invoke(
      notebookReadInputPreviewCommand,
      invocation([previewRequest] as const)
    )
    expect(readInputPreview).toHaveBeenCalledWith(previewRequest)
    expect(router.dispatcher.commandNames()).toEqual(
      notebookApplicationCommands.commands.map(({ name }) => name).sort()
    )
  })

  it('strips renderer-supplied provenance and input leases before runtime execution', async () => {
    const runtime = {
      runCell: vi.fn(async () => ({ runId: 'run-1' })),
      execute: vi.fn(async () => ({ runId: 'run-2' }))
    } as unknown as NotebookCommandRuntime
    const router = createApplicationCommandRouter()
    installNotebookApplicationCommands(router.registrar, {
      workflows: createNotebookCommandWorkflows(runtime),
      readInputPreview: vi.fn()
    })
    const trustedFields = {
      provenanceContext: {
        rootFrameId: 'forged-root',
        agentFrameId: 'forged-agent',
        messageBranchId: 'forged-branch',
        runtimeSegmentId: 'forged-runtime',
        promptMessageId: 'forged-prompt'
      },
      registeredInputFiles: [],
      inputRunLeaseId: 'forged-lease'
    }
    const runRequest = {
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      cellId: 'cell-1',
      ...trustedFields
    }
    const executeRequest = {
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      code: 'print(1)',
      ...trustedFields
    }

    await router.dispatcher.invoke(notebookRunCellCommand, invocation([runRequest] as const))
    await router.dispatcher.invoke(notebookExecuteCommand, invocation([executeRequest] as const))

    expect(runtime.runCell).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      cellId: 'cell-1'
    })
    expect(runtime.execute).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      code: 'print(1)'
    })
  })

  it('rejects both export commands for remote callers before invoking workflows', async () => {
    const exportIpynb = vi.fn()
    const exportIpynbAll = vi.fn()
    const workflows = {
      exportIpynb,
      exportIpynbAll
    } as unknown as NotebookCommandWorkflows
    const router = createApplicationCommandRouter()
    installNotebookApplicationCommands(router.registrar, {
      workflows,
      readInputPreview: vi.fn()
    })
    const session = { sessionId: 'session-1', workspaceCwd: '/workspace' }

    await expect(
      router.dispatcher.invoke(
        notebookExportIpynbCommand,
        invocation([{ ...session, kernel: 'python' }] as const, remoteCaller)
      )
    ).rejects.toThrow('Channel only available from the local app: notebook:export-ipynb')
    await expect(
      router.dispatcher.invoke(
        notebookExportIpynbAllCommand,
        invocation([session] as const, remoteCaller)
      )
    ).rejects.toThrow('Channel only available from the local app: notebook:export-ipynb-all')
    expect(exportIpynb).not.toHaveBeenCalled()
    expect(exportIpynbAll).not.toHaveBeenCalled()
  })

  it('routes Environment commands through the owner lifecycle and preserves optional cancel', async () => {
    const status = vi.fn(async () => ({
      pythonReady: true,
      rReady: false,
      version: 1,
      provisioning: false
    }))
    const provision = vi.fn(async () => undefined)
    const repair = vi.fn(async () => undefined)
    const cancel = vi.fn()
    const lifecycle = {
      status,
      provision,
      repair,
      cancel,
      startup: vi.fn()
    } as NotebookEnvironmentLifecycle
    const router = createApplicationCommandRouter()
    installNotebookEnvironmentApplicationCommands(router.registrar, lifecycle)

    await expect(
      router.dispatcher.invoke(notebookEnvironmentStatusCommand, invocation([] as const))
    ).resolves.toMatchObject({ pythonReady: true })
    await router.dispatcher.invoke(
      notebookEnvironmentProvisionCommand,
      invocation(['r', 'provision-operation'] as const)
    )
    await router.dispatcher.invoke(
      notebookEnvironmentRepairCommand,
      invocation(['python', 'default-python', 'repair-operation'] as const)
    )
    await router.dispatcher.invoke(notebookEnvironmentCancelCommand, invocation([] as const))

    expect(provision).toHaveBeenCalledWith('r', 'provision-operation')
    expect(repair).toHaveBeenCalledWith('python', 'default-python', 'repair-operation')
    expect(cancel).toHaveBeenCalledWith(undefined)
    expect(lifecycle.startup).not.toHaveBeenCalled()
    expect(router.dispatcher.commandNames()).toEqual(
      notebookEnvironmentApplicationCommands.commands.map(({ name }) => name).sort()
    )
  })

  it('keeps Environment status remote-readable but rejects remote mutations before the lifecycle', async () => {
    const status = vi.fn(async () => ({
      pythonReady: false,
      rReady: false,
      version: 1,
      provisioning: false
    }))
    const provision = vi.fn()
    const repair = vi.fn()
    const cancel = vi.fn()
    const router = createApplicationCommandRouter()
    installNotebookEnvironmentApplicationCommands(router.registrar, {
      status,
      provision,
      repair,
      cancel,
      startup: vi.fn()
    })

    await expect(
      router.dispatcher.invoke(
        notebookEnvironmentStatusCommand,
        invocation([] as const, remoteCaller)
      )
    ).resolves.toMatchObject({ provisioning: false })
    await expect(
      router.dispatcher.invoke(
        notebookEnvironmentProvisionCommand,
        invocation(['python'] as const, remoteCaller)
      )
    ).rejects.toThrow('Channel only available from the local app: notebook-env:provision')
    await expect(
      router.dispatcher.invoke(
        notebookEnvironmentRepairCommand,
        invocation(['r', 'default-r'] as const, remoteCaller)
      )
    ).rejects.toThrow('Channel only available from the local app: notebook-env:repair')
    await expect(
      router.dispatcher.invoke(
        notebookEnvironmentCancelCommand,
        invocation([] as const, remoteCaller)
      )
    ).rejects.toThrow('Channel only available from the local app: notebook-env:cancel')
    expect(status).toHaveBeenCalledOnce()
    expect(provision).not.toHaveBeenCalled()
    expect(repair).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('rejects an unknown Environment language before the lifecycle runs', async () => {
    const provision = vi.fn()
    const repair = vi.fn()
    const cancel = vi.fn()
    const router = createApplicationCommandRouter()
    installNotebookEnvironmentApplicationCommands(router.registrar, {
      status: vi.fn(),
      provision,
      repair,
      cancel,
      startup: vi.fn()
    })

    const error = await router.dispatcher
      .invoke(notebookEnvironmentProvisionCommand, invocation(['julia'] as never))
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApplicationCommandError)
    expect(error).toMatchObject({ code: 'invalid-command-arguments' })
    await expect(
      router.dispatcher.invoke(notebookEnvironmentRepairCommand, invocation(['julia'] as never))
    ).rejects.toMatchObject({ code: 'invalid-command-arguments' })
    await expect(
      router.dispatcher.invoke(notebookEnvironmentCancelCommand, invocation(['julia'] as never))
    ).rejects.toMatchObject({ code: 'invalid-command-arguments' })
    expect(provision).not.toHaveBeenCalled()
    expect(repair).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('treats JSON-null optional Environment arguments as omitted', async () => {
    const provision = vi.fn(async () => undefined)
    const repair = vi.fn(async () => undefined)
    const cancel = vi.fn()
    const router = createApplicationCommandRouter()
    installNotebookEnvironmentApplicationCommands(router.registrar, {
      status: vi.fn(),
      provision,
      repair,
      cancel,
      startup: vi.fn()
    })

    await router.dispatcher.invoke(notebookEnvironmentCancelCommand, invocation([null] as never))
    await router.dispatcher.invoke(
      notebookEnvironmentProvisionCommand,
      invocation(['python', null] as never)
    )
    await router.dispatcher.invoke(
      notebookEnvironmentRepairCommand,
      invocation(['r', 'default-r', null] as never)
    )

    expect(cancel).toHaveBeenCalledWith(undefined)
    expect(provision).toHaveBeenCalledWith('python', undefined)
    expect(repair).toHaveBeenCalledWith('r', 'default-r', undefined)
  })
})
