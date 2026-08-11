import type { AcpStateSnapshot } from '../../../../shared/acp'

let latestRevision: number | undefined

// Reserves Main snapshot order synchronously at every renderer ingress. Multiple consumers may
// observe the same revision, but no consumer may admit authority older than the shared watermark.
const acceptAcpRuntimeSnapshotRevision = (
  snapshot: Pick<AcpStateSnapshot, 'revision'>
): boolean => {
  const revision = snapshot.revision
  if (revision === undefined) return latestRevision === undefined
  if (latestRevision !== undefined && revision < latestRevision) return false
  latestRevision = revision
  return true
}

const resetAcpRuntimeSnapshotRevisionForTests = (): void => {
  latestRevision = undefined
}

export { acceptAcpRuntimeSnapshotRevision, resetAcpRuntimeSnapshotRevisionForTests }
