import ts from 'typescript'
import { expect } from 'vitest'
import type { ModuleImpactManifest } from '../scripts/ci/load-module-impact.mjs'

type Module = ModuleImpactManifest['modules'][string]

export function expectBoundaryPaths(
  manifest: ModuleImpactManifest,
  id: string,
  paths: readonly string[]
): void {
  const original = manifest.modules[id]
  expect(original, `missing original module ${id}`).toBeDefined()
  for (const path of paths) {
    const owners = Object.entries(manifest.modules).filter(([, module]) =>
      module.ownerPaths.includes(path)
    )
    expect(
      owners.map(([owner]) => owner),
      `unique owner of ${path}`
    ).toHaveLength(1)
    const [ownerId, owner] = owners[0]
    if (ownerId === id) continue
    expect(owner.fallbackCapability, path).toBe(original.fallbackCapability)
    expect(owner.capabilityOverlays, path).toEqual(
      expect.arrayContaining(original.capabilityOverlays)
    )
    expect(owner.consumerModules, path).toEqual(
      expect.arrayContaining(original.consumerModules.filter((consumer) => consumer !== ownerId))
    )
    expect(owner.testFiles.contract, path).toEqual(
      expect.arrayContaining(original.testFiles.contract)
    )
    if (original.interfacePaths.includes(path)) expect(owner.interfacePaths, path).toContain(path)
    if (original.fullTestReason) expect(owner.fullTestReason, path).toBe(original.fullTestReason)
  }
}

export function expectBoundaryOwnerTests(
  manifest: ModuleImpactManifest,
  id: string,
  tests: readonly string[]
): void {
  for (const test of tests) {
    if (manifest.modules[id].testFiles.owner.includes(test)) continue
    const owners = Object.values(manifest.modules).filter((module) =>
      module.ownerPaths.includes(test)
    )
    expect(owners, `unique moved test owner of ${test}`).toHaveLength(1)
    expect(owners[0].testFiles.owner, test).toContain(test)
  }
}

export function expectModuleBoundary(
  manifest: ModuleImpactManifest,
  id: string,
  expected: Module
): void {
  const current = manifest.modules[id]
  expectBoundaryPaths(manifest, id, expected.ownerPaths)
  expectBoundaryOwnerTests(manifest, id, expected.testFiles.owner)
  expect(current.interfacePaths).toEqual(expect.arrayContaining(expected.interfacePaths))
  expect(current.testFiles.contract).toEqual(expect.arrayContaining(expected.testFiles.contract))
  expect(current.testFiles.consumer).toEqual(expect.arrayContaining(expected.testFiles.consumer))
  expect(current.consumerModules).toEqual(expect.arrayContaining(expected.consumerModules))
  expect(current.capabilityOverlays).toEqual(expect.arrayContaining(expected.capabilityOverlays))
  expect(current.fallbackCapability).toBe(expected.fallbackCapability)
  expect(current.fullTestReason).toBe(expected.fullTestReason)
}

// Type contracts do not compose services or acquire mutable runtime owners.
export function runtimeModuleSpecifiers(source: string): string[] {
  const ast = ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true)
  const specs: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause
      if (
        !clause ||
        (!clause.isTypeOnly &&
          (clause.name ||
            !clause.namedBindings ||
            ts.isNamespaceImport(clause.namedBindings) ||
            clause.namedBindings.elements.some((item) => !item.isTypeOnly)))
      )
        specs.push(node.moduleSpecifier.text)
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      !node.isTypeOnly &&
      (!node.exportClause ||
        !ts.isNamedExports(node.exportClause) ||
        node.exportClause.elements.some((item) => !item.isTypeOnly))
    )
      specs.push(node.moduleSpecifier.text)
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const argument = node.arguments[0]
      if (argument && ts.isStringLiteralLike(argument)) specs.push(argument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return specs
}

export function expectTypeOnlyContract(path: string, source: string): void {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  for (const node of ast.statements) {
    const typeImport =
      ts.isImportDeclaration(node) &&
      node.importClause &&
      (node.importClause.isTypeOnly ||
        (!node.importClause.name &&
          node.importClause.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings) &&
          node.importClause.namedBindings.elements.length > 0 &&
          node.importClause.namedBindings.elements.every((item) => item.isTypeOnly)))
    const typeExport =
      ts.isExportDeclaration(node) &&
      (node.isTypeOnly ||
        (node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((item) => item.isTypeOnly)))
    expect(
      Boolean(
        typeImport ||
        typeExport ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node)
      ),
      `${path}: ${node.getText(ast)}`
    ).toBe(true)
  }
}
