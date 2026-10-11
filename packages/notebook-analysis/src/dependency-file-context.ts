import { PYTHON_LIBRARY_EFFECTS } from './python-library-effects'
import type {
  NotebookRunDependencyFacts,
  NotebookSourceFileAccessContext
} from './dependency-analysis-types'

type FileContextEntry = {
  facts: NotebookRunDependencyFacts
  fileContext: NotebookSourceFileAccessContext
  // Transient owner evidence: relative database paths cannot outlive an uncertain cwd.
  sqliteRelativePathBarrier?: boolean
}

type PythonBinding = NonNullable<NotebookSourceFileAccessContext['pythonBindings']>[number]
const isSqliteBinding = (binding: PythonBinding): boolean =>
  binding.kind === 'object' &&
  ['sqlite3.Connection', 'sqlite3.Cursor'].includes(binding.qualifiedName)
const isRelativeSqlitePath = (path: string): boolean => !/^(?:[\\/]|[A-Za-z]:[\\/])/.test(path)
const withoutFilePath = (binding: PythonBinding): PythonBinding => {
  const identity = { ...binding }
  delete identity.filePath
  return identity
}

const FILE_CONTEXT_SAFE_UNKNOWN_REASONS = new Set([
  'control-flow',
  'external-state',
  'function-scope'
])
const MAX_PYTHON_IDENTITIES = 512

