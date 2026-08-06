import { AcpRuntime as ProductionAcpRuntime, type AcpRuntimeOptions } from './runtime'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'

class AcpRuntime extends ProductionAcpRuntime {
  constructor(options: AcpRuntimeOptions) {
    const owners = composeAcpRuntimeBaseOwners(options)
    super(options, owners)
    Object.defineProperty(this, 'artifactRunRegistry', { value: owners.artifactRunRegistry })
  }
}

export { AcpRuntime }
