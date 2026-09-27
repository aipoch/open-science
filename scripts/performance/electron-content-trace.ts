import { copyFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ElectronApplication } from 'playwright'

type ElectronContentTraceOptions = {
  heapProfile?: boolean
}

type ElectronContentTraceArtifact = {
  heapProfile: boolean
  path: string
}

const startElectronContentTrace = async (
  application: ElectronApplication,
  { heapProfile = false }: ElectronContentTraceOptions = {}
): Promise<void> => {
  await application.evaluate(async ({ contentTracing }, enableHeapProfile) => {
    if (enableHeapProfile) await contentTracing.enableHeapProfiling()
    await contentTracing.startRecording(
      enableHeapProfile
        ? {
            included_categories: ['disabled-by-default-memory-infra'],
            excluded_categories: ['*']
          }
        : { included_categories: ['*'] }
    )
  }, heapProfile)
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

export { startElectronContentTrace, stopElectronContentTrace }
export type { ElectronContentTraceArtifact, ElectronContentTraceOptions }
