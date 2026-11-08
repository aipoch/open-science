import { useComputeStore } from '@/stores/compute-store'
import { ComputeTargetGroup, type ComputeGroupNavigation } from './ComputeTargetGroup'

export function HostedTargets({ onNavigate }: ComputeGroupNavigation): React.JSX.Element {
  const targets = useComputeStore((state) => state.hostedTargets)
  const loadError = useComputeStore((state) => state.hostedLoadError)
  return (
    <ComputeTargetGroup
      backend="hosted"
      targets={targets}
      loadError={loadError}
      onNavigate={onNavigate}
      describe={(target) => target.namespace + ' / ' + target.flavor}
    />
  )
}
