import type { OpenArtifactInBrowserRequest } from '../../shared/artifacts'
import { desktopShellInteraction } from '../desktop-interaction'
import { resolveConfigRoot } from '../storage-root'
import { buildAuthenticatedArtifactContentUrl } from '../web-service/artifact-url'
import { readWebServiceState } from '../web-service/state-file'

export type ArtifactBrowserOpenerDependencies = {
  resolveConfigRoot: () => string
  readWebServiceState: (configRoot: string) => Promise<{ port: number } | undefined>
  buildUrl: (
    configRoot: string,
    port: number,
    request: OpenArtifactInBrowserRequest
  ) => Promise<string>
  openExternal: (url: string) => Promise<void>
}

export const createArtifactBrowserOpener = (
  dependencies: Partial<ArtifactBrowserOpenerDependencies> = {}
): ((request: OpenArtifactInBrowserRequest) => Promise<void>) => {
  const resolveRoot = dependencies.resolveConfigRoot ?? resolveConfigRoot
  const readState = dependencies.readWebServiceState ?? readWebServiceState
  const buildUrl = dependencies.buildUrl ?? buildAuthenticatedArtifactContentUrl
  const openExternal =
    dependencies.openExternal ?? ((url: string) => desktopShellInteraction().openExternal(url))

  return async (request) => {
    const configRoot = resolveRoot()
    const state = await readState(configRoot)
    if (!state) throw new Error('The local Web service is not running.')
    await openExternal(await buildUrl(configRoot, state.port, request))
  }
}
