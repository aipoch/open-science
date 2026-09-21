import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { unzipSync, zipSync, type Zippable } from 'fflate'
import { discoverSkillArchive, zipSettingsFiles } from './archive-tasks'

it('keeps Main timers responsive during real archive compression and preserves deterministic bytes', async () => {
  const content = randomBytes(4 * 1024 * 1024)
  const files: Zippable = { 'large.bin': [content, { mtime: new Date(1980, 0, 1) }] }
  let ticks = 0
  const timer = setInterval(() => ticks++, 1)
  let archive: Uint8Array
  try {
    archive = await zipSettingsFiles(files)
  } finally {
    clearInterval(timer)
  }
  expect(ticks).toBeGreaterThan(0)
  expect(Buffer.from(archive).equals(Buffer.from(zipSync(files, { level: 6 })))).toBe(true)
  expect(Buffer.from(unzipSync(archive)['large.bin']).equals(content)).toBe(true)
  expect(content.byteLength).toBe(4 * 1024 * 1024)
})

it('recovers the task queue after invalid input and returns Buffer content without detaching the candidate', async () => {
  await expect(discoverSkillArchive(Buffer.from('invalid zip'))).rejects.toThrow()
  const input = Buffer.from(
    zipSync({ 'SKILL.md': Buffer.from('---\nname: safe\ndescription: test\n---\nbody') })
  )
  const before = Buffer.from(input)
  const result = await discoverSkillArchive(input)
  expect(input).toEqual(before)
  expect(result.roots).toHaveLength(1)
  expect(Buffer.isBuffer(result.roots[0].files[0].content)).toBe(true)
  expect(result.roots[0].files[0].content.toString()).toContain('name: safe')
})
