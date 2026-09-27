import { copyFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ElectronApplication } from 'playwright'

type ElectronContentTraceOptions = {
  heapProfile?: boolean
}

type ElectronContentTraceConfig = {
  included_categories: string[]
  excluded_categories?: string[]
  memory_dump_config?: {
    triggers: Array<{ mode: 'detailed'; periodic_interval_ms: number }>
  }
}

type ElectronContentTraceArtifact = {
  heapProfile: boolean
  path: string
}

const buildElectronContentTraceConfig = (heapProfile: boolean): ElectronContentTraceConfig =>
  heapProfile
    ? {
        included_categories: ['disabled-by-default-memory-infra'],
        excluded_categories: ['*'],
        memory_dump_config: {
          triggers: [{ mode: 'detailed', periodic_interval_ms: 1_000 }]
        }
      }
    : { included_categories: ['*'] }

const startElectronContentTrace = async (
  application: ElectronApplication,
  { heapProfile = false }: ElectronContentTraceOptions = {}
): Promise<void> => {
  await application.evaluate(
    async ({ contentTracing }, { enableHeapProfile, config }) => {
      if (enableHeapProfile) await contentTracing.enableHeapProfiling()
      await contentTracing.startRecording(config)
    },
    { enableHeapProfile: heapProfile, config: buildElectronContentTraceConfig(heapProfile) }
  )
}

const stopElectronContentTrace = async (
  application: ElectronApplication,
  destination: string,
  { heapProfile = false }: ElectronContentTraceOptions = {}
): Promise<ElectronContentTraceArtifact> => {
  const source = await application.evaluate(({ contentTracing }) => contentTracing.stopRecording())
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
  return { heapProfile, path: destination }
}

export { buildElectronContentTraceConfig, startElectronContentTrace, stopElectronContentTrace }
export type {
  ElectronContentTraceArtifact,
  ElectronContentTraceConfig,
  ElectronContentTraceOptions
}
