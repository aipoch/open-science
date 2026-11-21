import { claudeCodeFramework } from '../agent-framework'
import { onTestFinished, vi } from 'vitest'
import { AcpRuntime as ProductionAcpRuntime } from './runtime'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import type { AcpRuntimeOptions } from './runtime-contract'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'

class AcpRuntime extends ProductionAcpRuntime {
  constructor(options: AcpRuntimeOptions) {
    const baseOwners = composeAcpRuntimeBaseOwners(options)
    super(options, baseOwners, composeAcpRuntimeSessionOwners(options, baseOwners))
    Object.defineProperty(this, 'artifactRunRegistry', {
      value: baseOwners.artifactRunRegistry
    })
  }
}

// These mock peers model Claude-specific ACP metadata, modes, and MCP setup.
class ClaudeProtocolFixtureRuntime extends AcpRuntime {
  constructor(options: AcpRuntimeOptions) {
    super({ framework: claudeCodeFramework, ...options })
  }
}

export { AcpRuntime, ClaudeProtocolFixtureRuntime }

// Keep transport I/O real; the transition-owner suite verifies the full idle clock policy.
export const shortenIdleReleaseWindow = (): void => {
  const realSetTimeout = globalThis.setTimeout
  const timer = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) =>
      realSetTimeout(
        callback,
        callback.name === 'releaseIdleConnection' ? 10 : delay,
        ...args
      )) as typeof setTimeout)
  onTestFinished(() => timer.mockRestore())
}
