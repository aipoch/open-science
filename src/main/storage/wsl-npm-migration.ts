import { spawn } from 'node:child_process'
import { lstat, readdir } from 'node:fs/promises'
import { join, resolve, win32 } from 'node:path'
import type { WslSelection } from '../../shared/wsl-setup'

export const npmMigrationPath = (root: string): string => join(root, 'runtime', 'npm')

export type NpmMigrationEntry = {
  path: string
  kind: 'dir' | 'file' | 'link'
  mode: number
  atime: number
  mtime: number
  size: number
  hash?: string
  target?: string
}

// Only a Windows-hosted Linux prefix needs guest filesystem semantics. Native npm trees do not
// acquire a dependency on WSL. Ancestor operations (notably runtime cleanup) use the same adapter.
export const needsWslNpmMigration = async (
  root: string,
  dirs: readonly string[]
): Promise<boolean> => {
  if (process.platform !== 'win32') return false
  const npm = npmMigrationPath(root)
  if (!dirs.some((dir) => [resolve(root, 'runtime'), npm].includes(resolve(root, dir)))) {
    return false
  }
  try {
    if (!(await lstat(npm)).isDirectory()) return false
    return (await readdir(npm)).some((name) => /^linux-[a-z0-9]+$/.test(name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export type NpmMigration = {
  scan(root: string): Promise<NpmMigrationEntry[]>
  copy(from: string, to: string): Promise<void>
  restore(root: string, entries: NpmMigrationEntry[]): Promise<void>
  remove(root: string): Promise<void>
}

export class WslNpmMigrationError extends Error {}

export const requireNpmMigration = (migration?: NpmMigration): NpmMigration => {
  if (!migration)
    throw new WslNpmMigrationError('Moving WSL npm tools requires the configured WSL environment.')
  return migration
}

// Python is already required by the activated WSL profile. Run in isolated mode, pass paths through
// stdin/wslpath rather than a shell, and never run package code. Windows cannot even read every LX
// reparse point, so scan, copy, verification, and cleanup must all use guest filesystem semantics.
const program = String.raw`
import hashlib, json, os, shutil, stat, subprocess, sys
request = json.load(sys.stdin)
def root(value):
    path = subprocess.check_output(['/usr/bin/wslpath', '-a', '-u', value], text=True).strip()
    if os.path.realpath(path) != path:
        raise ValueError('Redirected npm migration root')
    return path
source = root(request['root'])
def entry_path(base, value):
    if value == '': return base
    if value.startswith('/') or any(p in ('', '.', '..') for p in value.split('/')):
        raise ValueError('Unsafe npm metadata path')
    return os.path.join(base, value)
def scan(base):
    result = []
    def walk(path, relative):
        info = os.lstat(path)
        item = dict(path=relative, mode=stat.S_IMODE(info.st_mode),
                    atime=info.st_atime_ns / 1000000, mtime=info.st_mtime_ns / 1000000,
                    size=info.st_size)
        if stat.S_ISLNK(info.st_mode):
            target = os.readlink(path)
            resolved = os.path.realpath(path)
            if os.path.isabs(target) or os.path.commonpath([base, resolved]) != base:
                raise ValueError('npm symbolic link points outside the data being moved: ' + relative)
            item.update(kind='link', target=target)
        elif stat.S_ISDIR(info.st_mode):
            item['kind'] = 'dir'
        elif stat.S_ISREG(info.st_mode):
            digest = hashlib.sha256()
            with open(path, 'rb') as file:
                for block in iter(lambda: file.read(1024 * 1024), b''): digest.update(block)
            item.update(kind='file', hash=digest.hexdigest())
        else:
            raise ValueError('Unsupported npm migration entry: ' + relative)
        result.append(item)
        if item['kind'] == 'dir':
            for name in os.listdir(path):
                if '\\' in name or ':' in name:
                    raise ValueError('npm filename cannot be represented in a Windows inventory')
                walk(os.path.join(path, name), relative + '/' + name if relative else name)
    walk(base, '')
    return result
def restore(base, entries):
    for item in reversed(entries):
        if item['kind'] == 'link': continue
        path = entry_path(base, item['path'])
        if os.path.islink(path): raise ValueError('npm metadata path became a link')
        os.chmod(path, item['mode'])
        os.utime(path, ns=(round(item['atime'] * 1000000), round(item['mtime'] * 1000000)))
operation = request['operation']
if operation == 'scan':
    entries = scan(source)
    restore(source, entries)
    print(json.dumps(entries))
elif operation == 'copy':
    entries = scan(source)
    destination = root(request['target'])
    links = {}
    def copy_file(src, dst):
        info = os.stat(src, follow_symlinks=False)
        identity = (info.st_dev, info.st_ino)
        if info.st_nlink > 1 and identity in links:
            try:
                os.link(links[identity], dst)
                return dst
            except OSError: pass
        shutil.copy2(src, dst, follow_symlinks=False)
        links[identity] = dst
        return dst
    try:
        shutil.copytree(source, destination, symlinks=True, copy_function=copy_file)
        copied = scan(destination)
        def content(items):
            return sorted((i['path'], i['kind'], i.get('hash'), i.get('target')) for i in items)
        if content(entries) != content(copied): raise ValueError('npm copy verification failed')
        restore(destination, entries)
    finally:
        restore(source, entries)
elif operation == 'restore':
    restore(source, request['entries'])
elif operation == 'remove':
    if os.path.lexists(source):
        if os.path.islink(source): raise ValueError('Refused redirected npm cleanup')
        shutil.rmtree(source)
else:
    raise ValueError('Unknown npm migration operation')
`

export const createWslNpmMigration = (
  readSelection: () => Promise<WslSelection | undefined>
): NpmMigration => {
  const run = async (operation: string, root: string, extra: object = {}): Promise<string> => {
    const selection = await readSelection()
    if (!selection)
      throw new WslNpmMigrationError(
        'Moving WSL npm tools requires the configured WSL environment.'
      )
    return new Promise((resolveResult, reject) => {
      const child = spawn(
        win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe'),
        [
          '-d',
          selection.distro,
          '-u',
          selection.user,
          '--cd',
          '/',
          '--exec',
          '/usr/bin/python3',
          '-I',
          '-c',
          program
        ],
        { windowsHide: true, stdio: 'pipe' }
      )
      let stdout = ''
      let stderr = ''
      let transportError: Error | undefined
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
      child.on('error', (error) => {
        transportError = error
      })
      child.stdin.on('error', (error) => {
        transportError = error
      })
      // Wait for guest completion even if the user cancels a move: rollback must never race a
      // surviving guest copier. The migration engine checks cancellation before/after this call.
      child.on('close', (code) =>
        code === 0 && !transportError
          ? resolveResult(stdout)
          : reject(
              new WslNpmMigrationError(
                `WSL npm migration ${operation} failed: ${transportError?.message || stderr || stdout || code}`
              )
            )
      )
      child.stdin.end(JSON.stringify({ operation, root: npmMigrationPath(root), ...extra }))
    })
  }
  return {
    scan: async (root) => JSON.parse(await run('scan', root)) as NpmMigrationEntry[],
    copy: async (from, to) => {
      await run('copy', from, { target: npmMigrationPath(to) })
    },
    restore: async (root, entries) => {
      await run('restore', root, { entries })
    },
    remove: async (root) => {
      await run('remove', root)
    }
  }
}
