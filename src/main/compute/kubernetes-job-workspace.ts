import type { PrismaClient } from '@prisma/client'
import { createKubernetesBackendAdapter, type KubernetesWorkspace } from '@aipoch/compute/node'
import { z } from 'zod'
import type { OptionalSecureStorageStringProtection } from './credential-vault'

import type { KubernetesJobTarget, resolveKubernetesJobTarget } from './kubernetes-kubeconfig'

export type WorkspaceOwner = Readonly<{
  jobId: string
  projectId: string
  sessionId: string
  providerId: string
}>
const bindingSchema = z.strictObject({
  version: z.literal(1),
  context: z.string().min(1),
  endpoint: z.string(),
  namespace: z.string().min(1),
  image: z.string().min(1),
  transferImage: z.string().min(1).optional(),
  launchToken: z.string().uuid().optional(),
  sizeMiB: z.number().int().positive(),
  receipt: z
    .strictObject({
      jobId: z.string(),
      providerId: z.string(),
      namespace: z.string(),
      name: z.string().min(1),
      uid: z.string().min(1)
    })
    .optional()
})

export function authorizedWorkspaceBinding(
  options: Pick<KubernetesJobTarget, 'context' | 'endpoint' | 'namespace' | 'image'> & {
    transferImage?: string
  },
  sizeMiB: number
): z.infer<typeof bindingSchema> {
  const url = new URL(options.endpoint)
  if (url.username || url.password || url.search || url.hash || url.protocol !== 'https:') {
    throw new Error('Kubernetes endpoint must identify a cluster without embedded credentials.')
  }
  return bindingSchema.parse({
    version: 1,
    context: options.context,
    endpoint: url.href.replace(/\/$/, ''),
    namespace: options.namespace.trim(),
    image: options.image.trim(),
    transferImage: options.transferImage?.trim(),
    sizeMiB
  })
}

type WorkspaceBinding = z.infer<typeof bindingSchema>
type Protection = Pick<OptionalSecureStorageStringProtection, 'revealJson' | 'protectJson'>

export function readWorkspaceBinding(
  row: { kubernetesWorkspace: string | null; sensitiveDataEncrypted: boolean | null },
  protection: Protection,
  owner: WorkspaceOwner
): WorkspaceBinding {
  if (row.kubernetesWorkspace === null || row.sensitiveDataEncrypted === null)
    throw new Error('Kubernetes workspace has no pending reservation.')
  const binding = bindingSchema.parse(
    JSON.parse(
      row.sensitiveDataEncrypted
        ? protection.revealJson(row.kubernetesWorkspace, 'object')
        : row.kubernetesWorkspace
    )
  )
  const receipt = binding.receipt
  if (
    receipt &&
    (receipt.jobId !== owner.jobId ||
      receipt.providerId !== owner.providerId ||
      receipt.namespace !== binding.namespace)
  )
    throw new Error('Kubernetes workspace receipt belongs to another job or target.')
  return binding
}

export async function resolveWorkspaceTarget(
  binding: WorkspaceBinding,
  resolveTarget: typeof resolveKubernetesJobTarget,
  signal?: AbortSignal
): Promise<KubernetesJobTarget> {
  const target = await resolveTarget(binding.context, binding.namespace, binding.image, signal)
  if (
    target.context !== binding.context ||
    target.namespace !== binding.namespace ||
    target.endpoint !== binding.endpoint ||
    target.image !== binding.image
  )
    throw new Error('Kubernetes workspace target changed after approval.')
  return target
}

// The caller has approved and persisted the submission. The cluster call may outlive this process.
export async function prepareKubernetesJobWorkspace(
  client: Pick<PrismaClient, 'computeJob'>,
  protection: Protection,
  owner: WorkspaceOwner,
  resolveTarget: typeof resolveKubernetesJobTarget,
  signal?: AbortSignal
): Promise<KubernetesWorkspace> {
  const where = {
    id: owner.jobId,
    sessionId: owner.sessionId,
    projectId: owner.projectId,
    providerId: owner.providerId,
    executionMode: 'kubernetes'
  }
  for (;;) {
    signal?.throwIfAborted()
    const row = await client.computeJob.findFirst({
      where,
      select: { kubernetesWorkspace: true, sensitiveDataEncrypted: true, status: true }
    })
    if (!row) throw new Error('Kubernetes Job binding is unavailable.')
    const binding = readWorkspaceBinding(row, protection, owner)
    if (binding.receipt) return binding.receipt
    if (row.status !== 'submitted')
      throw new Error('Kubernetes Job cannot provision a workspace in its current state.')
    const target = await resolveWorkspaceTarget(binding, resolveTarget, signal)
    const receipt = await createKubernetesBackendAdapter(target).prepareWorkspace(
      owner.jobId,
      { backendId: 'kubernetes', providerId: owner.providerId },
      binding.sizeMiB,
      signal
    )
    const updated = JSON.stringify({ ...binding, receipt })
    const stored = await client.computeJob.updateMany({
      where: {
        ...where,
        kubernetesWorkspace: row.kubernetesWorkspace,
        sensitiveDataEncrypted: row.sensitiveDataEncrypted
      },
      data: {
        kubernetesWorkspace: row.sensitiveDataEncrypted
          ? protection.protectJson(updated, 'object')
          : updated
      }
    })
    if (stored.count === 1) return receipt
  }
}
