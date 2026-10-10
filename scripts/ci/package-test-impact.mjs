/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { appendFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const packageTestRegistryPath = 'scripts/ci/package-test-boundaries.json'
const rootPattern = /^packages\/[a-z0-9][a-z0-9-]*$/
const globalInput =
  /^(?:package(?:-lock)?\.json$|\.npmrc$|\.nvmrc$|(?:vitest|vite|electron|tsconfig)[^/]*|test\/|scripts\/|\.github\/|patches\/|build\/|resources\/)/

export function validatePackageTestRegistry(registry) {
  if (registry?.schemaVersion !== 1 || !Array.isArray(registry.packages))
    throw new Error('Invalid package test registry')
  const roots = new Set()
  for (const entry of registry.packages) {
    if (
      !rootPattern.test(entry.root) ||
      roots.has(entry.root) ||
      !Array.isArray(entry.dependencies)
    )
      throw new Error('Invalid or duplicate package test root')
    roots.add(entry.root)
  }
  for (const entry of registry.packages) {
    if (
      new Set(entry.dependencies).size !== entry.dependencies.length ||
      entry.dependencies.some((root) => !roots.has(root) || root === entry.root)
    )
      throw new Error(`Invalid package test dependencies: ${entry.root}`)
  }
  // Cycles violate the declared upstream/downstream package relationship.
  const active = new Set(),
    visited = new Set()
  const visit = (root) => {
    if (active.has(root)) throw new Error('Cyclic package test dependencies')
    if (visited.has(root)) return
    active.add(root)
    registry.packages.find((entry) => entry.root === root).dependencies.forEach(visit)
    active.delete(root)
    visited.add(root)
  }
  roots.forEach(visit)
  return registry
}

export function createPackageTestPlan(paths, registry) {
  const { packages } = validatePackageTestRegistry(registry)
  const roots = packages.map((entry) => entry.root)
  const reasons = []
  const changed = new Set()
  for (const path of paths) {
    const owner = roots.find((root) => path.startsWith(root + '/'))
    if (owner) {
      changed.add(owner)
      reasons.push(`${path} -> ${owner}`)
    } else if (globalInput.test(path) || !/^(?:src\/|docs\/|[^/]+\.md$)/.test(path)) {
      return {
        selected: roots,
        excluded: [],
        reasons: [`${path} -> shared or unknown input -> all package tests`]
      }
    }
  }
  let expanded = true
  while (expanded) {
    expanded = false
    for (const entry of packages) {
      const upstream = entry.dependencies.find((root) => changed.has(root))
      if (!changed.has(entry.root) && upstream) {
        changed.add(entry.root)
        reasons.push(`${upstream} -> downstream package ${entry.root}`)
        expanded = true
      }
    }
  }
  const excluded = roots.filter((root) => !changed.has(root))
  reasons.push(
    ...excluded.map((root) => `${root} -> unchanged upstream -> package unit tests excluded`)
  )
  return { selected: roots.filter((root) => changed.has(root)), excluded, reasons }
}

// Only CI supplies this value. Local npm test keeps the complete portable suite.
function packageRootsFromEnvironment(key, env, allowAll = false) {
  if (env.VITEST_PORTABLE_CI !== '1' || !env[key]) return []
  const roots = JSON.parse(env[key])
  if (
    !Array.isArray(roots) ||
    roots.some(
      (root) =>
        typeof root !== 'string' || (!rootPattern.test(root) && !(allowAll && root === 'packages'))
    )
  )
    throw new Error('Invalid CI package test roots')
  return roots
}

export function packageTestExcludePatterns(env = process.env) {
  return packageRootsFromEnvironment('OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS', env).map(
    (root) => `${root}/**`
  )
}

export function packageTestSelectedRoots(env = process.env) {
  return packageRootsFromEnvironment('OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS', env, true)
}

export function packageTestPlanFromRevisions(
  base,
  head,
  trustedBase = base,
  { cwd = process.cwd(), execute = execFileSync } = {}
) {
  const git = (...args) =>
    execute('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).toString()
  try {
    const registry = JSON.parse(git('show', `${trustedBase}:${packageTestRegistryPath}`))
    validatePackageTestRegistry(registry)
    const manifests = new Map(
      registry.packages.map((entry) => [
        entry.root,
        JSON.parse(git('show', `${trustedBase}:${entry.root}/package.json`))
      ])
    )
    for (const entry of registry.packages) {
      const manifest = manifests.get(entry.root)
      if (!manifest.name || !manifest.scripts?.test)
        throw new Error(`Package lacks an independent test command: ${entry.root}`)
      const dependencies = {
        ...manifest.dependencies,
        ...manifest.peerDependencies,
        ...manifest.devDependencies,
        ...manifest.optionalDependencies
      }
      for (const [root, upstream] of manifests) {
        if (
          root !== entry.root &&
          Object.hasOwn(dependencies, upstream.name) &&
          !entry.dependencies.includes(root)
        )
          throw new Error(`Missing upstream dependency: ${entry.root} -> ${root}`)
      }
    }
    // Compare merge-base through head, including both names of a rename/deletion.
    const mergeBase = git('merge-base', base, head).trim()
    const paths = git('diff', '--name-only', '--no-renames', '-z', mergeBase, head)
      .split('\0')
      .filter(Boolean)
    // A downstream source edit between the PR base and its merge checkout may affect an
    // upstream package too. Include that delta when testing the synthetic merge checkout.
    paths.push(
      ...git('diff', '--name-only', '--no-renames', '-z', head, 'HEAD').split('\0').filter(Boolean)
    )
    return createPackageTestPlan([...new Set(paths)], registry)
  } catch (error) {
    // Missing/invalid trusted policy or Git evidence may never skip tests.
    return {
      selected: ['packages'],
      excluded: [],
      reasons: [
        `package test evidence unavailable -> no exclusions: ${error.message.split('\n')[0]}`
      ]
    }
  }
}

export function runPackageTestCli(args = process.argv.slice(2), env = process.env) {
  const value = (flag) => args[args.indexOf(flag) + 1]
  if (!args.includes('--base') || !args.includes('--head'))
    throw new Error('--base and --head are required')
  const plan = packageTestPlanFromRevisions(
    value('--base'),
    value('--head'),
    args.includes('--trusted-base') ? value('--trusted-base') : value('--base')
  )
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n')
  if (args.includes('--github-env')) {
    if (!env.GITHUB_ENV) throw new Error('GITHUB_ENV is required')
    appendFileSync(
      env.GITHUB_ENV,
      `OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS=${JSON.stringify(plan.excluded)}\n` +
        `OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS=${JSON.stringify(plan.selected)}\n`
    )
  }
  return plan
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  runPackageTestCli()
