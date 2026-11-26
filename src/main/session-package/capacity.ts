import { assertDiskReserve } from '../bounded-file-io'
import { LOCAL_RESOURCE_BUDGETS } from '../resource-budget'
import { availableBytes } from '../storage/usage'

const MIB = 1024 * 1024
const PACKAGE_MIN_DISK_RESERVE_BYTES = 512 * MIB
const PACKAGE_RESERVE_RATIO_DENOMINATOR = 5

export const packageDiskReserveBytes = (writeBytes: number): number =>
  Math.min(
    LOCAL_RESOURCE_BUDGETS.diskReserveBytes,
    Math.max(
      PACKAGE_MIN_DISK_RESERVE_BYTES,
      Math.ceil(writeBytes / PACKAGE_RESERVE_RATIO_DENOMINATOR)
    )
  )

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
  directory: string,
  reservePolicy: number | ((writeBytes: number) => number) = LOCAL_RESOURCE_BUDGETS.diskReserveBytes
): Promise<(writeBytes: number) => void> {
  const freeBytes = await availableBytes(directory).catch(() => undefined)
  return (writeBytes) => {
    if (freeBytes === undefined || !Number.isFinite(freeBytes) || freeBytes < 0) return
    const reserve = typeof reservePolicy === 'function' ? reservePolicy(writeBytes) : reservePolicy
    try {
      assertDiskReserve(freeBytes, writeBytes, reserve)
    } catch (cause) {
      throw new PackageCapacityError(directory, writeBytes + reserve, freeBytes, cause)
    }
  }
}

export async function assertPackageCapacity(
  directory: string,
  writeBytes: number,
  reservePolicy?: number | ((writeBytes: number) => number)
): Promise<void> {
  const check = await packageCapacityChecker(directory, reservePolicy)
  check(writeBytes)
}
