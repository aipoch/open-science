import type { PdfAnnotationAgentTools } from '../pdf-annotations/agent-tools'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import { claudeCodeFramework, codexFramework, opencodeFramework } from '../agent-framework'
import type { AgentMcpHttpHost } from './mcp-http-host'
import { CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY } from './session-capability-owner'
import type { LiteratureMcpHandler } from '../literature/mcp-server'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

it.each([
  ['claude-code', claudeCodeFramework, false],
  ['opencode', opencodeFramework, false],
  ['codex-response', codexFramework, false],
  ['codex-bridge', codexFramework, true]
] as const)(
  '%s binds PDF element evidence to the active prompt and cancels stale deliveries',
  async (_name, framework, bridge) => {
    const root = await mkdtemp(join(tmpdir(), 'pdf-element-runtime-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    let handler: LiteratureMcpHandler | undefined
    const list = vi.fn(async () => ({ data: { elements: [], nextCursor: null } }))
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const read = vi.fn(async () => {
      await pending
      return { data: { imageIncluded: false } }
    })
    const writes = vi.fn()
    const annotations: PdfAnnotationAgentTools = {
      list: vi.fn(async (context) => {
        context.check()
        return { annotations: [] }
      }),
      locate: vi.fn(async (context) => {
        context.check()
        return { targets: [] }
      }),
      create: async (context) => {
        await pending
        context.check()
        writes()
        return { id: 'created' }
      }
    }
    const owners = composeAcpRuntimeBaseOwners({
      appVersion: 'test',
      defaultCwd: root,
      mcpHttpHost: {
        ensureStarted: vi.fn(async () => ({ endpoint: 'http://127.0.0.1:5', token: 'host' })),
        registerLiterature: vi.fn((_id, value: LiteratureMcpHandler) => {
          handler = value
        }),
        urlFor: vi.fn((kind, id) => `http://127.0.0.1:5/${kind}/${id}`),
        unregister: vi.fn(),
        clear: vi.fn(),
        close: vi.fn()
      } as unknown as AgentMcpHttpHost,
      literature: {
        isEnabled: async () => true,
        readDocument: vi.fn(),
        elements: { list, read },
        annotations
      }
    })
    const provision = await owners.sessionCapabilities.provision({
      stableAppSessionId: 'session',
      framework,
      nativeMcpEnabled: !bridge,
      bridgeMcpAliasesEnabled: bridge,
      policy: CURRENT_PRIMARY_SESSION_CAPABILITY_POLICY,
      sessionCwd: root,
      projectId: 'project'
    })
    cleanup.push(
      () => provision.release({ ownsStableIdentity: true }),
      () => owners.sessionInteractions.supersedeAll()
    )
    if (bridge)
      expect(provision.bridgeMcpTools?.map((tool) => tool.name)).toContain('create_pdf_annotation')
    const signal = new AbortController().signal
    await expect(handler!.elements!.list({}, signal)).rejects.toThrow('NO_LINKED_PDF_CONTEXT')
    const interaction = owners.sessionInteractions.claim({
      sessionId: 'session',
      kind: 'prompt',
      promptMessageId: 'message'
    })
    await handler!.elements!.list({}, signal)
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        sessionId: 'session',
        promptMessageId: 'message',
        signal: expect.any(AbortSignal)
      }),
      {}
    )
    await handler!.annotations!.list({}, signal)
    const staleWrite = handler!.annotations!.create(
      { targetRef: 'ref', requestId: 'note', note: 'Note' },
      signal
    )
    const rejectedWrite = expect(staleWrite).rejects.toThrow()
    const stale = handler!.elements!.read({ elementRef: 'ref' }, signal)
    const rejected = expect(stale).rejects.toThrow()
    owners.sessionInteractions.supersede(interaction)
    owners.sessionInteractions.claim({
      sessionId: 'session',
      kind: 'prompt',
      promptMessageId: 'replacement'
    })
    finish()
    await rejected
    await rejectedWrite
    expect(writes).not.toHaveBeenCalled()
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(handler!.elements!.list({}, cancelled.signal)).rejects.toThrow()
    expect(list).toHaveBeenCalledTimes(1)
  }
)
