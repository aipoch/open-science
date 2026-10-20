import { basename, dirname, extname, relative, resolve } from 'node:path'

import {
  canHaveModifiers,
  createSourceFile,
  forEachChild,
  getModifiers,
  isCallExpression,
  isClassDeclaration,
  isExportDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportTypeNode,
  isInterfaceDeclaration,
  isLiteralTypeNode,
  isMethodDeclaration,
  isNamedExports,
  isStringLiteralLike,
  isTypeAliasDeclaration,
  isVariableStatement,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type Node,
  type SourceFile
} from 'typescript'
import { describe, expect, it } from 'vitest'

import { loadModuleImpactManifest } from '../../../scripts/ci/load-module-impact.mjs'

import {
  listProductionSources,
  readProductionSource
} from '../../../test/architecture-source-index'

const projectRoot = resolve(__dirname, '../../..')
const skillsRoot = resolve(projectRoot, 'packages/skills/src')
const repositoryPath = resolve(skillsRoot, 'user-skill-repository.ts')
const storePath = resolve(skillsRoot, 'user-skill-store.ts')
const agentHomeOwnerPath = resolve(skillsRoot, 'agent-home-skill-owner.ts')
const bundleOwnerPath = resolve(skillsRoot, 'skill-bundle-import-owner.ts')
const importContractsPath = resolve(skillsRoot, 'user-skill-import-contracts.ts')
const mutationOwnerPath = resolve(skillsRoot, 'skill-mutation-owner.ts')
const transactionOwnerPath = resolve(skillsRoot, 'skill-package-transaction-owner.ts')
const catalogObserverPath = resolve(skillsRoot, 'user-skill-catalog-observer.ts')
const compatibilityIndexPath = resolve(skillsRoot, 'user-skill-compatibility-index.ts')
const manifestPath = resolve(projectRoot, 'scripts/ci/module-impact.json')

const readSource = (path: string): string => readProductionSource(path, projectRoot)
const modulePath = (path: string): string => path.replace(/\.[cm]?[jt]sx?$/, '')
const portableProjectPath = (path: string): string =>
  relative(projectRoot, path).replaceAll('\\', '/')
const sourceFileFor = (path: string): SourceFile =>
  createSourceFile(
    path,
    readSource(path),
    ScriptTarget.Latest,
    true,
    extname(path) === '.tsx' ? ScriptKind.TSX : ScriptKind.TS
  )

const productionSources = (): readonly string[] => listProductionSources(projectRoot)

const importSpecifiersFrom = (path: string): string[] => {
  const specifiers: string[] = []
  const visit = (node: Node): void => {
    if (
      (isImportDeclaration(node) || isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (isImportTypeNode(node)) {
      const argument = node.argument
      if (isLiteralTypeNode(argument) && isStringLiteralLike(argument.literal)) {
        specifiers.push(argument.literal.text)
      }
    } else if (isCallExpression(node)) {
      const [argument] = node.arguments
      const isRequire = isIdentifier(node.expression) && node.expression.text === 'require'
      const isDynamicImport = node.expression.kind === SyntaxKind.ImportKeyword
      if ((isRequire || isDynamicImport) && argument && isStringLiteralLike(argument)) {
        specifiers.push(argument.text)
      }
    }
    forEachChild(node, visit)
  }
  visit(sourceFileFor(path))
  return specifiers
}

const importersOf = (targetPath: string): string[] =>
  productionSources()
    .filter((path) => readSource(path).includes(basename(modulePath(targetPath))))
    .filter((path) =>
      importSpecifiersFrom(path).some(
        (specifier) =>
          specifier.startsWith('.') &&
          modulePath(resolve(dirname(path), specifier)) === modulePath(targetPath)
      )
    )
    .map(portableProjectPath)

const exportInventory = (): string[] => {
  const names: string[] = []
  for (const statement of sourceFileFor(repositoryPath).statements) {
    if (isExportDeclaration(statement) && statement.exportClause) {
      if (isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          names.push(
            `${statement.isTypeOnly || element.isTypeOnly ? 'type' : 'value'}:${element.name.text}`
          )
        }
      }
      continue
    }
    const exported =
      canHaveModifiers(statement) &&
      getModifiers(statement)?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword)
    if (!exported) continue
    if (isInterfaceDeclaration(statement) || isTypeAliasDeclaration(statement)) {
      names.push(`type:${statement.name.text}`)
    } else if (isClassDeclaration(statement) || isFunctionDeclaration(statement)) {
      names.push(`value:${statement.name?.text ?? '<anonymous>'}`)
    } else if (isVariableStatement(statement)) {
      names.push(
        ...statement.declarationList.declarations.flatMap((declaration) =>
          isIdentifier(declaration.name) ? [`value:${declaration.name.text}`] : []
        )
      )
    }
  }
  return names.sort()
}

const publicOperations = (): string[] => {
  const declaration = sourceFileFor(repositoryPath).statements.find(
    (statement) => isClassDeclaration(statement) && statement.name?.text === 'UserSkillRepository'
  )
  if (!declaration || !isClassDeclaration(declaration)) throw new Error('facade class not found')

  return declaration.members
    .flatMap((member) => {
      const hidden =
        canHaveModifiers(member) &&
        getModifiers(member)?.some((modifier) =>
          [SyntaxKind.PrivateKeyword, SyntaxKind.ProtectedKeyword].includes(modifier.kind)
        )
      // Overload signatures describe the same operation; inventory its implementation once.
      return !hidden && isMethodDeclaration(member) && member.body && isIdentifier(member.name)
        ? [member.name.text]
        : []
    })
    .sort()
}

