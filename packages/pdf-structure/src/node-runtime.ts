import { spawn } from 'node:child_process'
import type { PdfStructureProcessRuntime } from './types.js'

// The supervisor creates Worker threads, never descendant processes. Hosts with a process-tree
// owner can inject it; the default adapter keeps the single child attached on every platform.
export const nodeProcessRuntime: PdfStructureProcessRuntime = {
  spawn(entry) {
    const env = { ...process.env }
    delete env.NODE_OPTIONS
    return spawn(process.execPath, [entry], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
  },
  async stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve, reject) => {
      const closed = (): void => {
        clearTimeout(deadline)
        resolve()
      }
      const deadline = setTimeout(() => {
        child.removeListener('close', closed)
        reject(new Error('PDF worker termination is unconfirmed.'))
      }, 5_000)
      child.once('close', closed)
      if (!child.kill('SIGKILL')) {
        clearTimeout(deadline)
        child.removeListener('close', closed)
        reject(new Error('PDF worker termination is unconfirmed.'))
      }
    })
  }
}
