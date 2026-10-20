import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApplicationCallerLeaseRegistry } from '../caller-lifecycle'
import { randomUUID } from 'node:crypto'
import { createCallerContext } from '../caller-context'
import { createManagedPreviewOwnerRegistry } from '../managed-preview-owner-registry'
import type { ApplicationInvocation } from '../application-command-router'
import { createOfficePreviewCommands, type OfficePreviewCommands } from './application-commands'
import type { OfficePreviewOpenRequest } from '../../shared/office-preview'

const request: OfficePreviewOpenRequest = {
  source: 'artifact',
  projectId: 'project',
  fileId: 'file',
  versionId: 'version',
  requestId: 'request',
  name: 'report.docx',
  extension: 'docx',
  attempt: 0
}
const disposals: OfficePreviewCommands[] = []
afterEach(async () => {
  for (const owner of disposals.splice(0)) await owner.dispose()
})
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function document() {
  const controller = new AbortController()
  const clientId = randomUUID()
  const context = createCallerContext({
    clientId,
    lifecycleClientId: `electron:${clientId}`,
    leaseId: randomUUID(),
    surface: 'electron',
    location: 'local',
    principalKind: 'human',
    actionOrigin: 'human'
  })
  const { lease, release } = new ApplicationCallerLeaseRegistry().acquire(context)
  controller.signal.addEventListener('abort', release, { once: true })
  const invoke = <T extends readonly unknown[]>(args: T): ApplicationInvocation<T> => ({
    args,
    callerContext: context,
    callerLease: lease
  })
  return { controller, clientId, lease, invoke }
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function setup() {
  const resources = {
    inspect: vi.fn().mockResolvedValue({ size: 100, version: 1, dev: 1n, ino: 2n, mtimeNs: 3n }),
    acquire: vi.fn().mockResolvedValue({
      id: 'resource',
      url: 'open-science-preview://resource/file',
      size: 100,
      mimeType: 'application/octet-stream',
      version: 1
    }),
    readRange: vi.fn(),
    release: vi.fn(),
    releaseOwner: vi.fn()
  }
  const registry = createManagedPreviewOwnerRegistry(resources)
  const host = {
    resolveFrame: vi.fn().mockResolvedValue({ frameProcessId: 91, parentProcessId: 7 }),
    processMemory: vi.fn().mockResolvedValue(0)
  }
  const report = vi.fn()
  const commands = createOfficePreviewCommands(resources, registry, report, host)
  disposals.push(commands)
  return { resources, registry, host, report, commands }
}

describe('shared Office preview owner', () => {
  it('uses the same resource identity as other previews and scopes frames and events to its document', async () => {
    const { commands, resources, registry, report, host } = setup()
    const owner = document(),
      foreign = document()
    const id = registry.register(owner.lease).ownerId
    const result = await commands.open(owner.invoke([request]))
    if (result.kind !== 'started') throw new Error('preview did not start')
    expect(resources.acquire).toHaveBeenCalledWith(
      id,
      { source: 'artifact', projectId: 'project', fileId: 'file', versionId: 'version' },
      expect.objectContaining({ maxBytes: 40 * 1024 * 1024 })
    )
    expect(report).toHaveBeenCalledWith(
      owner.clientId,
      expect.objectContaining({ phase: 'starting' })
    )
    await expect(commands.attachFrame(foreign.invoke([result.sessionId]))).resolves.toBeUndefined()
    expect(host.resolveFrame).not.toHaveBeenCalled()
    await expect(commands.attachFrame(owner.invoke([result.sessionId]))).resolves.toMatchObject({
      kind: 'attached'
    })
    expect(host.resolveFrame).toHaveBeenCalledWith(owner.clientId, result.runtimeUrl)
    report.mockClear()
    commands.reportState(
      foreign.invoke([result.sessionId, { sessionId: result.sessionId, phase: 'ready' }])
    )
    await commands.close(foreign.invoke([result.sessionId]))
    expect(report).not.toHaveBeenCalled()
    expect(resources.release).not.toHaveBeenCalled()
    owner.controller.abort()
    await commands.dispose()
    expect(resources.release).not.toHaveBeenCalled()
    expect(resources.releaseOwner).toHaveBeenCalledWith(id)
    expect(() =>
      commands.reportState(
        owner.invoke([result.sessionId, { sessionId: result.sessionId, phase: 'ready' }])
      )
    ).toThrow()
  })
  it.each(['inspect', 'acquire'] as const)(
    'revokes an open cancelled while awaiting %s',
    async (phase) => {
      const { commands, resources, registry } = setup()
      const owner = document(),
        id = registry.register(owner.lease).ownerId
      let finish!: (value: unknown) => void
      resources[phase].mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      const opening = commands.open(owner.invoke([request]))
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      owner.controller.abort()
      finish(
        phase === 'inspect'
          ? { size: 100, version: 1, dev: 1n, ino: 2n, mtimeNs: 3n }
          : {
              id: 'late',
              url: 'open-science-preview://late/file',
              size: 100,
              mimeType: 'application/octet-stream',
              version: 1
            }
      )
      await expect(opening).resolves.toEqual({ kind: 'cancelled' })
      if (phase === 'inspect') expect(resources.acquire).not.toHaveBeenCalled()
      else expect(resources.releaseOwner).toHaveBeenCalledWith(id)
    }
  )
  it('does not attach a frame after navigation while native proof is pending', async () => {
    const { commands, host, report } = setup(),
      owner = document()
    const result = await commands.open(owner.invoke([request]))
    if (result.kind !== 'started') throw new Error('preview did not start')
    let finish!: (value: unknown) => void
    host.resolveFrame.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const attach = commands.attachFrame(owner.invoke([result.sessionId]))
    owner.controller.abort()
    report.mockClear()
    finish({ frameProcessId: 91, parentProcessId: 7 })
    await expect(attach).resolves.toBeUndefined()
    expect(report).not.toHaveBeenCalled()
  })
  it.each([
    null,
    {},
    { ...request, source: 'other' },
    { ...request, attempt: -1 },
    { ...request, extension: 'exe' },
    { ...request, versionId: 5 }
  ])('rejects malformed input before filesystem access', async (value) => {
    const { commands, resources } = setup()
    await expect(
      commands.open(document().invoke([value as OfficePreviewOpenRequest]))
    ).rejects.toThrow('Invalid Office preview request')
    expect(resources.inspect).not.toHaveBeenCalled()
  })
})
