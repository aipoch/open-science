import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { PassThrough, Readable, Writable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as acp from '@agentclientprotocol/sdk'

import { AcpRuntime } from './runtime.test-utils'
import { AcpRuntimeCoordinator } from './runtime-coordinator'
import { createCodexCompletionGateRuntime } from './codex-completion-handoff'
import {
  CompletionGateCoordinator,
  createCompletionGateSwitchNotifier,
  runCompletionGatedTool
} from '../agents/completion-gate'
import { codexFramework } from '../agent-framework'
import { buildSpecialistIdentityPrefix } from '../specialist/identity'
import { ArtifactRepository } from '../artifacts/repository'
import { ConnectorService } from '../connectors/service'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import type { NotebookRuntimeService } from '../notebook/runtime-service'
import {
  emptyFullAccessConfig,
  emptySelectedConfig,
  type SpecialistView
} from '../../shared/specialist'

class FakeAgentProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill(): boolean {
    this.emit('exit', 0, null)
    return true
  }
}

const asAgentProcess = (process: FakeAgentProcess): ChildProcessWithoutNullStreams =>
  process as unknown as ChildProcessWithoutNullStreams

const CODEX_MODES = {
  currentModeId: 'agent',
  availableModes: ['read-only', 'agent', 'agent-full-access'].map((id) => ({ id, name: id }))
}

const profile = (
  id: string,
  name: string,
  skills: string[],
  connectors: string[]
): SpecialistView => ({
  id,
  name,
  displayName: name,
  description: '',
  systemPrompt: `You are ${name}.`,
  enabled: true,
  capabilityMode: 'selected',
  fullAccess: emptyFullAccessConfig(),
  selectedCapabilities: {
    ...emptySelectedConfig(),
    skillIds: skills,
    connectorIds: connectors
  },
  revision: 1
})

