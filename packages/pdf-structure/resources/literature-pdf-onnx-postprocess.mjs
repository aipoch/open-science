/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Conservative post-processing for the offline ONNX probe. The production
// extractor applies its own native-source admission gates; this helper only
// removes exact duplicate detector boxes before the probe renders crops.

const area = (rect) => Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1])

export const intersectionOverUnion = (a, b) => {
  const intersection =
    Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  const union = area(a) + area(b) - intersection
  return union > 0 ? intersection / union : 0
}

// Keep the highest-scoring box for near-identical table detections while
// retaining adjacent tables and non-table labels. A high threshold is
// deliberate: nearby or nested crops still need the later source-evidence
// gates to decide ownership.
export const deduplicateTableDetections = (objects, iouThreshold = 0.85) => {
  const ranked = objects
    .map((object, index) => ({ object, index }))
    .sort((a, b) => (b.object.score ?? 0) - (a.object.score ?? 0))
  const kept = []
  for (const candidate of ranked) {
    if (
      candidate.object.label === 'table' &&
      kept.some(
        (other) =>
          other.label === 'table' &&
          intersectionOverUnion(candidate.object.rect, other.rect) >= iouThreshold
      )
    )
      continue
    kept.push(candidate.object)
  }
  return kept.sort((a, b) => objects.indexOf(a) - objects.indexOf(b))
}
