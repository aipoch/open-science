import type { AgentFramework } from '../agent-framework'

class AcpProviderPromptSerializationOwner {
  private tail: Promise<void> = Promise.resolve()

  async run<Result>(framework: AgentFramework, action: () => Promise<Result>): Promise<Result> {
    if (framework.serializesProviderPrompts !== true) return action()

    const predecessor = this.tail.catch(() => undefined)
    let release!: () => void
    const slot = new Promise<void>((resolve) => {
      release = resolve
    })
    const current = predecessor.then(() => slot)
    this.tail = current

    await predecessor
    try {
      return await action()
    } finally {
      release()
      if (this.tail === current) this.tail = Promise.resolve()
    }
  }
}

export { AcpProviderPromptSerializationOwner }