describe('Codex approved handoff', () => {
  it('continues the original task with the newly approved identity and capability projection', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'codex-handoff-'))
    const process = new FakeAgentProcess()
    const providerRequests: string[] = []
    let observeContinuationCapabilities = async (): Promise<void> => undefined
    let releaseOldPrompt: (() => void) | undefined

    acp
      .agent({ name: 'codex-handoff-provider' })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          sessionCapabilities: { close: {}, resume: {} }
        },
        authMethods: []
      }))
      .onRequest(acp.methods.agent.authenticate, () => ({}))
      .onRequest(acp.methods.agent.providers.set, () => ({}))
      .onRequest(acp.methods.agent.session.new, () => ({
        sessionId: 'codex-session',
        modes: CODEX_MODES
      }))
      .onRequest(acp.methods.agent.session.setMode, () => ({}))
      .onRequest(acp.methods.agent.session.setConfigOption, () => ({ configOptions: [] }))
      .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        const request = ctx.params.prompt
          .map((content) => (content.type === 'text' ? content.text : ''))
          .join('')
        providerRequests.push(request)
        if (providerRequests.length === 1) {
          await new Promise<void>((resolve) => {
            releaseOldPrompt = resolve
          })
          return { stopReason: 'cancelled' }
        }
        await observeContinuationCapabilities()
        return { stopReason: 'end_turn' }
      })
      .onNotification(acp.methods.agent.session.cancel, () => releaseOldPrompt?.())
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
          Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
        )
      )

    const oldSpecialist = profile('old-specialist', 'Old Specialist', ['old-skill'], ['chemistry'])
    const approvedSpecialist = profile(
      'approved-specialist',
      'Approved Specialist',
      ['approved-skill'],
      ['molecule']
    )
    const resolveSpecialist = (specialistId: string): SpecialistView =>
      specialistId === approvedSpecialist.id ? approvedSpecialist : oldSpecialist
    let approvedBinding = oldSpecialist.id
    const notebookPromptMessageIds: string[] = []
    const userMessages: string[] = []
    const localConnector = vi.fn(async (_args, context) => ({
      specialistId: context.specialistId
    }))
    const connectorService = new ConnectorService({
      getConnectors: () => ({ enabledIds: [], autoAllowIds: [] }),
      resolveApiKey: () => undefined,
      resolveSpecialistProfile: async (specialistId) => resolveSpecialist(specialistId),
      localToolHandlers: { 'molecule/preview_molecule': localConnector }
    })
    const notebookRpcServer = new NotebookLocalRpcServer({} as NotebookRuntimeService, {
      transport: 'tcp',
      connectorService
    })
    onTestFinished(async () => {
      await notebookRpcServer.close()
      await rm(storageRoot, { recursive: true, force: true })
    })
    const callNotebookConnector = async (
      server: string,
      method: string,
      args: Record<string, unknown>
    ): Promise<unknown> => {
      const connection = await notebookRpcServer.issueSessionConnection(
        'codex-session',
        'test',
        'root-frame-codex-session'
      )
      const response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method: 'mcpCall', params: { server, method, args } })
      })
      const payload = (await response.json()) as { result?: unknown; error?: string }
      if (!response.ok) throw new Error(payload.error ?? `Notebook RPC failed: ${response.status}`)
      return payload.result
    }
    let allowedConnectorResult: unknown
    let deniedConnectorError = ''
    observeContinuationCapabilities = async () => {
      allowedConnectorResult = await callNotebookConnector('molecule', 'preview_molecule', {
        smiles: 'C'
      })
      try {
        await callNotebookConnector('chemistry', 'pubchem_get_compounds', { cids: [1] })
      } catch (error) {
        deniedConnectorError = error instanceof Error ? error.message : String(error)
      }
    }
    const runtime = new AcpRuntimeCoordinator(
      (callbacks) =>
        new AcpRuntime({
          appVersion: 'test',
          defaultCwd: '/workspace',
          resolveBackend: () => ({
            framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
            executablePath: '/bin/codex-acp',
            env: {}
          }),
          framework: { ...codexFramework, spawn: () => asAgentProcess(process) },
          artifacts: {
            configRoot: storageRoot,
            dataRoot: storageRoot,
            projectId: 'test',
            mcpEntryPath: '/test/mcp.js',
            repository: new ArtifactRepository(storageRoot),
            getRpcConnection: () => notebookRpcServer.ensureStarted()
          },
          notebook: {
            projectId: 'test',
            mcpEntryPath: '/test/mcp.js',
            getRpcConnection: ({ sessionId, projectId }) =>
              notebookRpcServer.issueSessionConnection(
                sessionId,
                projectId,
                `root-frame-${sessionId}`
              ),
            registerSessionAlias: (aliasSessionId, sessionId) =>
              notebookRpcServer.registerSessionAlias(aliasSessionId, sessionId),
            releaseSessionCapabilities: (sessionId) =>
              notebookRpcServer.releaseSessionCapabilities(sessionId),
            registerSessionSpecialist: (sessionId, specialistId) =>
              notebookRpcServer.registerSessionSpecialist(sessionId, specialistId),
            setArtifactTurnBinding: (sessionId, binding) => {
              notebookRpcServer.setArtifactTurnBinding(sessionId, binding)
              notebookPromptMessageIds.push(binding.provenanceContext.promptMessageId)
            },
            clearArtifactTurnBinding: (sessionId, ownerExecutionId) =>
              notebookRpcServer.clearArtifactTurnBinding(sessionId, ownerExecutionId)
          },
          resolveSpecialistIdentity: async (specialistId) => {
            const selected = resolveSpecialist(specialistId)
            return { append: '', prefix: buildSpecialistIdentityPrefix(selected) }
          },
          resolveSpecialistSkills: async (specialistId) => {
            const selected = resolveSpecialist(specialistId)
            return {
              kind: 'specialist' as const,
              skillIds: selected.selectedCapabilities.skillIds,
              frameworkNames: [
                ...selected.selectedCapabilities.skillIds,
                ...selected.selectedCapabilities.connectorIds.map((id) => `mcp-${id}`)
              ],
              missingSkillIds: []
            }
          },
          callbacks
        }),
      {
        onEvent: (event) => {
          if (event.kind === 'message' && event.role === 'user' && event.text) {
            userMessages.push(event.text)
          }
        }
      }
    )

    await runtime.createSession({ cwd: '/workspace', specialistId: oldSpecialist.id })
    const oldPrompt = runtime.sendPrompt({
      sessionId: 'codex-session',
      text: 'Complete the analysis.'
    })
    await vi.waitFor(() => expect(providerRequests).toHaveLength(1))
    expect(providerRequests[0]).toContain('Old Specialist')

    approvedBinding = approvedSpecialist.id
    const handoff = new CompletionGateCoordinator(
      createCodexCompletionGateRuntime({
        runtime,
        resolveApprovedSpecialistId: () => approvedBinding
      })
    )
    const context = {
      sessionId: 'codex-session',
      turnId: 'control-tool-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'control-tool-1'
    }
    createCompletionGateSwitchNotifier(handoff).notify({
      ...context,
      targetName: approvedSpecialist.name
    })

    const disposition = await runCompletionGatedTool({
      coordinator: handoff,
      context,
      execute: async () => ({ status: 'approved' }),
      deliverToCurrentPrompt: async () => {
        throw new Error('The old Codex prompt must not receive the approved completion.')
      }
    })
    await oldPrompt

    expect(disposition).toMatchObject({ kind: 'capture-for-handoff' })
    expect(providerRequests).toHaveLength(2)
    expect(providerRequests[1]).toContain('Approved Specialist')
    expect(providerRequests[1]).toContain('approved-skill')
    expect(providerRequests[1]).toContain('mcp-molecule')
    expect(providerRequests[1]).not.toContain('Old Specialist')
    expect(allowedConnectorResult).toEqual({ specialistId: approvedSpecialist.id })
    expect(deniedConnectorError).toContain('specialist_capability_denied')
    expect(localConnector).toHaveBeenCalledOnce()
    expect(notebookPromptMessageIds).toHaveLength(2)
    expect(notebookPromptMessageIds[1]).toBe(notebookPromptMessageIds[0])
    expect(userMessages).toEqual(['Complete the analysis.'])
  })
})
