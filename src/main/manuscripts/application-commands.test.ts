import { describe, expect, it, vi } from 'vitest'

import {
  createApplicationCommandRouter,
  type ApplicationInvocation
} from '../application-command-router'
import { createCallerContext, type CallerContext } from '../caller-context'
import {
  installManuscriptApplicationCommands,
  manuscriptApplicationCommands,
  manuscriptDetectQuartoCommand,
  manuscriptExportCommand,
  manuscriptPrepareCommand,
  manuscriptRenderCommand
} from './application-commands'
import type { ManuscriptCommandOwner } from './command-owner'

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

describe('Manuscript application commands', () => {
  it('owns the preview and render/export command surface', () => {
    expect(manuscriptApplicationCommands.commands).toEqual([
      expect.objectContaining({ name: 'manuscripts:detect-quarto' }),
      expect.objectContaining({ name: 'manuscripts:prepare' }),
      expect.objectContaining({ name: 'manuscripts:render' }),
      expect.objectContaining({ name: 'manuscripts:export' })
    ])
  })

  it('routes detection, preview preparation, render, and export through the owner', async () => {
    const owner = {
      detectQuarto: vi.fn(async () => ({
        available: true as const,
        path: '/opt/quarto/bin/quarto',
        version: '1.7.32'
      })),
      prepare: vi.fn(async (request) => ({
        markdown: request.content,
        qmd: request.content,
        references: []
      })),
      render: vi.fn(async (request) => ({
        filename: `paper.${request.format}`,
        mimeType: 'application/octet-stream',
        dataBase64: 'b3V0cHV0',
        references: []
      }))
    } satisfies ManuscriptCommandOwner
    const router = createApplicationCommandRouter()
    installManuscriptApplicationCommands(router.registrar, owner)
    const prepareRequest = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      content: '# Paper\n'
    }
    const renderRequest = {
      ...prepareRequest,
      format: 'pdf' as const,
      filename: 'paper.qmd'
    }

    await expect(
      router.dispatcher.invoke(manuscriptDetectQuartoCommand, invocation([] as const))
    ).resolves.toMatchObject({ available: true, version: '1.7.32' })
    await expect(
      router.dispatcher.invoke(manuscriptPrepareCommand, invocation([prepareRequest]))
    ).resolves.toMatchObject({ markdown: '# Paper\n' })
    await expect(
      router.dispatcher.invoke(manuscriptRenderCommand, invocation([renderRequest]))
    ).resolves.toMatchObject({ filename: 'paper.pdf' })
    await expect(
      router.dispatcher.invoke(manuscriptExportCommand, invocation([renderRequest]))
    ).resolves.toMatchObject({ filename: 'paper.pdf' })

    expect(owner.prepare).toHaveBeenCalledWith(prepareRequest)
    expect(owner.render).toHaveBeenCalledTimes(2)
    expect(owner.render).toHaveBeenLastCalledWith(renderRequest, expect.any(AbortSignal))
  })

  it('rejects renderer-supplied Quarto working directories', async () => {
    const owner = {
      detectQuarto: vi.fn(),
      prepare: vi.fn(),
      render: vi.fn()
    } as unknown as ManuscriptCommandOwner
    const router = createApplicationCommandRouter()
    installManuscriptApplicationCommands(router.registrar, owner)

    await expect(
      router.dispatcher.invoke(
        manuscriptRenderCommand,
        invocation([
          {
            projectId: 'project-1',
            appSessionId: 'session-1',
            content: '# Paper\n',
            format: 'pdf',
            workingDirectory: '/tmp/attacker-selected'
          }
        ])
      )
    ).rejects.toMatchObject({ code: 'invalid-command-arguments' })
    expect(owner.render).not.toHaveBeenCalled()
  })

  it('rejects renderer requests that opt into Quarto code execution', async () => {
    const owner = {
      detectQuarto: vi.fn(),
      prepare: vi.fn(),
      render: vi.fn()
    } as unknown as ManuscriptCommandOwner
    const router = createApplicationCommandRouter()
    installManuscriptApplicationCommands(router.registrar, owner)

    await expect(
      router.dispatcher.invoke(
        manuscriptRenderCommand,
        invocation([
          {
            projectId: 'project-1',
            appSessionId: 'session-1',
            content: '# Paper\n',
            format: 'pdf',
            execute: true
          } as never
        ])
      )
    ).rejects.toMatchObject({ code: 'invalid-command-arguments' })
    expect(owner.render).not.toHaveBeenCalled()
  })

  it('rejects remote callers before execution', async () => {
    const owner = {
      detectQuarto: vi.fn(),
      prepare: vi.fn(),
      render: vi.fn()
    } as unknown as ManuscriptCommandOwner
    const router = createApplicationCommandRouter()
    installManuscriptApplicationCommands(router.registrar, owner)

    await expect(
      router.dispatcher.invoke(manuscriptDetectQuartoCommand, invocation([] as const, remoteCaller))
    ).rejects.toThrow(/only available to local callers/iu)
    expect(owner.detectQuarto).not.toHaveBeenCalled()
  })
})
