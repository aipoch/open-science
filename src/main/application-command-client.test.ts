import { describe, expect, it, vi } from 'vitest'

import type { ApplicationCommandByNameDispatcher } from './application-command-composition'
import type { ApplicationInvocation } from './application-command-router'
import { createCallerContext, createWebCallerContext } from './caller-context'
import { createApplicationCommandClient } from './application-command-client'

describe('Application command client', () => {
  it('reuses a caller lease until release, then replaces and aborts it', async () => {
    const invocations: ApplicationInvocation<readonly unknown[]>[] = []
    const dispatcher: ApplicationCommandByNameDispatcher = {
      commandNames: () => ['projects:list'],
      invoke: vi.fn(async (_commandName, invocation) => {
        invocations.push(invocation)
        return invocation.args
      })
    }
    const client = createApplicationCommandClient()
    const callerContext = createWebCallerContext('browser-1')

    await client.invoke(dispatcher, 'projects:list', callerContext, ['first'])
    await client.invoke(dispatcher, 'projects:list', callerContext, ['second'])

    expect(invocations[1]?.callerLease).toBe(invocations[0]?.callerLease)
    expect(invocations[0]?.callerLease.isCurrent()).toBe(true)

    client.releaseClient('web', 'browser-1')
    expect(invocations[0]?.callerLease.signal.aborted).toBe(true)
    expect(invocations[0]?.callerLease.isCurrent()).toBe(false)

    await client.invoke(dispatcher, 'projects:list', callerContext, ['third'])
    expect(invocations[2]?.callerLease).not.toBe(invocations[0]?.callerLease)
    expect(invocations[2]?.callerLease.generation).toBeGreaterThan(
      invocations[0]?.callerLease.generation ?? 0
    )
  })

  it('aborts every caller on disposal and rejects later invocations as a promise', async () => {
    let invocation: ApplicationInvocation<readonly unknown[]> | undefined
    const dispatcher: ApplicationCommandByNameDispatcher = {
      commandNames: () => ['projects:list'],
      invoke: vi.fn(async (_commandName, current) => {
        invocation = current
        return undefined
      })
    }
    const client = createApplicationCommandClient()
    const callerContext = createWebCallerContext('browser-disposed')

    await client.invoke(dispatcher, 'projects:list', callerContext, [])
    client.dispose()

    expect(invocation?.callerLease.signal.aborted).toBe(true)
    await expect(client.invoke(dispatcher, 'projects:list', callerContext, [])).rejects.toThrow(
      'Application command client is disposed.'
    )
    expect(dispatcher.invoke).toHaveBeenCalledOnce()
  })

  it('keeps caller leases isolated by surface when client ids match', async () => {
    const invocations: ApplicationInvocation<readonly unknown[]>[] = []
    const dispatcher: ApplicationCommandByNameDispatcher = {
      commandNames: () => ['projects:list'],
      invoke: vi.fn(async (_commandName, invocation) => {
        invocations.push(invocation)
        return undefined
      })
    }
    const client = createApplicationCommandClient()
    const web = createWebCallerContext('shared-client')
    const task = createCallerContext({
      clientId: 'shared-client',
      lifecycleClientId: 'web:shared-client',
      leaseId: 'shared-client',
      surface: 'task',
      location: 'local',
      principalKind: 'automation',
      actionOrigin: 'automation'
    })

    await client.invoke(dispatcher, 'projects:list', web, [])
    await client.invoke(dispatcher, 'projects:list', task, [])
    client.releaseClient('web', 'shared-client')

    expect(invocations[0]?.callerLease.signal.aborted).toBe(true)
    expect(invocations[1]?.callerLease.signal.aborted).toBe(false)
    expect(invocations[1]?.callerLease.isCurrent()).toBe(true)
  })
})
