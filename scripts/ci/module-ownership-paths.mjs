/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Include code, runtime assets and fixtures; a new extension must not bypass ownership.
export function isModuleOwnershipPath(path) {
  return /^(src|packages)\//.test(path)
}
