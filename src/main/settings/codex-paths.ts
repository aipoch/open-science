import { join } from 'node:path'

const codexStorageDir = (storageRoot: string): string => join(storageRoot, 'codex')
const codexSubscriptionStorageDir = (storageRoot: string): string =>
  join(storageRoot, 'codex-subscription')

export { codexStorageDir, codexSubscriptionStorageDir }
