import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  loadMacOrdinaryEntry,
  ordinaryMacBundle,
  ordinaryEntrySigningRequirement
} from './mac-ordinary-entry'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const setup = (): {
  runtime: string
  wrapper: string
  record: string
  association: Record<string, unknown>
} => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mac-ordinary-entry-')))
  roots.push(root)
  const wrapper = join(root, 'Applications/Open-Science.app')
  const runtimeRoot = join(root, 'runtimes')
  const runtime = join(
    runtimeRoot,
    createHash('sha256').update(wrapper).digest('hex'),
    'Open-Science.app'
  )
  const stateRoot = join(root, 'isolated-state')
  for (const path of [join(wrapper, 'Contents/Resources'), runtime, stateRoot])
    mkdirSync(path, { recursive: true })
  writeFileSync(
    join(wrapper, 'Contents/Resources/mac-recovery-entry.json'),
    JSON.stringify({ schema: 1, runtimeBundleIdentifier: 'com.aipoch.open-science' })
  )
  const association = {
    schema: 1,
    wrapperPath: wrapper,
    runtimePath: runtime,
    runtimeRoot,
    stateRoot
  }
  const record = join(dirname(runtime), 'ordinary-entry.json')
  writeFileSync(record, JSON.stringify(association))
  return { runtime, wrapper, record, association }
}

it('restores the verified ordinary entry and isolation root without inherited launch environment', () => {
  const f = setup()
  const verify = vi.fn()
  expect(ordinaryMacBundle(f.runtime)).toBe(f.runtime)
  expect(loadMacOrdinaryEntry(f.runtime, verify)).toEqual(f.association)
  expect(verify).toHaveBeenCalledWith(f.wrapper, f.runtime, expect.objectContaining({ schema: 1 }))
  expect(ordinaryMacBundle(f.runtime)).toBe(f.wrapper)
})

it('rejects an association redirected to another signed installation before trusting its state root', () => {
  const f = setup()
  const other = setup()
  const verify = vi.fn()
  writeFileSync(f.record, JSON.stringify({ ...f.association, wrapperPath: other.wrapper }))
  expect(() => loadMacOrdinaryEntry(f.runtime, verify)).toThrow(/does not belong/)
  expect(verify).not.toHaveBeenCalled()
  expect(ordinaryMacBundle(f.runtime)).toBe(f.runtime)
})

it('does not publish an ordinary entry whose publisher or sealed resources fail verification', () => {
  const f = setup()
  expect(() =>
    loadMacOrdinaryEntry(f.runtime, () => {
      throw new Error('signature invalid')
    })
  ).toThrow('signature invalid')
  expect(ordinaryMacBundle(f.runtime)).toBe(f.runtime)
})

it('rejects a symlink association and preserves legacy standalone runtime behavior', () => {
  const f = setup()
  const original = f.record + '.original'
  writeFileSync(original, JSON.stringify(f.association))
  rmSync(f.record)
  symlinkSync(original, f.record)
  expect(() => loadMacOrdinaryEntry(f.runtime, vi.fn())).toThrow(/regular file/)
  rmSync(f.record)
  expect(loadMacOrdinaryEntry(f.runtime, vi.fn())).toBeUndefined()
  expect(ordinaryMacBundle(f.runtime)).toBe(f.runtime)
})

it('never weakens an official publisher requirement to the ad-hoc development rule', () => {
  expect(
    ordinaryEntrySigningRequirement('TeamIdentifier=87G9WFU9H3', 'publisher', {
      runtimeRequirement: 'weak'
    })
  ).toContain('anchor apple generic')
  const adhoc = 'Signature=adhoc\nTeamIdentifier=not set'
  expect(
    ordinaryEntrySigningRequirement(adhoc, 'cdhash H"abc"', {
      runtimeRequirement: 'cdhash H"abc"',
      faultInjection: false
    })
  ).toBe('identifier "com.aipoch.open-science.launcher"')
  expect(() =>
    ordinaryEntrySigningRequirement(adhoc, 'new-cdhash', { runtimeRequirement: 'old-cdhash' })
  ).toThrow(/publisher/)
  expect(() =>
    ordinaryEntrySigningRequirement(adhoc, 'same', {
      runtimeRequirement: 'same',
      faultInjection: true
    })
  ).toThrow(/publisher/)
  expect(() => ordinaryEntrySigningRequirement('TeamIdentifier=OTHER', 'publisher', {})).toThrow(
    /publisher/
  )
})
