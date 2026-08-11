import type { PromptResponse } from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'

import type { AcpPermissionRequest, AcpPermissionResponse, AcpRuntimeEvent } from '../../shared/acp'
import type { AcpRuntimeCallbacks } from './runtime'

type IsolatedAcpExecutionScope = Readonly<{
  appSessionId: string
  executionId: string
  cwd: string
  runtimeHome: string
}>

type IsolatedAcpExecutionInput = IsolatedAcpExecutionScope &
  Readonly<{
    prompt: string
  }>

type IsolatedAcpExecutionSignal =
  | Readonly<{
      kind: 'runtime-event'
      appSessionId: string
      executionId: string
      event: AcpRuntimeEvent
    }>
  | Readonly<{
      kind: 'permission-request'
      appSessionId: string
      executionId: string
      request: AcpPermissionRequest
    }>

type IsolatedAcpRuntime = Readonly<{
  createSession(request: { cwd: string }): Promise<{ sessionId: string }>
  sendAppContinuation(request: { sessionId: string; text: string }): Promise<PromptResponse>
  cancelPrompt(request: { sessionId: string }): Promise<unknown>
  respondToPermission(response: AcpPermissionResponse): Promise<unknown>
  deleteSession(request: { sessionId: string }): Promise<unknown>
  shutdownForQuit(): Promise<{ reaped: boolean }>
}>

type RunningIsolatedAcpExecution = Readonly<{
  appSessionId: string
  executionId: string
  runtimeInstanceId: string
  runtimeHome: string
  providerSessionId: string
  accepted: Promise<void>
  completion: Promise<PromptResponse>
  subscribe(listener: (signal: IsolatedAcpExecutionSignal) => void): () => void
  respondToPermission(response: AcpPermissionResponse): Promise<void>
  cancel(): Promise<void>
  dispose(): Promise<void>
}>

type IsolatedAcpExecutionAdapterOptions = Readonly<{
  assertFrameworkNativeDelegationDisabled(scope: IsolatedAcpExecutionScope): Promise<void> | void
  createRuntime(
    scope: IsolatedAcpExecutionScope,
    callbacks: AcpRuntimeCallbacks
  ): IsolatedAcpRuntime
}>

type IsolatedAcpExecutionAdapter = Readonly<{
  start(input: IsolatedAcpExecutionInput): Promise<RunningIsolatedAcpExecution>
}>

const createIsolatedAcpExecutionAdapter = (
  options: IsolatedAcpExecutionAdapterOptions
): IsolatedAcpExecutionAdapter => ({
  async start(input) {
    const scope: IsolatedAcpExecutionScope = Object.freeze({
      appSessionId: input.appSessionId,
      executionId: input.executionId,
      cwd: input.cwd,
      runtimeHome: input.runtimeHome
    })
    await options.assertFrameworkNativeDelegationDisabled(scope)

    const listeners = new Set<(signal: IsolatedAcpExecutionSignal) => void>()
    const bufferedSignals: IsolatedAcpExecutionSignal[] = []
    const publish = (signal: IsolatedAcpExecutionSignal): void => {
      bufferedSignals.push(signal)
      for (const listener of listeners) listener(signal)
    }
    let resolveAccepted!: () => void
    let rejectAccepted!: (error: unknown) => void
    let acceptanceSettled = false
    const accepted = new Promise<void>((resolve, reject) => {
      resolveAccepted = resolve
      rejectAccepted = reject
    })
    const settleAccepted = (error?: unknown): void => {
      if (acceptanceSettled) return
      acceptanceSettled = true
      if (error === undefined) resolveAccepted()
      else rejectAccepted(error)
    }
    const attachment: { providerSessionId?: string } = {}
    const runtime = options.createRuntime(scope, {
      onProviderPromptAccepted: (sessionId) => {
        if (sessionId === attachment.providerSessionId) settleAccepted()
      },
      onEvent: (event) => {
        if (event.sessionId === attachment.providerSessionId) {
          publish({
            kind: 'runtime-event',
            appSessionId: scope.appSessionId,
            executionId: scope.executionId,
            event
          })
        }
      },
      onPermissionRequest: (request) => {
        if (request.sessionId === attachment.providerSessionId) {
          publish({
            kind: 'permission-request',
            appSessionId: scope.appSessionId,
            executionId: scope.executionId,
            request
          })
        }
      }
    })
    const created = await runtime.createSession({ cwd: scope.cwd })
    attachment.providerSessionId = created.sessionId
    const providerSessionId = attachment.providerSessionId
    let completionSettled = false
    const completion = runtime
      .sendAppContinuation({ sessionId: providerSessionId, text: input.prompt })
      .catch((error) => {
        settleAccepted(error)
        throw error
      })
      .finally(() => {
        completionSettled = true
      })
    let disposal: Promise<void> | undefined

    return Object.freeze({
      appSessionId: scope.appSessionId,
      executionId: scope.executionId,
      runtimeInstanceId: randomUUID(),
      runtimeHome: scope.runtimeHome,
      providerSessionId,
      accepted,
      completion,
      subscribe(listener) {
        listeners.add(listener)
        for (const signal of bufferedSignals) listener(signal)
        return () => listeners.delete(listener)
      },
      async respondToPermission(response) {
        await runtime.respondToPermission(response)
      },
      async cancel() {
        await runtime.cancelPrompt({ sessionId: providerSessionId })
      },
      dispose() {
        if (!disposal) {
          disposal = (async () => {
            if (!completionSettled) {
              await runtime.cancelPrompt({ sessionId: providerSessionId }).catch(() => undefined)
              await completion.catch(() => undefined)
            }
            await runtime.deleteSession({ sessionId: providerSessionId }).catch(() => undefined)
            await runtime.shutdownForQuit()
            listeners.clear()
          })()
        }
        return disposal
      }
    })
  }
})

export { createIsolatedAcpExecutionAdapter }
export type {
  IsolatedAcpExecutionAdapter,
  IsolatedAcpExecutionInput,
  IsolatedAcpExecutionScope,
  IsolatedAcpExecutionSignal,
  IsolatedAcpRuntime,
  RunningIsolatedAcpExecution
}
