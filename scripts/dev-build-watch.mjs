/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { buildDevPackages, packageBuildProjects } from './build-dev-packages.mjs'
import { createBackendBuilder } from './build-backend.mjs'

// Vite owns the file watcher and its lifetime. TypeScript owns the incremental build graph.
// Do not use electron-vite's process-killing watch hook: the Node runtime is independently owned.
export function devBuildWatch(root = process.cwd()) {
  let close = async () => {}
  return {
    name: 'open-science-dev-build-watch',
    apply: 'serve',
    configureServer(server) {
      const projects = packageBuildProjects(root)
      const frontendProjects = new Set()
      const includeProject = (project) => {
        if (!project || frontendProjects.has(project.root)) return
        frontendProjects.add(project.root)
        for (const ref of project.config.projectReferences ?? [])
          includeProject(projects.find((candidate) => candidate.configPath === resolve(ref.path)))
      }
      for (const project of projects) {
        const { name } = JSON.parse(readFileSync(resolve(project.root, 'package.json'), 'utf8'))
        if (
          server.config.optimizeDeps.include?.some((id) => id === name || id.startsWith(`${name}/`))
        )
          includeProject(project)
      }
      let closed = false
      let dirty = false
      let rendererDirty = false
      let force = false
      let timer
      let running
      let backend
      const reportError = (error) => server.config.logger.error(`[dev] ${error.message}`)
      const run = () => {
        if (running || closed) return
        running = (async () => {
          while (dirty && !closed) {
            dirty = false
            try {
              const forceBuild = force
              force = false
              await buildDevPackages({
                root,
                force: forceBuild,
                log: (message) => server.config.logger.info(message)
              })
              if (closed) break
              backend ??= await createBackendBuilder({ root, development: true })
              await backend.rebuild()
              if (closed || dirty) continue
              server.config.logger.info(
                '[dev] Build ready. Quit the development app normally, then restart npm run dev to load backend/main changes; the running backend was not restarted.'
              )
              if (rendererDirty) {
                rendererDirty = false
                // Restart only Vite, after this build completes. Its close hook awaits running.
                timer = setTimeout(() => {
                  void server.restart(true).catch(reportError)
                }, 0)
              }
            } catch (error) {
              reportError(error)
              server.config.logger.warn(
                '[dev] Build failed. Fix the error and save again; no reload was requested.'
              )
              break
            }
          }
        })().finally(() => {
          running = undefined
          if (dirty && !closed) timer = setTimeout(run, 100)
        })
      }
      const changed = (_event, path) => {
        path = resolve(path)
        const local = relative(root, path).split(sep).join('/')
        if (/\.(test|fixture|test-helper|test-support)\.[cm]?[jt]sx?$/.test(local)) return
        const project = projects.find((item) => path.startsWith(`${item.root}${sep}`))
        const packageSource =
          project &&
          /^(?:src\/|resources\/|assets\/|tsconfig(?:\.dev)?\.json$|package\.json$)/.test(
            relative(project.root, path).split(sep).join('/')
          )
        const graphChanged = local === 'tsconfig.packages.json'
        if (
          !graphChanged &&
          !packageSource &&
          !/^src\/(?:main|preload|shared)\//.test(local) &&
          !local.startsWith('packages/notebook-network-sandbox/src/')
        )
          return
        force ||= graphChanged || !!(packageSource && local.endsWith('/package.json'))
        rendererDirty ||= graphChanged
        rendererDirty ||= !!project && frontendProjects.has(project.root)
        dirty = true
        clearTimeout(timer)
        timer = setTimeout(run, 100)
      }
      server.watcher.add([
        resolve(root, 'tsconfig.packages.json'),
        ...projects.map((project) => project.root),
        resolve(root, 'src/main'),
        resolve(root, 'src/preload'),
        resolve(root, 'src/shared'),
        resolve(root, 'packages/notebook-network-sandbox/src')
      ])
      server.watcher.on('all', changed)
      close = async () => {
        closed = true
        clearTimeout(timer)
        server.watcher.off('all', changed)
        await running
        await backend?.dispose()
      }
    },
    async closeBundle() {
      await close()
    }
  }
}