// The owner checks history/epoch/cache validity. This projection owns only binding lifetimes;
// an unavailable entry discards prior knowledge, and later completed runs can establish it again.
const projectNotebookFileContext = (
  language: 'python' | 'r' | 'repl',
  entries: Iterable<FileContextEntry | undefined>,
  options: { sqliteRelativePathBarrier?: boolean } = {}
): NotebookSourceFileAccessContext | undefined => {
  const staticStrings = new Map<string, string>()
  const staticCollections = new Map<
    string,
    NotebookSourceFileAccessContext['staticCollections'][number]
  >()
  const localFileWrappers = new Map<
    string,
    NotebookSourceFileAccessContext['localFileWrappers'][number]
  >()
  const resolvedKernelNames = new Set<string>()
  const replContainerNames = new Set<string>()
  let replNamespaceUncertain = false
  const rAtomicValueNames = new Set<string>()
  const rCopyOnModifyNames = new Set<string>()
  const pythonTaintedNamespaces = new Set<string>()
  const pythonBindings = new Map<
    string,
    NonNullable<NotebookSourceFileAccessContext['pythonBindings']>[number]
  >()
  const pythonHelperModules = new Map<
    string,
    NonNullable<NotebookSourceFileAccessContext['pythonHelperModules']>[number]
  >()
  const rFunctions = new Map<
    string,
    NonNullable<NotebookSourceFileAccessContext['rFunctions']>[number]['summary']
  >()
  const aliases = new Map<string, Set<string>>()
  const boundPythonState = (): void => {
    if (
      pythonTaintedNamespaces.size > MAX_PYTHON_IDENTITIES ||
      pythonBindings.size > MAX_PYTHON_IDENTITIES
    ) {
      // Discarding individual taints could make a patched module trusted again.
      pythonTaintedNamespaces.clear()
      pythonTaintedNamespaces.add('*')
    }
    if (pythonTaintedNamespaces.has('*')) {
      pythonTaintedNamespaces.clear()
      pythonTaintedNamespaces.add('*')
      pythonBindings.clear()
      pythonHelperModules.clear()
    }
  }
  let available = true
  for (const entry of entries) {
    if (
      language === 'repl' &&
      (!entry ||
        (entry.facts.state === 'unknown' &&
          entry.facts.reasons.some(
            (reason) =>
              ![
                'external-state',
                'control-flow',
                'function-scope',
                'execution-incomplete'
              ].includes(reason)
          )))
    )
      replNamespaceUncertain = true
    if (
      language === 'repl' &&
      entry?.facts.state === 'unknown' &&
      entry.facts.reasons.includes('execution-incomplete') &&
      !replNamespaceUncertain
    ) {
      // A failed IIFE can partially publish its globals, but cannot erase unrelated
      // bindings. Keep only identities that this source could not have touched.
      const affected = new Set([
        ...(entry.facts.definedNames ?? []),
        ...(entry.facts.conditionallyDefinedNames ?? []),
        ...(entry.facts.mutatedNames ?? []),
        ...(entry.facts.possiblyMutatedNames ?? [])
      ])
      for (const name of affected) for (const alias of aliases.get(name) ?? []) affected.add(alias)
      for (const name of affected) {
        staticStrings.delete(name)
        replContainerNames.delete(name)
        resolvedKernelNames.delete(name)
      }
      continue
    }
    for (const namespace of entry?.fileContext.pythonTaintedNamespaces ?? [])
      pythonTaintedNamespaces.add(namespace)
    for (const module of entry?.fileContext.pythonHelperModules ?? [])
      pythonHelperModules.set(`${module.source}\0${module.exports.join('\0')}`, module)
    if (
      !entry ||
      (entry.facts.state === 'unknown' &&
        entry.facts.reasons.some((reason) => !FILE_CONTEXT_SAFE_UNKNOWN_REASONS.has(reason)))
    ) {
      const poisonedBindings = [
        ...pythonBindings.values(),
        ...(entry?.fileContext.pythonBindings ?? [])
      ].filter(
        (binding) =>
          pythonTaintedNamespaces.has('*') ||
          pythonTaintedNamespaces.has(binding.qualifiedName.split('.')[0]!)
      )
      staticStrings.clear()
      staticCollections.clear()
      localFileWrappers.clear()
      pythonHelperModules.clear()
      resolvedKernelNames.clear()
      replContainerNames.clear()
      rAtomicValueNames.clear()
      rCopyOnModifyNames.clear()
      rFunctions.clear()
      pythonBindings.clear()
      // These names convey uncertainty only; they must not regain trusted library
      // effects after a re-import of the same Python module object.
      for (const binding of poisonedBindings)
        pythonBindings.set(
          binding.name,
          isSqliteBinding(binding) ? withoutFilePath(binding) : binding
        )
      boundPythonState()
      aliases.clear()
      available = false
      continue
    }
    available = true
    const { facts, fileContext } = entry
    // The current scanner output is authoritative for SQLite lifetimes. A previous
    // path must not survive a typed-without-path output or a typeBindings overlay.
    const priorSqliteBindings = new Map(
      [...pythonBindings].filter(([, binding]) => isSqliteBinding(binding))
    )
    const sqliteNames = new Set(
      [...pythonBindings.values(), ...(fileContext.pythonBindings ?? [])]
        .filter(isSqliteBinding)
        .map(({ name }) => name)
    )
    if (language === 'python')
      for (const [name, binding] of pythonBindings)
        if (isSqliteBinding(binding)) pythonBindings.set(name, withoutFilePath(binding))
    const conditionalNames = new Set(facts.conditionallyDefinedNames ?? [])
    const definedNames = new Set([
      ...(facts.definedNames ?? []),
      ...(facts.conditionallyDefinedNames ?? [])
    ])
    const mutatedNames = new Set([
      ...(facts.mutatedNames ?? []),
      ...(facts.possiblyMutatedNames ?? []),
      ...(facts.receiverCalls ?? [])
        .filter(({ kind }) => kind === 'mutating')
        .map(({ receiver }) => receiver),
      ...(facts.memberWrites ?? []).map(({ receiver }) => receiver)
    ])
    // Include both existing and newly assigned aliases: run facts summarize a whole cell,
    // so they cannot prove which side of a reassignment an in-place mutation occurred on.
    for (const name of mutatedNames) {
      for (const alias of aliases.get(name) ?? []) mutatedNames.add(alias)
      if (language === 'python' || language === 'repl') {
        for (const { target, source } of facts.aliases ?? []) {
          if (target === name) mutatedNames.add(source)
          if (source === name) mutatedNames.add(target)
        }
      }
    }
    const sqliteRevokedNames = new Set(mutatedNames)
    for (const { target, source } of facts.aliases ?? [])
      if (sqliteNames.has(target) || sqliteNames.has(source)) {
        sqliteRevokedNames.add(target)
        sqliteRevokedNames.add(source)
      }
    for (const { receiver, member, conditional } of facts.receiverCalls ?? [])
      if (
        sqliteNames.has(receiver) &&
        (conditional || !['cursor', 'execute', 'fetchall'].includes(member))
      )
        sqliteRevokedNames.add(receiver)
    const invalidatedNames = new Set([...definedNames, ...mutatedNames])
    for (const [key, module] of pythonHelperModules) {
      if (module.exports.some((name) => invalidatedNames.has(name))) pythonHelperModules.delete(key)
    }
    for (const name of invalidatedNames) replContainerNames.delete(name)
    for (const name of facts.builtinContainerNames ?? []) {
      if (!conditionalNames.has(name)) replContainerNames.add(name)
    }
    const priorCopyOnModifyNames = new Set(rCopyOnModifyNames)
    for (const [name, wrapper] of localFileWrappers) {
      if (wrapper.dependencyNames.some((dependency) => invalidatedNames.has(dependency))) {
        localFileWrappers.delete(name)
      }
    }
    for (const name of invalidatedNames) {
      staticStrings.delete(name)
      staticCollections.delete(name)
      localFileWrappers.delete(name)
      rFunctions.delete(name)
      rAtomicValueNames.delete(name)
      rCopyOnModifyNames.delete(name)
      const binding = pythonBindings.get(name)
      if (
        definedNames.has(name) ||
        !binding ||
        (!pythonTaintedNamespaces.has('*') &&
          !pythonTaintedNamespaces.has(binding.qualifiedName.split('.')[0]!))
      )
        pythonBindings.delete(name)
    }
    // A replaced builtin changes the body semantics of functions that call it.
    for (const [name, summary] of rFunctions) {
      if (
        summary.methods.some((method) =>
          method.safeCallNames?.some((call) => invalidatedNames.has(call))
        )
      )
        rFunctions.delete(name)
    }
    if (language === 'r') {
      const uncertainMutations = new Set([
        ...(facts.possiblyMutatedNames ?? []),
        ...(facts.receiverCalls ?? []).flatMap((call) => [
          call.receiver,
          ...(call.argumentNames ?? [])
        ])
      ])
      const safeValue = (name: string): boolean =>
        !conditionalNames.has(name) &&
        !uncertainMutations.has(name) &&
        !facts.copyOnModifyInvalidatedNames?.includes(name)
      // Known R column/metadata replacements copy ordinary values. Their final
      // ownership facts remain valid across cells; unresolved method effects do not.
      for (const name of facts.copyOnModifyNames ?? [])
        if (safeValue(name)) rCopyOnModifyNames.add(name)
      for (const { target, sourceNames } of facts.copyOnModifyBindings ?? [])
        if (
          safeValue(target) &&
          sourceNames.every(
            (name) =>
              priorCopyOnModifyNames.has(name) &&
              (!invalidatedNames.has(name) || (name === target && !definedNames.has(name)))
          )
        )
          rCopyOnModifyNames.add(target)
      for (const name of facts.rAtomicValueNames ?? [])
        if (definedNames.has(name) && !conditionalNames.has(name) && !mutatedNames.has(name))
          rAtomicValueNames.add(name)
      for (const binding of facts.typeBindings ?? []) {
        const summary = facts.typeSummaries?.find((item) => item.name === binding.typeName)
        if (
          summary?.kind === 'r-function' &&
          !conditionalNames.has(binding.target) &&
          !summary.methods.some((method) =>
            method.safeCallNames?.some(
              (name) => resolvedKernelNames.has(name) || definedNames.has(name)
            )
          )
        )
          rFunctions.set(binding.target, summary)
      }
      for (const { target, source, access } of facts.aliases ?? []) {
        const summary = rFunctions.get(source)
        if (summary && !access && !conditionalNames.has(target)) rFunctions.set(target, summary)
      }
    }
    for (const name of definedNames) {
      resolvedKernelNames.delete(name)
      if (conditionalNames.has(name)) continue
      const group = aliases.get(name)
      group?.delete(name)
      aliases.delete(name)
    }
    if (language === 'python' || language === 'repl') {
      for (const { target, source } of facts.aliases ?? []) {
        const group = new Set([
          target,
          source,
          ...(aliases.get(target) ?? []),
          ...(aliases.get(source) ?? [])
        ])
        for (const name of group) aliases.set(name, group)
      }
    }
    for (const name of facts.definedNames ?? []) {
      if (!conditionalNames.has(name)) resolvedKernelNames.add(name)
    }
    for (const binding of fileContext.staticStrings) {
      if (!conditionalNames.has(binding.name)) staticStrings.set(binding.name, binding.value)
    }
    for (const collection of fileContext.staticCollections) {
      if (!conditionalNames.has(collection.name)) staticCollections.set(collection.name, collection)
    }
    for (const wrapper of fileContext.localFileWrappers) {
      if (!conditionalNames.has(wrapper.name)) localFileWrappers.set(wrapper.name, wrapper)
    }
    const outgoingBindings = new Map(
      (fileContext.pythonBindings ?? []).map((binding) => [binding.name, binding])
    )
    const sqlitePaths = new Map<string, string>()
    if (language === 'python') {
      const candidates = [...outgoingBindings.values()].filter(
        (binding) =>
          isSqliteBinding(binding) &&
          binding.filePath !== undefined &&
          !conditionalNames.has(binding.name) &&
          !sqliteRevokedNames.has(binding.name) &&
          !pythonTaintedNamespaces.has('*') &&
          !pythonTaintedNamespaces.has('sqlite3') &&
          !(entry.sqliteRelativePathBarrier && isRelativeSqlitePath(binding.filePath))
      )
      const keepsPriorPath = (binding: PythonBinding): boolean =>
        !definedNames.has(binding.name) &&
        priorSqliteBindings.get(binding.name)?.qualifiedName === binding.qualifiedName &&
        priorSqliteBindings.get(binding.name)?.filePath === binding.filePath
      const resultCall = (
        name: string
      ): NonNullable<typeof facts.receiverCalls>[number] | undefined => {
        const calls = (facts.receiverCalls ?? []).filter((call) => call.resultNames?.includes(name))
        const call = calls.length === 1 ? calls[0] : undefined
        return call?.kind === 'receiver' &&
          !call.conditional &&
          call.receiverChain?.length === 0 &&
          call.resultNames?.length === 1 &&
          call.argumentNames?.length === 0
          ? call
          : undefined
      }
      // A fresh name is not provenance: cached calls can depend on a prior context
      // that has since lost its path or static URI. Keep only closed constructors.
      for (const binding of candidates.filter(
        ({ qualifiedName }) => qualifiedName === 'sqlite3.Connection'
      )) {
        const call = definedNames.has(binding.name) ? resultCall(binding.name) : undefined
        const origin =
          call &&
          (definedNames.has(call.receiver)
            ? outgoingBindings.get(call.receiver)
            : pythonBindings.get(call.receiver))
        if (
          keepsPriorPath(binding) ||
          (call?.member === 'connect' &&
            origin?.kind === 'import' &&
            origin.qualifiedName === 'sqlite3' &&
            !conditionalNames.has(call.receiver) &&
            !mutatedNames.has(call.receiver) &&
            call.positionalArgumentNames !== undefined &&
            call.positionalArgumentNames.length <= 1 &&
            call.positionalArgumentNames.every((names) => names.length === 0) &&
            call.keywordArguments !== undefined &&
            call.keywordArguments.every(
              (argument) =>
                ['database', 'uri'].includes(argument.name) &&
                argument.argumentNames.length === 0 &&
                !argument.possibleArgumentNames?.length
            ) &&
            call.keywordArguments.filter(
              ({ name, staticBoolean }) => name === 'uri' && staticBoolean === true
            ).length === 1)
        )
          sqlitePaths.set(binding.name, binding.filePath!)
      }
      // Validate receivers before cursors, independent of outgoing binding order.
      for (const binding of candidates.filter(
        ({ qualifiedName }) => qualifiedName === 'sqlite3.Cursor'
      )) {
        const call = definedNames.has(binding.name) ? resultCall(binding.name) : undefined
        if (
          keepsPriorPath(binding) ||
          (call?.member === 'cursor' &&
            call.positionalArgumentNames?.length === 0 &&
            call.keywordArguments?.length === 0 &&
            sqlitePaths.get(call.receiver) === binding.filePath &&
            outgoingBindings.get(call.receiver)?.qualifiedName === 'sqlite3.Connection')
        )
          sqlitePaths.set(binding.name, binding.filePath!)
      }
    }
    for (const binding of outgoingBindings.values())
      if (!conditionalNames.has(binding.name))
        pythonBindings.set(
          binding.name,
          language === 'python' && isSqliteBinding(binding) && !sqlitePaths.has(binding.name)
            ? withoutFilePath(binding)
            : binding
        )
    if (language === 'python') {
      for (const binding of facts.typeBindings ?? []) {
        if (
          PYTHON_LIBRARY_EFFECTS[binding.typeName]?.kind === 'type' &&
          !conditionalNames.has(binding.target)
        )
          pythonBindings.set(binding.target, {
            name: binding.target,
            qualifiedName: binding.typeName,
            kind: 'object',
            ...(pythonBindings.get(binding.target)?.qualifiedName === binding.typeName &&
            pythonBindings.get(binding.target)?.filePath
              ? { filePath: pythonBindings.get(binding.target)!.filePath }
              : {})
          })
      }
    }
    boundPythonState()
  }
  if (language === 'python' && options.sqliteRelativePathBarrier)
    for (const [name, binding] of pythonBindings)
      if (
        isSqliteBinding(binding) &&
        binding.filePath !== undefined &&
        isRelativeSqlitePath(binding.filePath)
      )
        pythonBindings.set(name, withoutFilePath(binding))
  if (!available && !pythonTaintedNamespaces.size && !replNamespaceUncertain) return undefined
  const specializedNames = new Set([
    ...staticStrings.keys(),
    ...staticCollections.keys(),
    ...localFileWrappers.keys()
  ])
  const remainingKernelNames = [...resolvedKernelNames]
    .filter((name) => !specializedNames.has(name))
    .sort()
  const staticCollectionAliases: NonNullable<
    NotebookSourceFileAccessContext['staticCollectionAliases']
  > = []
  for (const group of new Set(aliases.values())) {
    const source = [...group].find((name) => staticCollections.has(name))
    if (!source) continue
    for (const target of group) {
      if (target !== source) staticCollectionAliases.push({ target, source })
    }
  }
  return {
    staticStrings: [...staticStrings]
      .map(([name, value]) => ({ name, value }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    staticCollections: [...staticCollections.values()].sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
    localFileWrappers: [...localFileWrappers.values()].sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
    ...(language === 'repl'
      ? { replContainerNames: [...replContainerNames], replNamespaceUncertain }
      : {}),
    ...(rAtomicValueNames.size ? { rAtomicValueNames: [...rAtomicValueNames].sort() } : {}),
    ...(rCopyOnModifyNames.size ? { rCopyOnModifyNames: [...rCopyOnModifyNames].sort() } : {}),
    ...(remainingKernelNames.length ? { resolvedKernelNames: remainingKernelNames } : {}),
    ...(pythonTaintedNamespaces.size
      ? { pythonTaintedNamespaces: [...pythonTaintedNamespaces].sort() }
      : {}),
    ...(pythonBindings.size
      ? {
          pythonBindings: [...pythonBindings.values()].sort((a, b) => a.name.localeCompare(b.name))
        }
      : {}),
    ...(rFunctions.size
      ? { rFunctions: [...rFunctions].map(([name, summary]) => ({ name, summary })) }
      : {}),
    ...(staticCollectionAliases.length ? { staticCollectionAliases } : {}),
    ...(pythonHelperModules.size ? { pythonHelperModules: [...pythonHelperModules.values()] } : {})
  }
}

export { projectNotebookFileContext }
export type { FileContextEntry }
