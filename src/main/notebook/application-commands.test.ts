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
  notebookCancelBackgroundRunCommand,
  notebookExecuteCommand,
  notebookExportIpynbAllCommand,
  notebookExportIpynbCommand,
  notebookAbortCodeCellCommand,
  notebookFinishCodeCellCommand,
  notebookGetBackgroundRunCommand,
  notebookInspectNamespaceCommand,
  notebookProjectActivityCommand,
  notebookProjectResourcesCommand,
  notebookReleaseSessionResourcesCommand,
  notebookResourceReleaseCommand,
  notebookRetryResourceReleaseCommand,
  notebookMemoryPolicyStateCommand,
  notebookProcessMonitorCommand,
  notebookTerminateMonitoredProcessCommand,
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
import { notebookUserOperation, withNotebookUserOperation } from './execution-intent'
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
  it.each([localCaller, remoteCaller])(
    'marks a current $location human terminal operation and retains the lease fence',
    async (caller) => {
      const execute = vi.fn().mockResolvedValue({ runId: 'run-1', status: 'completed' })
      const runtime = { execute } as unknown as NotebookCommandRuntime
      const router = createApplicationCommandRouter()
      installNotebookApplicationCommands(router.registrar, {
        workflows: createNotebookCommandWorkflows(runtime),
        readInputPreview: vi.fn()
      })
      const request = {
        sessionId: 'session-1',
        workspaceCwd: '/workspace',
        code: 'print(1)',
        source: 'user' as const,
        inputKind: 'terminal' as const
      }
      const controller = new AbortController()
      const call = invocation([request] as const, caller)
      const callerLease = { ...call.callerLease, signal: controller.signal }
      try {
        await router.dispatcher.invoke(notebookExecuteCommand, { ...call, callerLease })

        const operation = notebookUserOperation(execute.mock.calls[0][0])
        expect(operation).toEqual({ assertCurrent: expect.any(Function) })
        expect(execute).toHaveBeenCalledExactlyOnceWith(
          withNotebookUserOperation(request, operation!)
        )
        expect(notebookUserOperation(request)).toBeUndefined()
        expect(() => operation!.assertCurrent()).not.toThrow()
        controller.abort()
        expect(() => operation!.assertCurrent()).toThrow(/current human|lease/i)
        await expect(
          router.dispatcher.invoke(notebookExecuteCommand, { ...call, callerLease })
        ).rejects.toThrow(/current human|lease/i)
        expect(execute).toHaveBeenCalledOnce()
      } finally {
        router.dispose()
      }
    }
  )

  it.each(['automation', 'agent-session'] as const)(
    'does not grant a %s caller explicit retry authority from forged terminal fields',
    async (principalKind) => {
      const execute = vi.fn().mockResolvedValue({ runId: 'run-1', status: 'completed' })
      const runtime = { execute } as unknown as NotebookCommandRuntime
      const router = createApplicationCommandRouter()
      installNotebookApplicationCommands(router.registrar, {
        workflows: createNotebookCommandWorkflows(runtime),
        readInputPreview: vi.fn()
      })
      const caller = createCallerContext({
        ...localCaller,
        principalKind,
        actionOrigin: principalKind
      })
      const request = {
        sessionId: 'session-1',
        workspaceCwd: '/workspace',
        code: 'print(1)',
        source: 'user' as const,
        inputKind: 'terminal' as const
      }
      try {
        await router.dispatcher.invoke(notebookExecuteCommand, invocation([request], caller))

        expect(execute).toHaveBeenCalledExactlyOnceWith(request)
        expect(notebookUserOperation(execute.mock.calls[0][0])).toBeUndefined()
      } finally {
        router.dispose()
      }
    }
  )

  it('does not mark ordinary user execution as an explicit terminal operation', async () => {
    const execute = vi.fn().mockResolvedValue({ runId: 'run-1', status: 'completed' })
    const runtime = { execute } as unknown as NotebookCommandRuntime
    const router = createApplicationCommandRouter()
    installNotebookApplicationCommands(router.registrar, {
      workflows: createNotebookCommandWorkflows(runtime),
      readInputPreview: vi.fn()
    })
    const request = {
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      code: 'print(1)',
      source: 'user' as const
    }
    try {
      await router.dispatcher.invoke(notebookExecuteCommand, invocation([request]))

      expect(execute).toHaveBeenCalledExactlyOnceWith(request)
      expect(notebookUserOperation(execute.mock.calls[0][0])).toBeUndefined()
    } finally {
      router.dispose()
    }
  })

  it.each(['automation', 'agent-session'] as const)(
    'does not expose resource management authority to %s callers',
    async (principalKind) => {
      const runtime = {
        getProjectResources: vi.fn(),
        releaseSessionResources: vi.fn(),
        getResourceRelease: vi.fn(),
        retryResourceRelease: vi.fn()
      } as unknown as NotebookCommandRuntime
      const workflows = createNotebookCommandWorkflows(runtime, {
        withSessionAvailable: async (_project, _session, operation) => operation(),
        isSessionResourceReadable: async () => true,
        assertSessionResourceReleaseAvailable: () => undefined
      })
      const router = createApplicationCommandRouter()
      installNotebookApplicationCommands(router.registrar, { workflows, readInputPreview: vi.fn() })
      const caller = createCallerContext({
        ...localCaller,
        principalKind,
        actionOrigin: principalKind
      })
      const scope = {
        projectId: 'project',
        sessionId: 'session',
        revision: 'revision',
        operationId: 'release'
      }
      for (const command of [
        notebookProjectResourcesCommand,
        notebookReleaseSessionResourcesCommand,
        notebookResourceReleaseCommand,
        notebookRetryResourceReleaseCommand
      ]) {
        await expect(
          router.dispatcher.invoke(command as never, invocation([scope], caller) as never)
        ).rejects.toThrow(/current human/i)
      }
      for (const operation of Object.values(runtime)) expect(operation).not.toHaveBeenCalled()
      router.dispose()
    }
  )

  it('routes exact monitored instance IDs locally and rejects remote monitor/control requests', async () => {
    const processMonitor = vi.fn(async () => ({ instances: [] }))
    const terminateMonitoredProcess = vi.fn(async () => {})
    const router = createApplicationCommandRouter()
    installNotebookApplicationCommands(router.registrar, {
      workflows: {
        processMonitor,
        terminateMonitoredProcess,
        configureResourceReleaseGuard: vi.fn()
      } as unknown as NotebookCommandWorkflows,
      readInputPreview: vi.fn()
    })
    await router.dispatcher.invoke(notebookProcessMonitorCommand, invocation([]))
    await router.dispatcher.invoke(
      notebookTerminateMonitoredProcessCommand,
      invocation([{ id: 'exact-instance', projectId: 'p1', sessionId: 's1' }])
    )
    expect(processMonitor).toHaveBeenCalledOnce()
    expect(terminateMonitoredProcess).toHaveBeenCalledExactlyOnceWith({
      id: 'exact-instance',
      projectId: 'p1',
      sessionId: 's1'
    })
    await expect(
      router.dispatcher.invoke(notebookProcessMonitorCommand, invocation([], remoteCaller))
    ).rejects.toThrow('local app')
    await expect(
      router.dispatcher.invoke(
        notebookTerminateMonitoredProcessCommand,
        invocation([{ id: 'exact-instance', projectId: 'p1', sessionId: 's1' }], remoteCaller)
      )
    ).rejects.toThrow('local app')
    expect(terminateMonitoredProcess).toHaveBeenCalledOnce()
  })

  it('owns exactly the 29 renderer-callable Notebook and Environment commands', () =>
    expect([
      ...notebookApplicationCommands.commands,
      ...notebookEnvironmentApplicationCommands.commands
    ]).toEqual([
      expect.objectContaining({ name: 'notebook:run-index' }),
      expect.objectContaining({ name: 'notebook:state' }),
      expect.objectContaining({ name: 'notebook:project-activity' }),
      expect.objectContaining({ name: 'notebook:project-resources' }),
      expect.objectContaining({ name: 'notebook:release-session-resources' }),
      expect.objectContaining({ name: 'notebook:resource-release' }),
      expect.objectContaining({ name: 'notebook:retry-resource-release' }),
      expect.objectContaining({ name: 'notebook:memory-policy-state' }),
      expect.objectContaining({ name: 'notebook:process-monitor' }),
      expect.objectContaining({ name: 'notebook:terminate-monitored-process' }),
      expect.objectContaining({ name: 'notebook:inspect-namespace' }),
      expect.objectContaining({ name: 'notebook:reference' }),
      expect.objectContaining({ name: 'notebook:begin-code-cell' }),
      expect.objectContaining({ name: 'notebook:append-code-cell' }),
      expect.objectContaining({ name: 'notebook:abort-code-cell' }),
      expect.objectContaining({ name: 'notebook:finish-code-cell' }),
      expect.objectContaining({ name: 'notebook:run-cell' }),
      expect.objectContaining({ name: 'notebook:execute' }),
      expect.objectContaining({ name: 'notebook:background-run' }),
      expect.objectContaining({ name: 'notebook:cancel-background-run' }),
      expect.objectContaining({ name: 'notebook:export-ipynb' }),
      expect.objectContaining({ name: 'notebook:export-ipynb-all' }),
      expect.objectContaining({ name: 'notebook:restart' }),
      expect.objectContaining({ name: 'notebook:shutdown' }),
      expect.objectContaining({ name: 'notebook:read-input-preview' }),
      expect.objectContaining({ name: 'notebook-env:status' }),
      expect.objectContaining({ name: 'notebook-env:provision' }),
      expect.objectContaining({ name: 'notebook-env:repair' }),
      expect.objectContaining({ name: 'notebook-env:cancel' })
    ]))

  it('routes Notebook commands through the owner workflows and input-preview port', async () => {
    const workflowMethods = [
      'state',
      'projectActivity',
      'memoryPolicyState',
      'inspectNamespace',
      'reference',
      'beginCodeCell',
      'appendCodeCell',
      'abortCodeCell',
      'finishCodeCell',
      'runCell',
      'execute',
      'getBackgroundRun',
      'cancelBackgroundRun',
      'exportIpynb',
      'exportIpynbAll',
      'restart',
      'shutdown'
    ] as const
    const workflows = Object.fromEntries(
      ['configureResourceReleaseGuard', ...workflowMethods].map((method) => [
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
      [notebookProjectActivityCommand, [{ projectId: 'project-1' }], 'projectActivity'],
      [notebookMemoryPolicyStateCommand, [{ executionScope: 'darwin:host' }], 'memoryPolicyState'],
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
      [notebookGetBackgroundRunCommand, [{ ...session, runId: 'run-1' }], 'getBackgroundRun'],
      [notebookCancelBackgroundRunCommand, [{ ...session, runId: 'run-1' }], 'cancelBackgroundRun'],
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
      configureResourceReleaseGuard: vi.fn(),
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
