import { describe, expect, it } from 'vitest'
import { runVerificationProcess } from './verification-process'

describe('bounded verification subprocess', () => {
  it('cancels a running process and waits for its exit', async () => {
    const controller = new AbortController()
    const pending = runVerificationProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { signal: controller.signal }
    )
    setTimeout(() => controller.abort(new Error('explicit cancellation')), 30)
    await expect(pending).rejects.toThrow('explicit cancellation')
  })
  it('terminates descendants holding inherited pipes within its deadline', async () => {
    const started = Date.now()
    await expect(
      runVerificationProcess(
        process.execPath,
        [
          '-e',
          "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)"
        ],
        { timeoutMs: 100 }
      )
    ).rejects.toThrow('time limit')
    expect(Date.now() - started).toBeLessThan(3000)
  })
  it('ends hung commands without relying on installation age', async () => {
    await expect(
      runVerificationProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        timeoutMs: 30
      })
    ).rejects.toThrow('time limit')
  })
  it('refuses oversized output while keeping UI timers responsive', async () => {
    let ticked = false
    setTimeout(() => {
      ticked = true
    }, 5)
    await expect(
      runVerificationProcess(
        process.execPath,
        ['-e', "process.stdout.write('x'.repeat(10000)); setInterval(() => {}, 1000)"],
        { maxBytes: 100 }
      )
    ).rejects.toThrow('output exceeded')
    expect(ticked).toBe(true)
  })
})
