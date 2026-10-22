/// <reference types="electron-vite/node" />
import createWorker from './archive-worker?nodeWorker'
import { runArchiveTask } from '../archive-tasks/worker-runner'
import type { verifyMarketplacePackage } from './package'

export const verifyMarketplaceArchive = async (
  ...args: Parameters<typeof verifyMarketplacePackage>
): Promise<ReturnType<typeof verifyMarketplacePackage>> => {
  const files = await runArchiveTask<ReturnType<typeof verifyMarketplacePackage>>(
    createWorker,
    args
  )
  return files.map((file) => ({ ...file, content: Buffer.from(file.content) }))
}
