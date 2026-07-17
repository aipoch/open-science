// Applies an untrusted viewer-specific cap without allowing it to relax the repository hard limit.
const resolveManagedFileByteLimit = (
  requestedLimit: number | undefined,
  hardLimit: number
): number => {
  if (requestedLimit === undefined) return hardLimit

  if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
    throw new Error('Invalid managed file byte limit.')
  }

  return Math.min(requestedLimit, hardLimit)
}

export { resolveManagedFileByteLimit }
