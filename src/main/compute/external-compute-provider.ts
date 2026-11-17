import type {
  ExternalComputeMode,
  ExternalComputeTarget,
  HostedTarget,
  KubernetesTarget,
  ModalTarget,
  RayTarget
} from '../../shared/compute'

/** Target-catalog dispatch only. Submission and runtime lifecycle stays provider-owned for now. */
export type ExternalComputeTargetRepository = {
  listKubernetesTargets(): Promise<KubernetesTarget[]>
  getKubernetesTarget(providerId: string): Promise<KubernetesTarget | null>
  listHostedTargets(): Promise<HostedTarget[]>
  getHostedTarget(providerId: string): Promise<HostedTarget | null>
  listRayTargets(): Promise<RayTarget[]>
  getRayTarget(providerId: string): Promise<RayTarget | null>
  listModalTargets(): Promise<ModalTarget[]>
  getModalTarget(providerId: string): Promise<ModalTarget | null>
}

export type ExternalComputeProvider = Readonly<{
  mode: ExternalComputeMode
  listTargets(repository: ExternalComputeTargetRepository): Promise<ExternalComputeTarget[]>
  getTarget(
    repository: ExternalComputeTargetRepository,
    providerId: string
  ): Promise<ExternalComputeTarget | null>
}>

export const externalComputeProviders: readonly ExternalComputeProvider[] = [
  {
    mode: 'kubernetes',
    listTargets: (repository) => repository.listKubernetesTargets(),
    getTarget: (repository, providerId) => repository.getKubernetesTarget(providerId)
  },
  {
    mode: 'hugging_face_jobs',
    listTargets: (repository) => repository.listHostedTargets(),
    getTarget: (repository, providerId) => repository.getHostedTarget(providerId)
  },
  {
    mode: 'ray_jobs',
    listTargets: (repository) => repository.listRayTargets(),
    getTarget: (repository, providerId) => repository.getRayTarget(providerId)
  },
  {
    mode: 'modal_sandbox',
    listTargets: (repository) => repository.listModalTargets(),
    getTarget: (repository, providerId) => repository.getModalTarget(providerId)
  }
]

const providersByMode = new Map(
  externalComputeProviders.map((provider) => [provider.mode, provider])
)

export function externalComputeProvider(mode: ExternalComputeMode): ExternalComputeProvider {
  const provider = providersByMode.get(mode)
  if (!provider) throw new Error(`Unknown external compute mode: ${mode}`)
  return provider
}
