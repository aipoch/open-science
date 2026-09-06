type ComputeOutputEvidenceExpectation = Readonly<{
  activityId: string
  producerRunId: string
  evidenceId: string
  relativePath: string
  checksum: string
  sizeBytes: number
}>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const computeEvidenceOwnsSource = (
  evidence: unknown,
  expected: ComputeOutputEvidenceExpectation
): boolean => {
  if (
    !isRecord(evidence) ||
    evidence.schemaVersion !== 1 ||
    evidence.activityId !== expected.activityId ||
    evidence.activityKind !== 'compute-job' ||
    evidence.parentActivityId !== expected.producerRunId ||
    evidence.evidenceId !== expected.evidenceId ||
    !Array.isArray(evidence.relations)
  ) {
    return false
  }
  return evidence.relations.some((candidate) => {
    if (!isRecord(candidate) || !isRecord(candidate.generation)) return false
    return (
      candidate.relation === 'harvested-output' &&
      candidate.pathPortability === 'relative' &&
      candidate.authority === 'explicit-transfer' &&
      candidate.relativePath === expected.relativePath &&
      candidate.generation.relativePath === expected.relativePath &&
      candidate.generation.checksum === expected.checksum &&
      candidate.generation.sizeBytes === expected.sizeBytes
    )
  })
}

export { computeEvidenceOwnsSource }
