import { describe, expect, it } from 'vitest'
import { LOCAL_RESOURCE_BUDGETS } from '../resource-budget'
import { packageDiskReserveBytes } from './capacity'

const MIB = 1024 * 1024

describe('packageDiskReserveBytes', () => {
  it('keeps a 512 MiB floor for small materializations', () => {
    expect(packageDiskReserveBytes(0)).toBe(512 * MIB)
    expect(packageDiskReserveBytes(200 * MIB)).toBe(512 * MIB)
  })

  it('scales at 20 percent and caps at the existing 2 GiB limit', () => {
    expect(packageDiskReserveBytes(5 * 1024 * MIB)).toBe(1024 * MIB)
    expect(packageDiskReserveBytes(20 * 1024 * MIB)).toBe(LOCAL_RESOURCE_BUDGETS.diskReserveBytes)
  })
})
