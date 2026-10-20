/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Use the same build-time input as release signing and certification. Unsigned development builds
// may omit it; their runtime verifier rejects signature-based acceptance and retains pinned hashes.
/** @param {Record<string, string | undefined>} environment */
export const windowsSigningBuildDefines = (environment) => ({
  __OPEN_SCIENCE_WINDOWS_SIGNING_PUBLISHER__: JSON.stringify(
    environment.AZURE_SIGNING_PUBLISHER?.trim() || null
  )
})
