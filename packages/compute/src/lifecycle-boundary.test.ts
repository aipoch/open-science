import { readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import {
  createSourceFile,
  forEachChild,
  getModifiers,
  isCallExpression,
  isClassDeclaration,
  isIdentifier,
  isImportDeclaration,
  isMethodDeclaration,
  isPropertyAccessExpression,
  isStringLiteralLike,
  ScriptTarget,
  SyntaxKind,
  type Node,
  type SourceFile
} from 'typescript'
import { expect, it } from 'vitest'

const root = resolve(__dirname, '..')
const readSource = (path: string): string => readFileSync(path, 'utf8')
const sourceFileFor = (path: string): SourceFile =>
  createSourceFile(path, readSource(path), ScriptTarget.Latest, true)
const modulePath = (path: string): string => path.replace(/\.ts$/, '')
const portableProjectPath = (path: string): string => relative(root, path).replaceAll('\\', '/')
const productionSourcePaths = readdirSync(resolve(root, 'src'))
  .filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))
  .map((n) => resolve(root, 'src', n))
  .sort()
const importSpecifiersFrom = (path: string): string[] =>
  sourceFileFor(path).statements.flatMap((n) =>
    isImportDeclaration(n) && isStringLiteralLike(n.moduleSpecifier) ? [n.moduleSpecifier.text] : []
  )
const resolveImportTarget = (path: string, spec: string): string | undefined =>
  spec.startsWith('.') ? modulePath(resolve(dirname(path), spec)) : undefined
const computePaths = {
  jobLifecycle: resolve(root, 'src/compute-job-lifecycle.ts'),
  concurrencyManager: resolve(root, 'src/concurrency-manager.ts'),
  jobDispatcher: resolve(root, 'src/job-dispatcher.ts'),
  jobPoller: resolve(root, 'src/job-poller.ts')
}
const calledMembersOn = (sourcePath: string, receiver: readonly string[]): string[] => {
  const calls = new Set<string>()
  const matchesReceiver = (node: Node): boolean => {
    let current: Node = node
    for (let index = receiver.length - 1; index >= 0; index -= 1) {
      if (index === 0) {
        return receiver[index] === 'this'
          ? current.kind === SyntaxKind.ThisKeyword
          : isIdentifier(current) && current.text === receiver[index]
      }
      if (!isPropertyAccessExpression(current) || current.name.text !== receiver[index])
        return false
      current = current.expression
    }
    return false
  }
  const visit = (node: Node): void => {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      matchesReceiver(node.expression.expression)
    ) {
      calls.add(node.expression.name.text)
    }
    forEachChild(node, visit)
  }
  visit(sourceFileFor(sourcePath))
  return [...calls].sort()
}

it('keeps lifecycle state ownership behind the narrow intent interface', () => {
  const lifecycle = sourceFileFor(computePaths.jobLifecycle).statements.find(
    (statement) => isClassDeclaration(statement) && statement.name?.text === 'ComputeJobLifecycle'
  )
  expect(lifecycle && isClassDeclaration(lifecycle)).toBe(true)
  if (!lifecycle || !isClassDeclaration(lifecycle)) return

  const publicMethods = lifecycle.members
    .flatMap((member) => {
      if (
        !isMethodDeclaration(member) ||
        !isIdentifier(member.name) ||
        getModifiers(member)?.some((modifier) => modifier.kind === SyntaxKind.PrivateKeyword) ===
          true
      ) {
        return []
      }
      return [member.name.text]
    })
    .sort()
  expect(publicMethods).toEqual(
    [
      'abortOwnerDeletion',
      'beginOwnerDeletion',
      'beginRemoteDispatch',
      'deleteOwnerRows',
      'dispatchError',
      'dispatchRunning',
      'dispatchSubmitted',
      'failJobStatus',
      'failRemoteHandleRecovery',
      'finishPolled',
      'observePending',
      'observeRunning',
      'promoteQueued',
      'recordPollError',
      'recoverRemoteHandle',
      'recoverInterruptedDispatch'
    ].sort()
  )
  expect(calledMembersOn(computePaths.jobLifecycle, ['this', 'repository'])).toEqual(
    [
      'abortOwnerDeletion',
      'beginOwnerDeletion',
      'deleteByOwner',
      'get',
      'recordCancellationHandle',
      'recordDispatchNoLaunch',
      'updateIfStatus'
    ].sort()
  )

  const lifecycleTarget = modulePath(computePaths.jobLifecycle)
  const importers = productionSourcePaths.flatMap((sourcePath) =>
    importSpecifiersFrom(sourcePath).some(
      (specifier) => resolveImportTarget(sourcePath, specifier) === lifecycleTarget
    )
      ? [portableProjectPath(sourcePath)]
      : []
  )
  expect(importers).toEqual([
    'src/compute-job-cancellation-owner.ts',
    'src/concurrency-manager.ts',
    'src/controllers.ts',
    'src/job-deletion-owner.ts',
    'src/job-dispatcher.ts',
    'src/job-poller.ts',
    'src/submitted-job-recovery.ts'
  ])

  for (const calls of [
    calledMembersOn(computePaths.concurrencyManager, ['this', 'jobRepository']),
    calledMembersOn(computePaths.jobDispatcher, ['jobRepository']),
    calledMembersOn(computePaths.jobPoller, ['this', 'deps', 'jobRepository'])
  ]) {
    expect(calls).not.toContain('update')
    expect(calls).not.toContain('updateIfStatus')
  }
})
