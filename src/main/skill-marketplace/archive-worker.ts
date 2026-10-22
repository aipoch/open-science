import { parentPort, workerData } from 'node:worker_threads'
import { verifyMarketplacePackage } from './package'
const args = workerData as Parameters<typeof verifyMarketplacePackage>
try {
  const result = verifyMarketplacePackage(Buffer.from(args[0]), args[1], args[2], args[3])
  parentPort!.postMessage({ ok: true, result })
} catch (error) {
  parentPort!.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  })
}
