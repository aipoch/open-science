/* eslint-disable @typescript-eslint/explicit-function-return-type -- shared with the plain Node worker; types are in the declaration file. */
// Shared by the native worker and the portable package reader. Field order is part of the
// native sidecar byte contract. View entries carry only a relative path, digest and size.
export function mapGenerations(sidecar, transform) {
  const result = { ...sidecar }
  result.relations = sidecar.relations.map((relation) =>
    relation.generation ? { ...relation, generation: transform(relation.generation) } : relation
  )
  if (sidecar.predecessorGenerations)
    result.predecessorGenerations = sidecar.predecessorGenerations.map(transform)
  return result
}

export function expandProjection(packed, views, prefix) {
  const sidecar = mapGenerations(packed, (reference) => {
    if (!Array.isArray(reference) || reference.length !== 4)
      throw new Error('Invalid execution evidence generation reference.')
    const [view, index, generationId, capturedAt] = reference
    if (
      (view !== 0 && view !== 1) ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      typeof generationId !== 'string' ||
      typeof capturedAt !== 'string'
    )
      throw new Error('Invalid execution evidence generation reference.')
    const [relativePath, checksum, sizeBytes] = views[view][index]
    return {
      generationId,
      relativePath,
      checksum,
      sizeBytes,
      contentStorageKey: prefix + '/blobs/sha256-' + checksum,
      capturedAt
    }
  })
  return Buffer.from(JSON.stringify(sidecar, null, 2) + '\n')
}
