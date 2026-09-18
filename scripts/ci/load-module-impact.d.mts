export type ModuleImpactManifest = {
  schemaVersion: 1
  modules: Record<
    string,
    {
      ownerPaths: string[]
      interfacePaths: string[]
      testFiles: { owner: string[]; contract: string[]; consumer: string[] }
      consumerModules: string[]
      capabilityOverlays: string[]
      fallbackCapability: string
      fullTestReason?: string
    }
  >
}

export const moduleImpactRegistrationPath: string
export function isModuleImpactRegistrationPath(path: string): boolean
export function loadModuleImpactManifest(manifestPath?: string | URL): ModuleImpactManifest
export function loadModuleImpactManifestAtRevision(
  revision: string,
  options?: { cwd?: string }
): ModuleImpactManifest
