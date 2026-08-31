import { describe, expect, it, vi } from 'vitest'

import type { PermissionGrantSnapshot } from '../../shared/permission-grants'
import { RENDERER_CONTRACT_GROUPS } from '../../shared/renderer-contract-catalog'
import {
  createApplicationCommandRouter,
  type ApplicationCallerLease,
  type ApplicationInvocation
} from '../application-command-router'
import { createWebCallerContext } from '../caller-context'
import {
  permissionGrantApplicationCommandGroup,
  permissionGrantApplicationCommands,
  registerPermissionGrantApplicationCommands
} from './application-commands'
import type { PermissionGrantProjection } from './projection-controller'

const snapshot: PermissionGrantSnapshot = {
  version: 4,
  incompleteStores: [],
  grants: [],
  counts: { all: 0, global: 0, project: 0, session: 0 }
}

const createOwner = (): PermissionGrantProjection => ({
  list: vi.fn(async () => snapshot),
  restoreDefaults: vi.fn(async () => ({ ...snapshot, restoredCount: 2 })),
  revoke: vi.fn(async () => ({ ...snapshot, receipt: undefined, conflicts: [] })),
  extendUndo: vi.fn(async () => ({ undoToken: 'undo-1', expiresAt: 10, revokedCount: 1 })),
  restore: vi.fn(async () => ({ ...snapshot, conflicts: [] }))
})

const invocation = <Args extends readonly unknown[]>(args: Args): ApplicationInvocation<Args> => {
  const callerContext = createWebCallerContext('remote-web', { location: 'remote' })
  const callerLease: ApplicationCallerLease = Object.freeze({
    leaseId: callerContext.leaseId,
    generation: 1,
    signal: new AbortController().signal,
    isCurrent: () => true
  })
  return Object.freeze({ args, callerContext, callerLease })
}

describe('Permission Grant application commands', () => {
  it('defines exactly the five registry-management commands', () => {
    const publicPermissionChannels = RENDERER_CONTRACT_GROUPS.find(
      (group) => group.capability === 'permissions'
    )
      ?.contracts.filter((contract) => contract.kind === 'method')
      .map((contract) => contract.channel)

    expect(publicPermissionChannels).toHaveLength(5)
    expect(permissionGrantApplicationCommandGroup.commands.map(({ name }) => name)).toEqual(
      publicPermissionChannels
    )
  })

  it('delegates management to one injected projection owner without adding a caller guard', async () => {
    const owner = createOwner()
    const router = createApplicationCommandRouter()
    const installation = registerPermissionGrantApplicationCommands(router.registrar, owner)
    const revoke = { grants: [{ id: 'grant-1', revision: 2 }] }
    const undo = { undoToken: 'undo-1' }

    await expect(
      router.dispatcher.invoke(permissionGrantApplicationCommands.list, invocation([]))
    ).resolves.toBe(snapshot)
    await expect(
      router.dispatcher.invoke(permissionGrantApplicationCommands.restoreDefaults, invocation([]))
    ).resolves.toMatchObject({ restoredCount: 2 })
    await router.dispatcher.invoke(permissionGrantApplicationCommands.revoke, invocation([revoke]))
    await router.dispatcher.invoke(
      permissionGrantApplicationCommands.extendUndo,
      invocation([undo])
    )
    await router.dispatcher.invoke(permissionGrantApplicationCommands.restore, invocation([undo]))

    expect(owner.revoke).toHaveBeenCalledWith(revoke)
    expect(owner.restoreDefaults).toHaveBeenCalledOnce()
    expect(owner.extendUndo).toHaveBeenCalledWith(undo)
    expect(owner.restore).toHaveBeenCalledWith(undo)

    installation.uninstall()
    expect(router.dispatcher.commandNames()).toEqual([])
  })
})
