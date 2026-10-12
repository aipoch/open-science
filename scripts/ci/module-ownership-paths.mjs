/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Package-root build metadata needs no module owner. Runtime resources remain owned explicitly.
export function isModuleOwnershipPath(path) {
  return (
    /^(src|packages)\//.test(path) &&
    !/^packages\/[^/]+\/(?:tsconfig(?:\.[^/]+)?|package(?:-lock)?)\.json$/.test(path)
  )
}

// Only source and deliberately shipped runtime resources establish a module owner. Test data
// and scripts may remain in a module record as evidence, but they are routed through fixture
// suites or explicit testFiles instead of becoming implementation owners.
export function isModuleRoutableOwnerPath(path) {
  return isModuleOwnershipPath(path) || /^(?:resources|build|patches)\//.test(path)
}
