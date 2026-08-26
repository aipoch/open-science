// Compare in-flight request identity without awaiting the promise.

export const isCurrentInFlight = <T>(
  slot: Promise<T> | undefined,
  request: Promise<T>
): boolean => {
  // codeql[js/missing-await] -- ownership is the promise object, not its resolved value
  return slot === request
}
