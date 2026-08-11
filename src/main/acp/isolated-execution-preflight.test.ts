import * as acp from '@agentclientprotocol/sdk'
import type { PromptResponse } from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Readable, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { AcpRuntime } from './runtime.test-utils'
import { createIsolatedAcpExecutionAdapter } from './isolated-execution-preflight'

class FakeAgentProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false

  readonly pid = undefined

  constructor(readonly processId: number) {
    super()
  }

  kill(): boolean {
    this.killed = true
    this.emit('exit', 0, null)
    return true
  }
}

const asAgentProcess = (process: FakeAgentProcess): ChildProcessWithoutNullStreams =>
  process as unknown as ChildProcessWithoutNullStreams

type Deferred = { promise: Promise<void>; resolve: () => void }

const deferred = (): Deferred => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const within = <Value>(label: string, promise: Promise<Value>): Promise<Value> =>
  Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`timed out: ${label}`)), 2_000)
    )
  ])

const startAgent = (
  process: FakeAgentProcess,
  identity: { providerSessionId: string; runtimeHome: string },
  completionGate: Deferred,
  onCancel: () => void
): void => {
  acp
    .agent({ name: 'isolated-preflight-agent' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
      authMethods: []
    }))
    .onRequest(acp.methods.agent.session.new, () => ({ sessionId: identity.providerSessionId }))
    .onRequest(acp.methods.agent.session.prompt, async (context) => {
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `process=${process.processId};home=${identity.runtimeHome}`
          }
        }
      })
      await context.client.request(acp.methods.client.session.requestPermission, {
        sessionId: context.params.sessionId,
        toolCall: {
          toolCallId: `tool-${process.processId}`,
          title: `permission-${process.processId}`,
          status: 'pending'
        },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
      })
      await completionGate.promise
      return { stopReason: 'end_turn' }
    })
    .onNotification(acp.methods.agent.session.cancel, () => onCancel())
    .onRequest(acp.methods.agent.session.close, () => ({}))
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
      )
    )
}

