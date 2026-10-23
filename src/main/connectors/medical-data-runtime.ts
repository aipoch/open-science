import { condaActivatedPath, envPrefix, pythonBin, runtimeRoot } from '@aipoch/environment'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runtimeMetadataIfConfigured } from '../runtime-metadata'
import { resolveDataRoot } from '../storage-root'

// Resolve the same managed Python prefix as Notebook, including legacy Windows layouts.
// No executable name supplied by a tool argument is ever used.
export function medicalDataPython(): string {
  return (
    process.env.OPEN_SCIENCE_MEDICAL_PYTHON ||
    pythonBin(envPrefix(runtimeRoot(resolveDataRoot()), 'default-python'))
  )
}

export function medicalDataLaunchEnvironment(): Record<string, string> {
  if (process.env.OPEN_SCIENCE_MEDICAL_PYTHON) return {}
  const prefix = envPrefix(runtimeRoot(resolveDataRoot()), 'default-python')
  return { PATH: condaActivatedPath(prefix, process.env.PATH), CONDA_PREFIX: prefix }
}

export function resolveMedicalDataResources(): string | undefined {
  const resources = runtimeMetadataIfConfigured()?.resourcesPath
  const candidates = [
    resources && join(resources, 'app.asar.unpacked', 'resources', 'medical-data', 'bootstrap.py'),
    resources && join(resources, 'resources', 'medical-data', 'bootstrap.py'),
    resources && join(resources, 'medical-data', 'bootstrap.py'),
    join(__dirname, '../../resources/medical-data/bootstrap.py'),
    join(__dirname, '../../../resources/medical-data/bootstrap.py')
  ].filter((candidate): candidate is string => Boolean(candidate))
  return candidates.find((candidate) => existsSync(candidate))
}
