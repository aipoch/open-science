import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { KubernetesBackendError, type KubernetesRequest } from './kubernetes-api'
import type {
  ComputeBackendAdapter,
  ComputeBackendSubmissionRequest,
  ComputeBackendHandle,
  ComputeBackendTarget
} from './backend'
/** Host journal receipt. Keep it until the archived outputs are durably published. */
export type KubernetesWorkspace = Readonly<{
  namespace: string
  jobId: string
  providerId: string
  name: string
  uid: string
}>

export interface KubernetesBackendAdapter extends ComputeBackendAdapter {
  prepareWorkspace(
    jobId: string,
    target: ComputeBackendTarget,
    sizeMiB: number,
    signal?: AbortSignal
  ): Promise<KubernetesWorkspace>
  submitInWorkspace(
    submission: ComputeBackendSubmissionRequest,
    workspace: KubernetesWorkspace,
    signal?: AbortSignal,
    launchToken?: string
  ): Promise<ComputeBackendHandle>
  recoverWorkspaceLaunch(
    workspace: KubernetesWorkspace,
    launchToken: string,
    signal?: AbortSignal
  ): Promise<ComputeBackendHandle | null>
  /** The host transfers frozen inputs or publishes outputs via this short-lived Pod. */
  withWorkspaceFiles<T>(
    workspace: KubernetesWorkspace,
    mode: 'upload' | 'archive',
    image: string,
    transfer: (pod: string) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T>
  /** Called by the host after durable publication or explicit abandonment. Safe to retry. */
  releaseWorkspace(
    workspace: KubernetesWorkspace,
    signal?: AbortSignal
  ): Promise<'requested' | 'confirmed'>
}

const workspaceName = (jobId: string, providerId: string): string =>
  'compute-files-' +
  createHash('sha256')
    .update(JSON.stringify([providerId, jobId]))
    .digest('hex')
    .slice(0, 48)

export const createKubernetesWorkspaces = (
  namespace: string,
  request: KubernetesRequest
): Pick<
  KubernetesBackendAdapter,
  'prepareWorkspace' | 'releaseWorkspace' | 'withWorkspaceFiles'
> & { verifyCurrentClaim(workspace: KubernetesWorkspace, signal?: AbortSignal): Promise<void> } => {
  const claimPath = (name?: string): string =>
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/persistentvolumeclaims${name ? '/' + encodeURIComponent(name) : ''}`
  const verifyWorkspace = (workspace: KubernetesWorkspace): void => {
    if (
      workspace.namespace !== namespace ||
      workspace.name !== workspaceName(workspace.jobId, workspace.providerId) ||
      typeof workspace.uid !== 'string' ||
      !workspace.uid.trim()
    )
      throw new Error('Invalid Kubernetes workspace receipt.')
  }
  const prepareWorkspace: KubernetesBackendAdapter['prepareWorkspace'] = async (
    jobId,
    target,
    sizeMiB,
    signal
  ) => {
    if (
      target.backendId !== 'kubernetes' ||
      !target.providerId ||
      !jobId ||
      !Number.isSafeInteger(sizeMiB) ||
      sizeMiB < 1
    )
      throw new Error('Invalid Kubernetes workspace request.')
    const name = workspaceName(jobId, target.providerId)
    // A retry after a lost POST response may recover only this exact reservation.
    const reservation = JSON.stringify([target.providerId, jobId, sizeMiB])
    const annotation = 'open-science.io/workspace-reservation'
    let response: Response
    try {
      response = await request(claimPath(), {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiVersion: 'v1',
          kind: 'PersistentVolumeClaim',
          metadata: { name, annotations: { [annotation]: reservation } },
          spec: {
            accessModes: ['ReadWriteOnce'],
            resources: { requests: { storage: `${sizeMiB}Mi` } }
          }
        })
      })
    } catch (error) {
      if (!(error instanceof KubernetesBackendError && error.status === 409)) throw error
      response = await request(claimPath(name), { signal })
    }
    const claim = await response.json()
    if (
      claim.metadata?.name !== name ||
      claim.metadata.namespace !== namespace ||
      claim.metadata.annotations?.[annotation] !== reservation ||
      claim.metadata.deletionTimestamp
    )
      throw new Error('Kubernetes workspace conflicts with the requested reservation.')
    const receipt = {
      name,
      jobId,
      namespace,
      providerId: target.providerId,
      uid: claim.metadata?.uid
    }
    verifyWorkspace(receipt)
    return receipt
  }
  const releaseWorkspace: KubernetesBackendAdapter['releaseWorkspace'] = async (
    workspace,
    signal
  ) => {
    verifyWorkspace(workspace)
    try {
      await request(claimPath(workspace.name), {
        method: 'DELETE',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiVersion: 'v1',
          kind: 'DeleteOptions',
          preconditions: { uid: workspace.uid }
        })
      })
      return 'requested'
    } catch (error) {
      if (!(error instanceof KubernetesBackendError && error.status === 404)) throw error
      return 'confirmed'
    }
  }
  const verifyCurrentClaim = async (
    workspace: KubernetesWorkspace,
    signal?: AbortSignal
  ): Promise<void> => {
    verifyWorkspace(workspace)
    const response = await request(claimPath(workspace.name), { signal })
    const claim = await response.json()
    if (claim.metadata?.uid !== workspace.uid || claim.metadata.deletionTimestamp)
      throw new Error('Kubernetes workspace is unavailable or has been replaced.')
  }
  const withWorkspaceFiles: KubernetesBackendAdapter['withWorkspaceFiles'] = async (
    workspace,
    mode,
    image,
    transfer,
    signal
  ) => {
    if ((mode !== 'upload' && mode !== 'archive') || !image?.trim())
      throw new Error('A supported transfer mode and a trusted transfer image are required.')
    await verifyCurrentClaim(workspace, signal)
    const pods = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`
    const response = await request(pods, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
          generateName: 'compute-transfer-',
          ownerReferences: [
            {
              apiVersion: 'v1',
              kind: 'PersistentVolumeClaim',
              name: workspace.name,
              uid: workspace.uid
            }
          ]
        },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          activeDeadlineSeconds: 3600,
          volumes: [
            {
              name: 'files',
              persistentVolumeClaim: { claimName: workspace.name, readOnly: mode === 'archive' }
            }
          ],
          containers: [
            {
              name: 'transfer',
              image,
              command: ['sleep', '3600'],
              securityContext: {
                readOnlyRootFilesystem: true,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ['ALL'] }
              },
              volumeMounts: [
                { name: 'files', mountPath: '/workspace', readOnly: mode === 'archive' }
              ]
            }
          ]
        }
      })
    })
    const pod = await response.json()
    const { name, uid } = pod.metadata ?? {}
    if (typeof name !== 'string' || !name || typeof uid !== 'string' || !uid)
      throw new Error('Invalid Kubernetes transfer Pod identity.')
    const path = pods + '/' + encodeURIComponent(name)
    const removePod = async (): Promise<void> => {
      try {
        await request(path, {
          method: 'DELETE',
          signal: AbortSignal.timeout(30_000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiVersion: 'v1',
            kind: 'DeleteOptions',
            preconditions: { uid },
            gracePeriodSeconds: 0
          })
        })
      } catch (error) {
        if (!(error instanceof KubernetesBackendError && error.status === 404)) throw error
      }
    }
    try {
      const wait = AbortSignal.timeout(120_000)
      const readySignal = signal ? AbortSignal.any([signal, wait]) : wait
      for (;;) {
        const status = await (await request(path, { signal: readySignal })).json()
        if (
          status.metadata?.uid !== uid ||
          status.metadata.deletionTimestamp ||
          ['Failed', 'Succeeded'].includes(status.status?.phase)
        )
          throw new Error('Kubernetes transfer Pod is unavailable.')
        if (
          status.status?.conditions?.some(
            (c: { type?: string; status?: string }) => c.type === 'Ready' && c.status === 'True'
          )
        )
          break
        await delay(500, undefined, { signal: readySignal })
      }
      signal?.throwIfAborted()
      return await transfer(name)
    } finally {
      await removePod()
    }
  }
  return { prepareWorkspace, releaseWorkspace, verifyCurrentClaim, withWorkspaceFiles }
}
