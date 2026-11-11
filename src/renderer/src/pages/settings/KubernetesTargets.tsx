import { useComputeStore } from '@/stores/compute-store'
import { ComputeTargetGroup, type ComputeGroupNavigation } from './ComputeTargetGroup'

export function KubernetesTargets({ onNavigate }: ComputeGroupNavigation): React.JSX.Element {
  const targets = useComputeStore((state) => state.kubernetesTargets)
  const loadError = useComputeStore((state) => state.kubernetesLoadError)
  return (
    <ComputeTargetGroup
      backend="kubernetes"
      targets={targets}
      loadError={loadError}
      onNavigate={onNavigate}
      describe={(target) => target.context + ' / ' + target.namespace}
    />
  )
}
