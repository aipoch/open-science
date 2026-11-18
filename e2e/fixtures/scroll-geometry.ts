import { expect } from '@playwright/test'

export const waitForStableOffset = async (
  readOffset: () => Promise<number | null>,
  waitFrame: () => Promise<void>,
  expected: number
): Promise<void> => {
  await expect
    .poll(async () => {
      const samples: number[] = []
      for (let frame = 0; frame < 4; frame += 1) {
        await waitFrame()
        const value = await readOffset()
        if (value !== null) samples.push(value)
      }
      return samples.length === 4 && samples.every((value) => Math.abs(value - expected) < 0.5)
    })
    .toBe(true)
}
