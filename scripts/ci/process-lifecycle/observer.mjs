/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { release } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export const identityKey = (record) => `${record.pid}:${record.created}`
export const isSameProcess = (left, right) =>
  left.pid === right?.pid && left.created === right.created && !right.unknown

export function harnessDigest() {
  const hash = createHash('sha256')
  for (const name of [
    'process-table.py',
    'observer.mjs',
    'canary.mjs',
    'observer.node-test.mjs',
    'lifecycle.suite.ts',
    'vitest.config.ts',
    'run.mjs'
  ]) {
    hash.update(name).update(readFileSync(resolve('scripts/ci/process-lifecycle', name)))
  }
  return hash.digest('hex')
}

export async function processTable(request = { operation: 'snapshot' }) {
  const child = spawn(
    process.env.LIFECYCLE_PYTHON || 'python3',
    [resolve('scripts/ci/process-lifecycle/process-table.py')],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }
  )
  const chunks = []
  child.stdout.on('data', (chunk) => chunks.push(chunk))
  const timer = setTimeout(() => child.kill(), 10_000)
  try {
    const completed = new Promise((fulfill, reject) => {
      child.once('error', () => reject(new Error('process-snapshot-unavailable')))
      child.once('close', (code) =>
        code === 0 ? fulfill() : reject(new Error('process-snapshot-failed'))
      )
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(JSON.stringify(request))
    await completed
    const result = JSON.parse(Buffer.concat(chunks).toString())
    if (result.complete !== true || !Array.isArray(result.records))
      throw new Error('process-snapshot-incomplete')
    return result.records
  } finally {
    clearTimeout(timer)
  }
}

// No product process-tree helpers are used here. Readiness barriers in the fixtures ensure the
// initial tree is observed before it can exit/reparent, including descendants without registration.
export class LifecycleObserver {
  constructor(
    scenario,
    {
      readTable = processTable,
      output = process.env.LIFECYCLE_OUTPUT || 'test-results/process-lifecycle'
    } = {}
  ) {
    this.scenario = scenario
    this.readTable = readTable
    this.output = output
    this.seen = new Map()
    this.roots = new Map()
    this.checkpoints = []
    this.errors = []
    this.cleanupRequired = []
    this.id = randomUUID()
  }

  async start() {
    this.baseline = new Set((await this.readTable()).map(identityKey))
    return this
  }

  async observe(pid, ownership = 'owned', minimum = 1, { signal, timeoutMs = 5000 } = {}) {
    const deadline = Date.now() + timeoutMs
    let captured
    do {
      signal?.throwIfAborted()
      const table = await this.readTable()
      const root = table.find((item) => item.pid === pid)
      if (root) {
        if (
          root.unknown ||
          !Number.isFinite(root.created) ||
          this.baseline.has(identityKey(root)) ||
          (captured && !isSameProcess(captured, root))
        )
          throw new Error('process-identity-not-proven')
        captured = root
        this.roots.set(identityKey(root), { ...root, ownership })
        await this.sample(table)
        const count = [...this.seen.values()].filter(
          (item) => item.root === identityKey(root)
        ).length
        if (count >= minimum) return root
      }
      if (Date.now() >= deadline) break
      await sleep(50, undefined, { signal })
    } while (Date.now() <= deadline)
    throw new Error(captured ? 'process-tree-not-observed' : 'process-identity-not-proven')
  }

  async sample(table = undefined) {
    table ??= await this.readTable()
    if (!table.length) throw new Error('process-snapshot-empty')
    for (const [key, root] of this.roots) {
      const live = new Set(
        [...this.seen.values()]
          .filter((item) => item.root === key && table.some((now) => isSameProcess(item, now)))
          .map((item) => item.pid)
      )
      if (table.some((now) => isSameProcess(root, now))) live.add(root.pid)
      let changed = true
      while (changed) {
        changed = false
        for (const item of table) {
          // A baseline process can retain a parent PID later reused by this workload.
          if (this.baseline.has(identityKey(item))) continue
          if (live.has(item.pid) || live.has(item.parentPid)) {
            if (item.unknown || !Number.isFinite(item.created))
              throw new Error('process-identity-unreadable')
            if (!live.has(item.pid)) {
              live.add(item.pid)
              changed = true
            }
            this.seen.set(identityKey(item), { ...item, root: key, ownership: root.ownership })
          }
        }
      }
    }
    return table
  }

  async checkpoint(label, { surviving = [], timeoutMs = 5000 } = {}) {
    const deadline = Date.now() + timeoutMs
    let result
    try {
      if (!this.seen.size) throw new Error('scenario-not-observed')
      do {
        const table = await this.sample()
        const leaks = [],
          missing = [],
          unknown = []
        for (const item of this.seen.values()) {
          const now = table.find((entry) => entry.pid === item.pid)
          if (now?.unknown) {
            unknown.push(item)
            continue
          }
          const alive = isSameProcess(item, now) && now.status !== 'zombie'
          const mustSurvive = surviving.includes(item.root)
          if (mustSurvive && !alive) missing.push(item)
          if (!mustSurvive && alive) leaks.push(item)
        }
        result = { label, leaks, missing, unknown, at: new Date().toISOString() }
        if ((!leaks.length && !missing.length && !unknown.length) || Date.now() >= deadline) break
        await sleep(100)
      } while (Date.now() <= deadline)
      result.status =
        result.leaks.length || result.missing.length || result.unknown.length ? 'failed' : 'passed'
    } catch {
      result = { label, status: 'blocked', reason: 'process-evidence-unavailable' }
    }
    this.checkpoints.push(result)
    await this.save() // Persist the verdict BEFORE fixture or emergency cleanup.
    if (result.status !== 'passed')
      throw new Error(`lifecycle-checkpoint-${result.status}: ${label}`)
  }

  async save(extra = {}) {
    await mkdir(this.output, { recursive: true })
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    await writeFile(
      join(this.output, `${this.scenario}-${this.id}.json`),
      JSON.stringify(
        {
          schemaVersion: 1,
          scenario: this.scenario,
          runId: process.env.LIFECYCLE_RUN_ID,
          sourceSha: sha,
          harnessSha256: harnessDigest(),
          platform: process.platform,
          osRelease: release(),
          arch: process.arch,
          node: process.version,
          identities: [...this.seen.values()],
          checkpoints: this.checkpoints,
          errors: this.errors,
          cleanupRequired: this.cleanupRequired,
          ...extra
        },
        null,
        2
      )
    )
  }

  async finish(failed = false) {
    if (failed) this.errors.push('scenario-operation-failed')
    if (!this.checkpoints.length) this.errors.push('checkpoint-not-executed')
    await this.save()
    let cleanup
    try {
      // A failed snapshot must not bypass cleanup of identities already proven earlier.
      let beforeCleanup = []
      try {
        beforeCleanup = await this.sample()
      } catch {
        this.errors.push('cleanup-observation-failed')
      }
      this.cleanupRequired = [...this.seen.values()].filter((item) =>
        beforeCleanup.some((now) => isSameProcess(item, now) && now.status !== 'zombie')
      )
      if (this.cleanupRequired.length) this.errors.push('processes-survived-before-cleanup')
      await this.save()
      cleanup = await processTable({
        operation: 'cleanup',
        identities: [...this.seen.values()].reverse()
      })
      const deadline = Date.now() + 5000
      let remaining
      do {
        const table = await this.readTable()
        remaining = [...this.seen.values()].filter((item) =>
          table.some((now) => isSameProcess(item, now) && now.status !== 'zombie')
        )
        if (!remaining.length) break
        await sleep(100)
      } while (Date.now() < deadline)
      await this.save({ cleanup, cleanupRemaining: remaining })
      if (remaining.length) throw new Error('cleanup-unconfirmed')
    } catch {
      this.errors.push('cleanup-unconfirmed')
      await this.save({ cleanup })
      throw new Error('lifecycle-cleanup-unconfirmed')
    }
    if (this.errors.length) throw new Error('lifecycle-scenario-incomplete')
  }
}
