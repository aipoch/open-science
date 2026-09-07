import { describe, expect, it, vi } from 'vitest'

import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import {
  composeAcpRuntimePromptOwners,
  type AcpRuntimePromptHost,
  type AcpRuntimePromptOwners
} from './runtime-prompt-composition'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'

describe('ACP Runtime Prompt composition', () => {
  it('builds a fresh frozen graph without invoking Plan or reload hosts', () => {
    const options = { appVersion: 'test', defaultCwd: '/workspace' }
    const create = (): AcpRuntimePromptOwners => {
      const base = composeAcpRuntimeBaseOwners(options)
      const session = composeAcpRuntimeSessionOwners(options, base)
      const host: AcpRuntimePromptHost = {
        plan: {
          preflight: vi.fn(() => ({})),
          admit: vi.fn((_request, _interaction, plan) => plan),
          providerAccepted: vi.fn(async () => undefined),
          beforeRelease: vi.fn(),
          afterRelease: vi.fn(async () => undefined)
        },
        reload: {
          disconnect: vi.fn(async () => undefined),
          resume: vi.fn(async () => ({}))
        }
      }
      const owners = composeAcpRuntimePromptOwners(options, base, session, host)

      expect(host.plan.preflight).not.toHaveBeenCalled()
      expect(host.plan.admit).not.toHaveBeenCalled()
      expect(host.plan.beforeRelease).not.toHaveBeenCalled()
      expect(host.plan.afterRelease).not.toHaveBeenCalled()
      expect(host.reload.disconnect).not.toHaveBeenCalled()
      expect(host.reload.resume).not.toHaveBeenCalled()
      return owners
    }

    const first = create()
    const second = create()

    expect(Object.isFrozen(first)).toBe(true)
    expect(first.contextCompactionWorkflow).not.toBe(second.contextCompactionWorkflow)
    expect(first.promptTurnWorkflow).not.toBe(second.promptTurnWorkflow)
  })
})
