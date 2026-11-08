import { useComputeStore } from '@/stores/compute-store'
import { ComputeTargetGroup, type ComputeGroupNavigation } from './ComputeTargetGroup'

export function RayTargets({ onNavigate }: ComputeGroupNavigation): React.JSX.Element {
  const targets = useComputeStore((state) => state.rayTargets)
  const loadError = useComputeStore((state) => state.rayLoadError)
  return (
    <ComputeTargetGroup
      backend="ray"
      targets={targets}
      loadError={loadError}
      onNavigate={onNavigate}
      describe={(target) => target.endpoint}
    />
  )
}
