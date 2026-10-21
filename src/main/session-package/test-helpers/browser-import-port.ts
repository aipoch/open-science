import { createServer } from 'node:net'

// Browser import only admits high ports; OS-assigned ephemeral ports can be below that range.
export async function findBrowserImportPort(): Promise<number> {
  const probe = createServer()
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject)
        probe.listen(49152 + Math.floor(Math.random() * 16384), '127.0.0.1', resolve)
      })
      probe.removeAllListeners('error')
      break
    } catch (error) {
      // Windows reserves parts of the dynamic range (for example for Hyper-V). A rejected
      // candidate is not evidence that loopback itself is unavailable. Bound retries so a
      // genuinely denied environment still fails with its original error.
      const code = (error as NodeJS.ErrnoException).code
      if (attempt === 31 || (code !== 'EADDRINUSE' && code !== 'EACCES')) throw error
    }
  }
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}
