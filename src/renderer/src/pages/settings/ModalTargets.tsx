import { useComputeStore } from '@/stores/compute-store'
import { ComputeTargetGroup, type ComputeGroupNavigation } from './ComputeTargetGroup'

export function ModalTargets({ onNavigate }: ComputeGroupNavigation): React.JSX.Element {
  const targets = useComputeStore((state) => state.modalTargets)
  const loadError = useComputeStore((state) => state.modalLoadError)
  return (
    <ComputeTargetGroup
      backend="modal"
      targets={targets}
      loadError={loadError}
      onNavigate={onNavigate}
      describe={(target) => target.environmentName + ' / ' + target.appName}
    />
  )
}
