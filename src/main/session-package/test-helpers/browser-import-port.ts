import { createServer } from 'node:net'

// Browser import only admits high ports; OS-assigned ephemeral ports can be below that range.
export async function findBrowserImportPort(): Promise<number> {
  const probe = createServer()
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject)
        probe.listen(49152 + Math.floor(Math.random() * 16384), '127.0.0.1', resolve)
      })
      probe.removeAllListeners('error')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }
  }
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}
