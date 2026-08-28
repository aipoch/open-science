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

import {
  listProductionSources,
  readProductionSource
} from '../../../test/architecture-source-index'

const projectRoot = resolve(__dirname, '../../..')
const skillsRoot = resolve(projectRoot, 'src/main/skills')
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
      return !hidden && isMethodDeclaration(member) && isIdentifier(member.name)
        ? [member.name.text]
        : []
    })
    .sort()
}

type ModuleImpactManifest = {
  modules: Record<
    string,
    {
      ownerPaths: string[]
      interfacePaths: string[]
      consumerModules: string[]
      testFiles: { owner: string[]; contract: string[]; consumer: string[] }
      capabilityOverlays: string[]
      fallbackCapability: string
    }
  >
}

describe('User Skill repository architecture', () => {
  it('locks the compatibility export and operation inventories', () => {
    expect(exportInventory()).toEqual([
      'type:ImportOutcome',
      'value:SAFE_SKILL_DIRECTORY_NAME',
      'value:SAFE_SKILL_NAME',
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
      'list',
      'listAgentHomeSkills',
      'matchImportedAgentHomeSkills',
      'previewAgentHomeSkill',
      'previewGitHubSkill',
      'previewZip',
      'publishPersonalDirectory',
      'scanRepo',
      'updatePersonal',
      'withSkillReadLock'
    ])
  })

  it('keeps production consumers on the facade and one mutation-owner construction seam', () => {
    expect(importersOf(repositoryPath)).toEqual([
      'src/main/settings/service.ts',
      'src/main/settings/skill-catalog.ts',
      'src/main/skills/host-skills-service.ts'
    ])
    expect(importersOf(mutationOwnerPath)).toEqual([
      'src/main/skills/skill-package-transaction-owner.ts',
      'src/main/skills/specialist-package-adapter.ts'
    ])
    expect(importersOf(storePath)).toEqual([
      'src/main/skills/agent-home-skill-owner.ts',
      'src/main/skills/skill-bundle-import-owner.ts',
      'src/main/skills/user-skill-repository.ts'
    ])
    expect(importersOf(agentHomeOwnerPath)).toEqual(['src/main/skills/user-skill-repository.ts'])
    expect(importersOf(bundleOwnerPath)).toEqual(['src/main/skills/user-skill-repository.ts'])
    expect(importersOf(importContractsPath)).toEqual([
      'src/main/skills/agent-home-skill-owner.ts',
      'src/main/skills/skill-bundle-import-owner.ts',
      'src/main/skills/user-skill-repository.ts'
    ])
    expect(importersOf(transactionOwnerPath)).toEqual([
      'src/main/skills/agent-home-skill-owner.ts',
      'src/main/skills/skill-bundle-import-owner.ts',
      'src/main/skills/user-skill-repository.ts',
      'src/main/skills/user-skill-store.ts'
    ])
    expect(importersOf(compatibilityIndexPath)).toEqual([
      'src/main/skills/user-skill-repository.ts',
      'src/main/skills/user-skill-store.ts'
    ])
    expect(importersOf(catalogObserverPath)).toEqual(['src/main/ipc.ts'])
    expect(readSource(repositoryPath)).not.toContain('skillMutationOwnerFor(')
    expect(readSource(repositoryPath)).toContain('mutationOwner?: SkillMutationOwner')
    expect(readSource(repositoryPath)).toContain(
      'new SkillPackageTransactionOwner(storageRoot, mutationOwner)'
    )
    expect(readSource(repositoryPath)).toContain(
      'new UserSkillStore(storageRoot, this.transactions, this.compatibilityIndex)'
    )
    expect(readSource(repositoryPath)).toContain(
      'new SkillBundleImportOwner(this.store, this.transactions)'
    )
    expect(readSource(repositoryPath)).toContain(
      'new AgentHomeSkillOwner(this.store, this.transactions)'
    )
    expect(readSource(repositoryPath)).not.toContain('inspectAgentHomeSkill')
    expect(readSource(repositoryPath)).toContain(
      'this.agentHomeSkills.validatePublishedSkillPackage(staging)'
    )
  })

  it('declares complete ownership and downstream test impact', () => {
    const manifest = JSON.parse(readSource(manifestPath)) as ModuleImpactManifest
    expect(manifest.modules.user_skills_repository).toEqual({
      ownerPaths: [
        'src/main/skills/user-skill-catalog-observer.ts',
        'src/main/skills/user-skill-compatibility-index.ts',
        'src/main/skills/user-skill-repository.ts',
        'src/main/skills/user-skill-store.ts',
        'src/main/skills/agent-home-skill-owner.ts',
        'src/main/skills/skill-bundle-import-owner.ts',
        'src/main/skills/user-skill-import-contracts.ts',
        'src/main/skills/skill-mutation-owner.ts',
        'src/main/skills/skill-package-transaction-owner.ts'
      ],
      interfacePaths: [
        'src/main/skills/user-skill-repository.ts',
        'src/main/skills/user-skill-catalog-observer.ts'
      ],
      consumerModules: ['settings_service_facade'],
      testFiles: {
        owner: [
          'src/main/skills/user-skill-catalog-observer.test.ts',
          'src/main/skills/user-skill-compatibility-index.test.ts',
          'src/main/skills/user-skill-repository.architecture.test.ts',
          'src/main/skills/user-skill-repository.atomic.test.ts',
          'src/main/skills/user-skill-repository.test.ts'
        ],
        contract: [
          'src/main/skills/host-skills-service.test.ts',
          'src/main/skills/skill-archive-sniffer.test.ts',
          'src/main/settings/skill-catalog.test.ts'
        ],
        consumer: [
          'src/main/skills/conversation-import.test.ts',
          'src/main/skills/specialist-package-adapter.test.ts',
          'src/main/notebook/local-rpc-server.test.ts',
          'src/main/notebook/local-rpc-server.skill-import.test.ts',
          'src/main/notebook/local-rpc-server.skills.test.ts',
          'src/main/settings/service.test.ts',
          'src/main/specialist/package/release-certification.test.ts',
          'src/main/specialist/package/service.test.ts',
          'src/preload/index.test.ts',
          'src/renderer/src/pages/settings/SkillsPanel.render.test.tsx',
          'src/renderer/src/stores/settings-skills-slice.test.ts'
        ]
      },
      capabilityOverlays: ['windows_sensitive'],
      fallbackCapability: 'main_runtime'
    })
  })
})
