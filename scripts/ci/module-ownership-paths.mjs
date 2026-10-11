/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Package-root build metadata needs no module owner. Runtime JSON and fixtures still do.
export function isModuleOwnershipPath(path) {
  return (
    /^(src|packages)\//.test(path) &&
    !/^packages\/[^/]+\/(?:tsconfig(?:\.[^/]+)?|package(?:-lock)?)\.json$/.test(path)
  )
}
