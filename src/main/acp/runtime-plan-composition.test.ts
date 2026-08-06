import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import { composeAcpRuntimePlanWorkflow } from './runtime-plan-composition'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'

const projectRoot = resolve(__dirname, '../../..')

describe('ACP Runtime Session Plan composition', () => {
  it('builds a fresh frozen workflow without publishing or requiring Plan capability', async () => {
    const options = { appVersion: 'test', defaultCwd: '/workspace' }
    const create = (): ReturnType<typeof composeAcpRuntimePlanWorkflow> => {
      const base = composeAcpRuntimeBaseOwners(options)
      const session = composeAcpRuntimeSessionOwners(options, base)
      const workflow = composeAcpRuntimePlanWorkflow(options, base, session)

      expect(session.publication.getSnapshot().events).toEqual([])
      return workflow
    }

    const first = create()
    const second = create()

    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.prompt)).toBe(true)
    expect(first).not.toBe(second)
    await expect(first.projection('project', 'session')).resolves.toBeNull()
    await expect(
      first.call({ projectId: 'project', sessionId: 'session', operation: 'approve' })
    ).rejects.toThrow('Session Plan capability is not configured.')
    await expect(
      first.respond({ projectId: 'project', sessionId: 'session', feedback: 'continue' })
    ).rejects.toThrow('Session Plan capability is not configured.')
  })

  it('keeps Plan state and Prompt policy behind one transport-independent workflow', () => {
    const runtime = readFileSync(resolve(projectRoot, 'src/main/acp/runtime.ts'), 'utf8')
    const plan = readFileSync(
      resolve(projectRoot, 'src/main/acp/runtime-plan-composition.ts'),
      'utf8'
    )
    const prompt = readFileSync(
      resolve(projectRoot, 'src/main/acp/runtime-prompt-composition.ts'),
      'utf8'
    )

    expect(runtime).not.toMatch(
      /private readonly (?:planInteractions|planService)|private (?:preflightPromptPlan|admitPromptPlan|checkPromptPlanCompletion|releasePromptPlanBinding|rejectPlanApprovalForInteraction|publishTerminalPlanProjection)/
    )
    expect(runtime).toContain('plan: this.sessionPlanWorkflow.prompt')
    expect(runtime).toContain('this.sessionPlanWorkflow.capturePromptCancellation(')
    expect(runtime).toContain('this.sessionPlanWorkflow.sessionDeleted(request.sessionId)')
    expect(prompt).toContain('plan: host.plan')
    expect(plan).toContain('const prompt: AcpPromptTurnPlanWorkflow = Object.freeze({')
    expect(plan).not.toMatch(/from ['"]electron['"]|application-commands|ipc|runtime-coordinator/)
  })
})