describe('User Skill repository architecture', () => {
  it('locks the compatibility export and operation inventories', () => {
    expect(exportInventory()).toEqual([
      'type:ImportOutcome',
      'type:UserSkillRepositoryOptions',
      'value:SAFE_SKILL_DIRECTORY_NAME',
      'value:SAFE_SKILL_NAME',
      'value:SkillReleaseInstallConflict',
      'value:UserSkillRepository',
      'value:assertUsableSkillName',
      'value:frontmatterBlock',
      'value:isReservedSkillName',
      'value:normalizeSkillName',
      'value:parseUserSkillId'
    ])
    expect(publicOperations()).toEqual([
      'body',
      'createPersonal',
      'delete',
      'importAgentHomeSkill',
      'importFromGitHub',
      'importFromZip',
      'importFromZipBatch',
      'installRelease',
      'list',
      'listAgentHomeSkills',
      'matchImportedAgentHomeSkills',
      'previewAgentHomeSkill',
      'previewGitHubSkill',
      'previewReleaseUpdate',
      'previewZip',
      'publishPersonalDirectory',
      'releaseInstallation',
      'scanRepo',
      'updatePersonal',
      'withSkillReadLock'
    ])
  })

  it('keeps production consumers on the facade and one mutation-owner construction seam', () => {
    expect(importersOf(repositoryPath)).toEqual([
      'packages/skills/src/agent-home-skill-catalog.ts',
      'packages/skills/src/index.ts',
      'packages/skills/src/skill-authoring-service.ts'
    ])
    expect(importersOf(mutationOwnerPath)).toEqual([
      'packages/skills/src/skill-authoring-service.ts',
      'packages/skills/src/skill-package-transaction-owner.ts',
      'packages/skills/src/specialist-package-adapter.ts'
    ])
    expect(importersOf(storePath)).toEqual([
      'packages/skills/src/agent-home-skill-catalog.ts',
      'packages/skills/src/agent-home-skill-owner.ts',
      'packages/skills/src/index.ts',
      'packages/skills/src/skill-bundle-import-owner.ts',
      'packages/skills/src/user-skill-repository.ts'
    ])
    expect(importersOf(agentHomeOwnerPath)).toEqual([
      'packages/skills/src/agent-home-skill-catalog.ts',
      'packages/skills/src/index.ts',
      'packages/skills/src/user-skill-repository.ts'
    ])
    expect(importersOf(bundleOwnerPath)).toEqual(['packages/skills/src/user-skill-repository.ts'])
    expect(importersOf(importContractsPath)).toEqual([
      'packages/skills/src/agent-home-skill-catalog.ts',
      'packages/skills/src/agent-home-skill-owner.ts',
      'packages/skills/src/index.ts',
      'packages/skills/src/skill-bundle-import-owner.ts',
      'packages/skills/src/user-skill-repository.ts'
    ])
    expect(importersOf(transactionOwnerPath)).toEqual([
      'packages/skills/src/agent-home-skill-owner.ts',
      'packages/skills/src/skill-bundle-import-owner.ts',
      'packages/skills/src/user-skill-repository.ts',
      'packages/skills/src/user-skill-store.ts'
    ])
    expect(importersOf(compatibilityIndexPath)).toEqual([
      'packages/skills/src/user-skill-repository.ts',
      'packages/skills/src/user-skill-store.ts'
    ])
    expect(importersOf(catalogObserverPath)).toEqual(['packages/skills/src/index.ts'])
    expect(readSource(repositoryPath)).not.toContain('skillMutationOwnerFor(')
    expect(readSource(repositoryPath)).not.toContain('mutationOwner?: SkillMutationOwner')
    expect(readSource(repositoryPath)).toContain(
      'new SkillPackageTransactionOwner(\n      storageRoot,\n      undefined,\n      withExternalRecoveryBarrier\n    )'
    )
    expect(readSource(repositoryPath).replace(/\s+/g, '')).toContain(
      'newUserSkillStore(storageRoot,this.transactions,this.compatibilityIndex,validateHelper)'
    )
    expect(readSource(repositoryPath).replace(/\s+/g, '')).toContain(
      'newSkillBundleImportOwner(this.store,this.transactions,options.discoverArchive)'
    )
    expect(readSource(repositoryPath)).toContain(
      'new AgentHomeSkillOwner(this.store, this.transactions)'
    )
    expect(readSource(repositoryPath)).not.toContain('inspectAgentHomeSkill')
    expect(readSource(repositoryPath)).toContain(
      'this.agentHomeSkills.validatePublishedSkillPackage(staging)'
    )
  })

  it('keeps the package and host under explicit module ownership with downstream contracts', () => {
    const manifest = loadModuleImpactManifest(manifestPath)
    const owners = Object.values(manifest.modules).flatMap((module) => module.ownerPaths)
    for (const path of productionSources()
      .map(portableProjectPath)
      .filter(
        (path) => path.startsWith('packages/skills/src/') || path.startsWith('src/main/skills/')
      )) {
      if (path.endsWith('.d.ts')) continue
      expect(
        owners.filter((owner) => owner === path),
        path
      ).toHaveLength(1)
    }
    expect(manifest.modules.skill_package.interfacePaths).toEqual(
      expect.arrayContaining([
        'packages/skills/src/index.ts',
        'packages/skills/src/document.ts',
        'packages/skills/src/sources.ts',
        'packages/skills/src/projection.ts'
      ])
    )
    expect(manifest.modules.skill_package.consumerModules).toContain('user_skills_repository')
    expect(manifest.modules.user_skills_repository.testFiles.contract).toContain(
      'src/main/skills/catalog.test.ts'
    )
  })
})
