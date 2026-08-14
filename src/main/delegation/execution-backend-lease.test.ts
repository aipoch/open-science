import { describe, expect, it, vi } from 'vitest'

import {
  claudeCodeFramework,
  codexFramework,
  opencodeFramework,
  skillRuntimeEnvironment,
  type ResolvedAgentBackend,
  type SkillRuntimeView
} from '../agent-framework'
import { createDelegateExecutionBackendLease } from './execution-backend-lease'

const skillRuntimeView = (projectionRoot: string): SkillRuntimeView => ({
  projectionRoot,
  discoveryRoot: `${projectionRoot}/skills`,
  descriptors: [
    {
      id: 'research',
      name: 'Research',
      description: 'Research primary sources.',
      path: `${projectionRoot}/skills/research/SKILL.md`
    }
  ],
  environment: {
    TMPDIR: `${projectionRoot}/tmp`,
    XDG_CACHE_HOME: `${projectionRoot}/cache`
  }
})

describe('delegated execution backend lease', () => {
  it('keeps one secret backend owner across batch claims and releases it exactly once', async () => {
    const release = vi.fn(async () => undefined)
    const releaseSkillRuntime = vi.fn(async () => undefined)
    const parentRuntime = skillRuntimeView('/runtime/parent/catalog')
    const backend: ResolvedAgentBackend = {
      framework: opencodeFramework,
      executablePath: '/fake-opencode',
      env: {
        OPENAI_API_KEY: 'process-memory-only',
        ...skillRuntimeEnvironment(parentRuntime),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          permission: { '*': 'ask' },
          skills: { paths: [parentRuntime.discoveryRoot] }
        })
      },
      providerTransportLease: { setTarget: () => true, release },
      skillRuntime: parentRuntime,
      skillRuntimeLease: { release: releaseSkillRuntime },
      skillRuntimeFork: {
        acquire: vi.fn(async (lifecycle) => {
          const releaseAttempt = attemptReleases[nextAttempt++]!
          return {
            view: skillRuntimeView(`/runtime/${lifecycle.agentFrameId}/catalog`),
            lease: { release: releaseAttempt }
          }
        })
      }
    }
    const attemptReleases = [vi.fn(async () => undefined), vi.fn(async () => undefined)]
    let nextAttempt = 0
    const admission = createDelegateExecutionBackendLease(backend)
    const first = admission.claim()
    const second = admission.claim()

    const firstBackend = await first.acquireAttemptBackend({
      lifecycle: { sessionId: 'session-1', agentFrameId: 'frame-1', runtimeSegmentId: 'runtime-1' }
    })
    const firstBackendAgain = await first.acquireAttemptBackend({
      lifecycle: { sessionId: 'ignored', agentFrameId: 'ignored', runtimeSegmentId: 'ignored' }
    })
    const secondBackend = await second.acquireAttemptBackend({
      lifecycle: { sessionId: 'session-1', agentFrameId: 'frame-2', runtimeSegmentId: 'runtime-2' }
    })
    expect(firstBackend.env.OPENAI_API_KEY).toBe('process-memory-only')
    expect(firstBackendAgain).toBe(firstBackend)
    expect(backend.skillRuntimeFork?.acquire).toHaveBeenCalledTimes(2)
    expect(firstBackend.providerTransportLease).toBeUndefined()
    expect(firstBackend.skillRuntime?.projectionRoot).not.toBe(
      secondBackend.skillRuntime?.projectionRoot
    )
    expect(firstBackend.skillRuntime?.environment.TMPDIR).not.toBe(
      secondBackend.skillRuntime?.environment.TMPDIR
    )
    expect(JSON.parse(firstBackend.env.OPENCODE_CONFIG_CONTENT ?? '{}').skills.paths).toEqual([
      firstBackend.skillRuntime?.discoveryRoot
    ])
    expect(JSON.parse(backend.env.OPENCODE_CONFIG_CONTENT ?? '{}').skills.paths).toEqual([
      parentRuntime.discoveryRoot
    ])
    expect(firstBackend.skillRuntimeLease).toBeUndefined()
    await admission.release()
    await admission.release()
    await first.release()
    expect(release).not.toHaveBeenCalled()
    await second.release()
    await second.release()
    expect(release).toHaveBeenCalledOnce()
    expect(releaseSkillRuntime).toHaveBeenCalledOnce()
    expect(attemptReleases[0]).toHaveBeenCalledOnce()
    expect(attemptReleases[1]).toHaveBeenCalledOnce()
  })

  it.each([
    ['Claude Code', claudeCodeFramework],
    ['Codex', codexFramework],
    ['OpenCode', opencodeFramework]
  ] as const)(
    'rebases every %s native Skill surface onto immutable private Attempt views',
    async (_name, framework) => {
      const parentRuntime = skillRuntimeView('/runtime/parent/catalog')
      const parentEnv = {
        PROVIDER_SECRET: 'process-memory-only',
        ...skillRuntimeEnvironment(parentRuntime),
        ...(framework.id === 'opencode'
          ? {
              OPENCODE_CONFIG_CONTENT: JSON.stringify({
                model: 'provider/model',
                permission: { '*': 'ask' },
                skills: { paths: [parentRuntime.discoveryRoot] }
              })
            }
          : {})
      }
      const attemptReleases = [vi.fn(async () => undefined), vi.fn(async () => undefined)]
      let nextAttempt = 0
      const backend: ResolvedAgentBackend = {
        framework,
        executablePath: `/fake-${framework.id}`,
        env: parentEnv,
        skillRuntime: parentRuntime,
        skillRuntimeLease: { release: vi.fn(async () => undefined) },
        skillRuntimeFork: {
          acquire: vi.fn(async (lifecycle) => ({
            view: skillRuntimeView(
              `/runtime/attempts/${lifecycle.agentFrameId}/${lifecycle.runtimeSegmentId}/catalog`
            ),
            lease: { release: attemptReleases[nextAttempt++]! }
          }))
        }
      }
      const admission = createDelegateExecutionBackendLease(backend)
      const first = admission.claim()
      const second = admission.claim()

      const firstBackend = await first.acquireAttemptBackend({
        lifecycle: { sessionId: 'session', agentFrameId: 'frame-1', runtimeSegmentId: 'segment-1' }
      })
      const secondBackend = await second.acquireAttemptBackend({
        lifecycle: { sessionId: 'session', agentFrameId: 'frame-2', runtimeSegmentId: 'segment-2' }
      })

      for (const attemptBackend of [firstBackend, secondBackend]) {
        const view = attemptBackend.skillRuntime!
        expect(attemptBackend.env).toMatchObject({
          PROVIDER_SECRET: 'process-memory-only',
          ...view.environment,
          OPEN_SCIENCE_SKILL_RUNTIME_ROOT: view.discoveryRoot,
          OPEN_SCIENCE_SKILL_DISCOVERY_ROOT: view.discoveryRoot,
          OPEN_SCIENCE_SKILL_PROJECTION_ROOT: view.projectionRoot
        })
        expect(view.descriptors).toEqual([
          expect.objectContaining({ path: `${view.discoveryRoot}/research/SKILL.md` })
        ])
        expect(JSON.stringify(attemptBackend.env)).not.toContain(parentRuntime.projectionRoot)

        if (framework.id === 'opencode') {
          expect(attemptBackend.env.XDG_CONFIG_HOME).toBe(
            `${view.environment.TMPDIR}/opencode-config`
          )
          expect(JSON.parse(attemptBackend.env.OPENCODE_CONFIG_CONTENT ?? '{}')).toMatchObject({
            model: 'provider/model',
            permission: { '*': 'ask' },
            skills: { paths: [view.discoveryRoot] }
          })
        }
        if (framework.id === 'claude-code') {
          const setup = framework.buildSessionSetup({
            systemPromptAppends: [],
            skillRuntime: view
          })
          const options = (setup.meta?.claudeCode as { options: Record<string, unknown> }).options
          expect(options).toMatchObject({
            plugins: [{ type: 'local', path: view.projectionRoot }],
            additionalDirectories: [view.projectionRoot],
            sandbox: {
              filesystem: {
                allowRead: [view.projectionRoot],
                denyWrite: [view.projectionRoot]
              }
            }
          })
          expect(JSON.stringify(options)).not.toContain(parentRuntime.projectionRoot)
        }
      }
      expect(firstBackend.skillRuntime?.projectionRoot).not.toBe(
        secondBackend.skillRuntime?.projectionRoot
      )
      expect(backend.env).toEqual(parentEnv)
      expect(backend.skillRuntime).toBe(parentRuntime)

      await admission.release()
      await Promise.all([first.release(), second.release()])
      expect(attemptReleases[0]).toHaveBeenCalledOnce()
      expect(attemptReleases[1]).toHaveBeenCalledOnce()
    }
  )

  it('retries a transient attempt runtime cleanup failure before releasing admission', async () => {
    const releaseSkillRuntime = vi.fn(async () => undefined)
    const releaseAttempt = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('transient cleanup failure'))
      .mockResolvedValue(undefined)
    const backend: ResolvedAgentBackend = {
      framework: opencodeFramework,
      executablePath: '/fake-opencode',
      env: {},
      skillRuntime: {
        projectionRoot: '/runtime/catalog',
        discoveryRoot: '/runtime/catalog/skills',
        descriptors: [],
        environment: { TMPDIR: '/runtime/base/tmp' }
      },
      skillRuntimeLease: { release: releaseSkillRuntime },
      skillRuntimeFork: {
        acquire: vi.fn(async () => ({
          view: {
            ...backend.skillRuntime!,
            environment: { TMPDIR: '/runtime/attempt/tmp' }
          },
          lease: { release: releaseAttempt }
        }))
      }
    }
    const admission = createDelegateExecutionBackendLease(backend)
    const claim = admission.claim()

    await claim.acquireAttemptBackend({
      lifecycle: { sessionId: 'session-1', agentFrameId: 'frame-1', runtimeSegmentId: 'runtime-1' }
    })
    await admission.release()
    await expect(claim.release()).resolves.toBeUndefined()

    expect(releaseAttempt).toHaveBeenCalledTimes(2)
    expect(releaseSkillRuntime).toHaveBeenCalledOnce()
  })

  it('releases a private Attempt runtime when framework rebasing fails closed', async () => {
    const parentRuntime = skillRuntimeView('/runtime/parent/catalog')
    const releaseAttempt = vi.fn(async () => undefined)
    const releaseSkillRuntime = vi.fn(async () => undefined)
    const backend: ResolvedAgentBackend = {
      framework: opencodeFramework,
      executablePath: '/fake-opencode',
      env: {
        ...skillRuntimeEnvironment(parentRuntime),
        OPENCODE_CONFIG_CONTENT: '{malformed'
      },
      skillRuntime: parentRuntime,
      skillRuntimeLease: { release: releaseSkillRuntime },
      skillRuntimeFork: {
        acquire: vi.fn(async () => ({
          view: skillRuntimeView('/runtime/attempt/catalog'),
          lease: { release: releaseAttempt }
        }))
      }
    }
    const admission = createDelegateExecutionBackendLease(backend)
    const claim = admission.claim()

    await expect(
      claim.acquireAttemptBackend({
        lifecycle: { sessionId: 'session', agentFrameId: 'frame', runtimeSegmentId: 'segment' }
      })
    ).rejects.toThrow('Cannot rebase OpenCode Skill runtime')
    await admission.release()
    await claim.release()

    expect(releaseAttempt).toHaveBeenCalledOnce()
    expect(releaseSkillRuntime).toHaveBeenCalledOnce()
  })
})
