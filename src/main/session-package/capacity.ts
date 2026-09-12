import { assertDiskReserve } from '../bounded-file-io'
import { LOCAL_RESOURCE_BUDGETS } from '../resource-budget'
import { availableBytes } from '../storage/usage'

export class PackageCapacityError extends Error {
  constructor(
    readonly directory: string,
    readonly requiredBytes: number,
    readonly freeBytes: number,
    cause: unknown
  ) {
    super('Not enough disk space for the next Session package stage.', { cause })
  }
}

// Check only the caller's already-known upcoming bytes. This never inventories files and
// cannot reserve space against concurrent writers; bounded writes remain authoritative.
export async function packageCapacityChecker(
  directory: string
): Promise<(writeBytes: number) => void> {
  const freeBytes = await availableBytes(directory).catch(() => undefined)
  return (writeBytes) => {
    if (freeBytes === undefined || !Number.isFinite(freeBytes) || freeBytes < 0) return
    const reserve = LOCAL_RESOURCE_BUDGETS.diskReserveBytes
    try {
      assertDiskReserve(freeBytes, writeBytes, reserve)
    } catch (cause) {
      throw new PackageCapacityError(directory, writeBytes + reserve, freeBytes, cause)
    }
  }
}

export async function assertPackageCapacity(directory: string, writeBytes: number): Promise<void> {
  const check = await packageCapacityChecker(directory)
  check(writeBytes)
}