describe('isolated ACP execution preflight', () => {
  it('keeps two attempts in one app Session isolated through prompt, events, permission, cancel, and completion', async () => {
    const rootRuntime = new AcpRuntime({ appVersion: 'test', defaultCwd: '/work/root' })
    const rootSnapshot = rootRuntime.getSnapshot()
    const gates = [deferred(), deferred()]
    const processes: FakeAgentProcess[] = []
    let nextProcess = 0
    const adapter = createIsolatedAcpExecutionAdapter({
      assertFrameworkNativeDelegationDisabled: () => undefined,
      createRuntime: (scope, callbacks) => {
        const index = nextProcess++
        const process = new FakeAgentProcess(7000 + index)
        processes.push(process)
        startAgent(
          process,
          { providerSessionId: `provider-${index + 1}`, runtimeHome: scope.runtimeHome },
          gates[index],
          gates[index].resolve
        )
        return new AcpRuntime({
          appVersion: 'test',
          defaultCwd: scope.cwd,
          spawnAgent: () => asAgentProcess(process),
          callbacks
        })
      }
    })

    const first = await adapter.start({
      appSessionId: 'session-1',
      executionId: 'attempt-1',
      cwd: '/work/child-1',
      runtimeHome: '/runtime/attempt-1',
      prompt: 'first task'
    })
    const second = await adapter.start({
      appSessionId: 'session-1',
      executionId: 'attempt-2',
      cwd: '/work/child-2',
      runtimeHome: '/runtime/attempt-2',
      prompt: 'second task'
    })
    const firstSignals: string[] = []
    const secondSignals: string[] = []
    first.subscribe((signal) => firstSignals.push(JSON.stringify(signal)))
    second.subscribe((signal) => secondSignals.push(JSON.stringify(signal)))

    await Promise.all([first.accepted, second.accepted])
    await expect
      .poll(() => firstSignals.join('\n'))
      .toContain('process=7000;home=/runtime/attempt-1')
    await expect
      .poll(() => secondSignals.join('\n'))
      .toContain('process=7001;home=/runtime/attempt-2')
    expect(firstSignals.join('\n')).not.toContain('process=7001')
    expect(secondSignals.join('\n')).not.toContain('process=7000')
    await expect.poll(() => firstSignals.join('\n')).toContain('permission-7000')
    await expect.poll(() => secondSignals.join('\n')).toContain('permission-7001')

    const firstPermission = firstSignals.find(
      (signal) =>
        signal.includes('"kind":"permission-request"') && signal.includes('permission-7000')
    )
    const secondPermission = secondSignals.find(
      (signal) =>
        signal.includes('"kind":"permission-request"') && signal.includes('permission-7001')
    )
    const requestId = (signal: string | undefined): string =>
      (JSON.parse(signal ?? '{}') as { request?: { requestId?: string } }).request?.requestId ?? ''
    await first.respondToPermission({
      requestId: requestId(firstPermission),
      optionId: 'allow-once'
    })
    await second.respondToPermission({
      requestId: requestId(secondPermission),
      optionId: 'allow-once'
    })

    await within('first cancel', first.cancel())
    await within('first completion', first.completion)
    expect(processes[0].killed).toBe(false)
    expect(processes[1].killed).toBe(false)
    let secondCompleted = false
    void second.completion.then(() => {
      secondCompleted = true
    })
    await Promise.resolve()
    expect(secondCompleted).toBe(false)

    gates[1].resolve()
    await within('second completion', second.completion)
    expect(rootRuntime.getSnapshot()).toEqual(rootSnapshot)
    for (const process of processes) {
      process.stdin.destroy()
      process.stdout.destroy()
      process.stderr.destroy()
      process.kill()
    }
  })

  it('fails closed before creating a runtime when native delegation cannot be disabled', async () => {
    let runtimeCreated = false
    const adapter = createIsolatedAcpExecutionAdapter({
      assertFrameworkNativeDelegationDisabled: () => {
        throw new Error('native delegation remains enabled')
      },
      createRuntime: () => {
        runtimeCreated = true
        throw new Error('must not create runtime')
      }
    })

    await expect(
      adapter.start({
        appSessionId: 'session-1',
        executionId: 'attempt-unsupported',
        cwd: '/work/unsupported',
        runtimeHome: '/runtime/unsupported',
        prompt: 'must not run'
      })
    ).rejects.toThrow('native delegation remains enabled')
    expect(runtimeCreated).toBe(false)
  })

  it('cancels and drains an active turn before deleting its session and reaping its runtime', async () => {
    const order: string[] = []
    let finish!: (response: PromptResponse) => void
    const completion = new Promise<PromptResponse>((resolve) => {
      finish = resolve
    })
    const adapter = createIsolatedAcpExecutionAdapter({
      assertFrameworkNativeDelegationDisabled: () => undefined,
      createRuntime: (_scope, callbacks) => ({
        createSession: async () => ({ sessionId: 'provider-cleanup' }),
        sendAppContinuation: () => {
          callbacks.onProviderPromptAccepted?.('provider-cleanup')
          return completion
        },
        cancelPrompt: async () => {
          order.push('cancel')
          finish({ stopReason: 'cancelled' })
        },
        respondToPermission: async () => undefined,
        deleteSession: async () => {
          order.push('delete-session')
        },
        shutdownForQuit: async () => {
          order.push('reap-runtime')
          return { reaped: true }
        }
      })
    })
    const running = await adapter.start({
      appSessionId: 'session-1',
      executionId: 'attempt-cleanup',
      cwd: '/work/cleanup',
      runtimeHome: '/runtime/cleanup',
      prompt: 'cleanup task'
    })

    await running.dispose()

    expect(order).toEqual(['cancel', 'delete-session', 'reap-runtime'])
  })
})
