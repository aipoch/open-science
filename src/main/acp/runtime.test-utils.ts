import { AcpRuntime as ProductionAcpRuntime, type AcpRuntimeOptions } from './runtime'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
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

export { AcpRuntime }
