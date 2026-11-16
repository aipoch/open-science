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

// Account for repeated paths and pretty-print indentation before allocating the JSON string.
// Inputs are decoded JSON and generated scalar fields, so there are no omitted properties.
export function jsonBytesWithinLimit(value, maxBytes, pretty = false) {
  let size = 0
  function charge(n) {
    size += n
    if (size > maxBytes) throw new Error('Execution evidence exceeds the read limit.')
  }
  function visit(item, depth) {
    if (depth > 128) throw new Error('Invalid execution evidence nesting.')
    if (item === null || typeof item !== 'object') {
      charge(Buffer.byteLength(JSON.stringify(item)))
      return
    }
    const array = Array.isArray(item)
    charge(2)
    let count = 0
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue
      if (count++) charge(1)
      if (pretty) charge(1 + 2 * (depth + 1))
      if (!array) charge(Buffer.byteLength(JSON.stringify(key)) + (pretty ? 2 : 1))
      visit(item[key], depth + 1)
    }
    if (pretty && count) charge(1 + 2 * depth)
  }
  visit(value, 0)
  return size
}

export function expandProjection(packed, views, prefix, maxBytes) {
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
  if (maxBytes !== undefined) jsonBytesWithinLimit(sidecar, maxBytes - 1, true)
  return Buffer.from(JSON.stringify(sidecar, null, 2) + '\n')
}
