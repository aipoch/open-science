import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  handlers: new Map<string, Parameters<IpcMain['handle']>[1]>(),
  failAt: undefined as string | undefined
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Parameters<IpcMain['handle']>[1]) => {
      if (native.failAt === channel) throw new Error(`install failed: ${channel}`)
      if (native.handlers.has(channel)) throw new Error(`duplicate channel: ${channel}`)
      native.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => native.handlers.delete(channel)
  }
}))

import { ApprovalBroker } from '../connectors/approval-broker'
import { CredentialRequestBroker } from '../connectors/credential-request-broker'
import { disposeIpcHandlerRegistry, ipcMainHandle } from '../ipc-handler-registry'
import { SkillImportApprovalBroker } from '../skills/conversation-import'
import { createConnectorApprovalElectronSurface } from './connector-approvals'

const channels = [
  'connectors:approval-respond',
  'connectors:approval-replay',
  'connectors:approval-replay-pending',
  'connectors:credential-respond',
  'connectors:credential-replay-pending',
  'skills:conversation-import-respond',
  'skills:conversation-import-replay-pending'
]
const invoke = (channel: string, request?: unknown): unknown =>
  native.handlers.get(channel)!({ sender: { id: 42 } } as IpcMainInvokeEvent, request)

const fixture = (): {
  approvals: ApprovalBroker
  credentials: CredentialRequestBroker
  skills: SkillImportApprovalBroker
  approvalBroadcast: ReturnType<typeof vi.fn>
  approvalReplay: ReturnType<typeof vi.fn>
  credentialBroadcast: ReturnType<typeof vi.fn>
  credentialReplay: ReturnType<typeof vi.fn>
  skillBroadcast: ReturnType<typeof vi.fn>
} => {
  const approvalBroadcast = vi.fn()
  const approvalReplay = vi.fn()
  const credentialBroadcast = vi.fn()
  const credentialReplay = vi.fn()
  const skillBroadcast = vi.fn()
  return {
    approvals: new ApprovalBroker({
      generateId: () => 'approval',
      broadcast: approvalBroadcast,
      replay: approvalReplay
    }),
    credentials: new CredentialRequestBroker({
      generateId: () => 'credential',
      broadcast: credentialBroadcast,
      replay: credentialReplay
    }),
    skills: new SkillImportApprovalBroker({
      generateId: () => 'skill',
      broadcast: skillBroadcast
    }),
    approvalBroadcast,
    approvalReplay,
    credentialBroadcast,
    credentialReplay,
    skillBroadcast
  }
}
const approvalInfo = {
  connector: 'literature',
  method: 'search',
  argsPreview: '{}',
  sessionId: 'session-1'
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  disposeIpcHandlerRegistry()
  native.failAt = undefined
  expect(native.handlers.size).toBe(0)
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('connector approval Electron production surface', () => {
  it('preserves parked requests across uninstall and routes replay and responses to the same brokers', async () => {
    const owners = fixture()
    const { approvals, credentials, skills } = owners
    const approval = approvals.request(approvalInfo)
    const credential = credentials.request({
      credentialId: 'openalex',
      connector: 'literature',
      method: 'search'
    })
    const skill = skills.request({
      sessionId: 'session-1',
      source: { kind: 'attachment', label: 'demo.skill' },
      previews: [],
      skipped: []
    })
    const surface = createConnectorApprovalElectronSurface(approvals, credentials, skills)
    expect(surface.name).toBe('connector-approvals')
    expect(native.handlers.size).toBe(0)
    ipcMainHandle('test:external', () => 'external')
    const installed = await surface.install()
    expect([...native.handlers.keys()]).toEqual(['test:external', ...channels])
    await installed.uninstall()
    await installed.uninstall()
    expect([...native.handlers.keys()]).toEqual(['test:external'])
    expect(vi.getTimerCount()).toBe(3)

    const reinstalled = await surface.install()
    expect(invoke('connectors:approval-replay', 'approval')).toBe(approvals.getPending('approval'))
    invoke('connectors:approval-replay-pending')
    invoke('connectors:credential-replay-pending')
    invoke('skills:conversation-import-replay-pending')
    expect(owners.approvalReplay).toHaveBeenCalledExactlyOnceWith(approvals.getPending('approval'))
    expect(owners.credentialReplay).toHaveBeenCalledExactlyOnceWith(
      credentials.getPending('credential')
    )
    expect(owners.approvalBroadcast).toHaveBeenCalledOnce()
    expect(owners.credentialBroadcast).toHaveBeenCalledOnce()
    expect(owners.skillBroadcast).toHaveBeenCalledTimes(2)
    expect(owners.skillBroadcast.mock.calls[1][0]).toBe(owners.skillBroadcast.mock.calls[0][0])

    const selection = { id: 'skill', items: [] }
    invoke('connectors:approval-respond', { id: 'approval', decision: 'once' })
    invoke('connectors:credential-respond', { id: 'credential', configured: true })
    invoke('skills:conversation-import-respond', selection)
    await expect(approval).resolves.toBe('once')
    await expect(credential).resolves.toBe(true)
    await expect(skill).resolves.toBe(selection)
    expect(vi.getTimerCount()).toBe(0)

    invoke('connectors:approval-respond', { id: 'approval', decision: 'deny' })
    invoke('connectors:credential-respond', { id: 'credential', configured: false })
    invoke('skills:conversation-import-respond', { id: 'skill', cancelled: true })
    invoke('connectors:approval-replay-pending')
    invoke('connectors:credential-replay-pending')
    invoke('skills:conversation-import-replay-pending')
    expect(invoke('connectors:approval-replay', 'approval')).toBeNull()
    expect(owners.approvalReplay).toHaveBeenCalledOnce()
    expect(owners.credentialReplay).toHaveBeenCalledOnce()
    expect(owners.skillBroadcast).toHaveBeenCalledTimes(2)
    await reinstalled.uninstall()
    expect(invoke('test:external')).toBe('external')
  })

  it('rejects non-string replay ids without calling the shared broker', async () => {
    const { approvals, credentials, skills } = fixture()
    await createConnectorApprovalElectronSurface(approvals, credentials, skills).install()
    const getPending = vi.spyOn(approvals, 'getPending')
    for (const id of [undefined, null, 1, {}, ['approval']]) {
      expect(invoke('connectors:approval-replay', id)).toBeNull()
    }
    expect(getPending).not.toHaveBeenCalled()
    expect(invoke('connectors:approval-replay', 'unknown')).toBeNull()
    expect(getPending).toHaveBeenCalledExactlyOnceWith('unknown')
  })

  it.each(channels)(
    'rolls back a failed install at %s without settling a parked call',
    async (channel) => {
      const { approvals, credentials, skills } = fixture()
      const pending = approvals.request(approvalInfo)
      ipcMainHandle('test:external', () => 'external')
      const surface = createConnectorApprovalElectronSurface(approvals, credentials, skills)
      native.failAt = channel
      expect(() => surface.install()).toThrow(`install failed: ${channel}`)
      expect([...native.handlers.keys()]).toEqual(['test:external'])
      expect(approvals.getPending('approval')).not.toBeNull()
      expect(vi.getTimerCount()).toBe(1)
      native.failAt = undefined
      const installed = await surface.install()
      expect([...native.handlers.keys()]).toEqual(['test:external', ...channels])
      invoke('connectors:approval-respond', { id: 'approval', decision: 'deny' })
      await expect(pending).resolves.toBe('deny')
      await installed.uninstall()
      expect([...native.handlers.keys()]).toEqual(['test:external'])
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})
