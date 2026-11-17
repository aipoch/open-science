import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { MemoryPolicyError } from './memory-policy'
import type { LinuxMemoryReader } from './memory-policy-linux'

// The original WSL launch owner supplies this read-only helper process. It must
// run outside the workload's namespaces; PID/birth ownership is checked by the
// caller and LinuxMemoryPolicyAdapter, never inferred from the helper's self PID.
export const wslMemoryReaderProgram = String.raw`
import ctypes, json, os, re, signal, stat, struct, sys

if sys.platform != 'linux' or struct.calcsize('P') != 8:
    sys.exit(78)
MAX_FILE = 128 * 1024
MAX_LINE, MAX_TOTAL = 800 * 1024, 16 * 1024 * 1024
PROCFS, NSFS = 0x9fa0, 0x6e736673
INITIAL_CGROUP_NS = 4026531835
# The guest exits even if its Windows wsl.exe transport is terminated without
# forwarding EOF. This is a single bounded sample, not a resident process.
signal.signal(signal.SIGALRM, lambda *_: os._exit(124))
signal.alarm(6)
libc = ctypes.CDLL(None, use_errno=True)
libc.fstatfs.argtypes = [ctypes.c_int, ctypes.c_void_p]
libc.fstatfs.restype = ctypes.c_int
pins = {}
next_pin = 0

def fs_type(fd):
    # Larger than struct statfs on both supported Linux 64-bit ABIs. The kernel
    # fills the native struct; f_type is its first signed native long.
    value = ctypes.create_string_buffer(256)
    if libc.fstatfs(fd, ctypes.byref(value)) != 0:
        raise ValueError('filesystem unavailable')
    return ctypes.c_long.from_buffer(value).value

def checked_open(path, expected):
    if not isinstance(path, str) or not path.startswith('/') or '\x00' in path:
        raise ValueError('invalid path')
    if any(part in ('.', '..') for part in path.split('/')):
        raise ValueError('invalid path')
    proof = expected is None
    if proof and not re.fullmatch(r'/tmp/\.open-science-execution-[0-9a-fA-F-]{36}\.receipt\.memory', path):
        raise ValueError('invalid proof path')
    if not proof and expected not in (PROCFS, 0x27e0eb, 0x63677270):
        raise ValueError('invalid filesystem')
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | (os.O_NOFOLLOW | os.O_NONBLOCK if proof else 0))
    try:
        if proof:
            identity = os.fstat(fd)
            if not stat.S_ISREG(identity.st_mode) or identity.st_uid != os.geteuid() or identity.st_nlink != 1:
                raise ValueError('invalid proof file')
        if not proof and fs_type(fd) != expected:
            raise ValueError('wrong filesystem')
        return fd
    except BaseException:
        os.close(fd)
        raise

def read_fact(path, expected):
    fd = checked_open(path, expected)
    try:
        result = bytearray()
        limit = 4096 if expected is None else MAX_FILE
        while len(result) <= limit:
            chunk = os.read(fd, min(16384, limit + 1 - len(result)))
            if not chunk:
                return bytes(result)
            result.extend(chunk)
        raise ValueError('oversized fact')
    finally:
        os.close(fd)

def process_identity(root, pid):
    value = read_fact(root + '/stat', PROCFS).decode('ascii')
    closing = value.rfind(') ')
    fields = value[closing + 2:].split() if closing >= 0 else []
    if not value.startswith(str(pid) + ' (') or len(fields) <= 19 or not fields[19].isdigit():
        raise ValueError('invalid process identity')
    return (fields[19], read_fact(root + '/cgroup', PROCFS))

def process_snapshot(pid):
    return process_identity('/proc/' + str(pid), pid)

def process_children(pid, budget, expected_cgroup):
    root = '/proc/' + str(pid) + '/task'
    fd = checked_open(root, PROCFS)
    tasks = []
    try:
        with os.scandir(fd) as entries:
            for entry in entries:
                if not entry.name.isdigit():
                    raise ValueError('invalid task identity')
                tasks.append(entry.name)
                budget[0] += 1
                if len(tasks) > 64 or budget[0] > 1024:
                    raise ValueError('execution tree exceeds task bound')
    finally:
        os.close(fd)
    children = set()
    identities = []
    for task in tasks:
        task_root = root + '/' + task
        identity = process_identity(task_root, int(task))
        if identity[1] != expected_cgroup:
            raise ValueError('execution thread changed cgroup')
        identities.append((task, identity))
        value = read_fact(task_root + '/children', PROCFS).decode('ascii')
        for child in value.split():
            if not child.isdigit() or int(child) <= 0:
                raise ValueError('invalid child identity')
            children.add(int(child))
            if len(children) > 256:
                raise ValueError('execution tree exceeds process bound')
    return (tuple(sorted(identities)), tuple(sorted(children)))

def validate_tree(request):
    pid, birth, token = request.get('pid'), request.get('birth'), request.get('token')
    if type(pid) is not int or pid <= 0 or not isinstance(birth, str) or not birth.isdigit():
        raise ValueError('invalid original process identity')
    if not isinstance(token, str) or not re.fullmatch(r'open-science-execution-[0-9a-fA-F-]{36}', token):
        raise ValueError('invalid original process token')
    anchor = process_snapshot(pid)
    if anchor[0] != birth:
        raise ValueError('original process changed')
    environment = read_fact('/proc/' + str(pid) + '/environ', PROCFS).split(b'\0')
    expected = b'OPEN_SCIENCE_WSL_EXECUTION_TOKEN=' + token.encode('ascii')
    matches = [entry for entry in environment if entry.startswith(b'OPEN_SCIENCE_WSL_EXECUTION_TOKEN=')]
    if matches != [expected]:
        raise ValueError('original process token changed')
    snapshots, queue, budget = {}, [pid], [0]
    while queue:
        current = queue.pop()
        if current in snapshots:
            raise ValueError('execution tree is ambiguous')
        identity = process_snapshot(current)
        if identity[1] != anchor[1]:
            raise ValueError('execution process changed cgroup')
        children = process_children(current, budget, anchor[1])
        snapshots[current] = (identity, children)
        queue.extend(children[1])
        if len(snapshots) + len(queue) > 256:
            raise ValueError('execution tree exceeds process bound')
    if len(snapshots) < 2:
        raise ValueError('original workload is not present')
    after_budget = [0]
    for current, (identity, children) in snapshots.items():
        if process_snapshot(current) != identity or process_children(current, after_budget, anchor[1]) != children:
            raise ValueError('execution tree changed during sampling')
    if process_snapshot(pid) != anchor:
        raise ValueError('original process changed')
    return None

def dispatch(request):
    global next_pin
    operation = request.get('op')
    if operation == 'read':
        expected = request.get('expectedFs')
        return read_fact(request.get('path'), None if expected is None else int(expected)).decode('utf-8')
    if operation == 'pinNamespace':
        proc = checked_open('/proc', PROCFS)
        os.close(proc)
        fd = os.open('/proc/self/ns/cgroup', os.O_RDONLY | os.O_CLOEXEC)
        try:
            identity = os.fstat(fd)
            if fs_type(fd) != NSFS or identity.st_ino != INITIAL_CGROUP_NS:
                raise ValueError('hidden cgroup ancestors')
            next_pin += 1
            pins[next_pin] = fd
            return {'pin': next_pin, 'identity': str(identity.st_dev) + ':' + str(identity.st_ino)}
        except BaseException:
            os.close(fd)
            raise
    if operation == 'closeNamespace':
        os.close(pins.pop(request.get('pin')))
        return None
    if operation == 'pageSize':
        auxv = read_fact('/proc/self/auxv', PROCFS)
        pair = struct.Struct('@LL')
        if pair.size != 16 or len(auxv) % pair.size:
            raise ValueError('unsupported auxv ABI')
        for offset in range(0, len(auxv), pair.size):
            key, value = pair.unpack_from(auxv, offset)
            if key == 0:
                break
            if key == 6 and value > 0 and value & (value - 1) == 0:
                return value
        raise ValueError('page size unavailable')
    if operation == 'validateExecutionTree':
        return validate_tree(request)
    raise ValueError('invalid operation')

try:
    output_bytes = 0
    while True:
        line = sys.stdin.buffer.readline(8193)
        if not line:
            break
        if len(line) > 8192 or not line.endswith(b'\n'):
            break
        try:
            request = json.loads(line)
        except ValueError:
            break
        if not isinstance(request, dict) or type(request.get('id')) is not int:
            break
        try:
            response = {'id': request['id'], 'ok': True, 'value': dispatch(request)}
        except (OSError, ValueError, KeyError, TypeError, OverflowError):
            response = {'id': request['id'], 'ok': False}
        encoded = json.dumps(response, ensure_ascii=True, separators=(',', ':')) + '\n'
        output_bytes += len(encoded)
        if len(encoded) > MAX_LINE or output_bytes > MAX_TOTAL:
            break
        sys.stdout.write(encoded)
        sys.stdout.flush()
finally:
    for fd in pins.values():
        os.close(fd)
`

const unavailable = (): MemoryPolicyError =>
  new MemoryPolicyError(
    'linux-memory-unavailable',
    'The authenticated WSL memory reader is unavailable; repair the execution runtime.'
  )

export const createWslMemoryReader = (
  child: ChildProcessWithoutNullStreams,
  signal: AbortSignal
): {
  reader: LinuxMemoryReader
  validateExecutionTree(
    owner: { pid: number; birth: string; token: string },
    signal: AbortSignal
  ): Promise<void>
  close(): Promise<void>
} => {
  let nextId = 0
  let buffered = ''
  let outputBytes = 0
  let stderrBytes = 0
  let stopped = false
  let terminated = false
  let exited = false
  let closePromise: Promise<void> | undefined
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  let resolveExit: () => void
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve
  })

  const rejectPending = (): void => {
    for (const request of pending.values()) request.reject(unavailable())
    pending.clear()
  }
  const stop = (): void => {
    if (stopped) return
    stopped = true
    terminated = true
    rejectPending()
    child.stdin.end()
    child.kill()
  }
  const onData = (chunk: Buffer): void => {
    if (stopped) return
    outputBytes += chunk.length
    if (outputBytes > 16 * 1024 * 1024) return stop()
    buffered += chunk.toString('utf8')
    while (buffered.includes('\n')) {
      const end = buffered.indexOf('\n')
      // A UTF-8 character may expand to six JSON escape bytes in the Python reply.
      if (end + 1 > 800 * 1024) return stop()
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      try {
        const response: unknown = JSON.parse(line)
        if (!response || typeof response !== 'object') return stop()
        const { id, ok, value } = response as Record<string, unknown>
        if (typeof id !== 'number' || typeof ok !== 'boolean' || !pending.has(id)) return stop()
        const request = pending.get(id)!
        pending.delete(id)
        if (ok) request.resolve(value)
        else request.reject(unavailable())
      } catch {
        return stop()
      }
    }
    if (Buffer.byteLength(buffered) > 800 * 1024) stop()
  }
  const onStderr = (chunk: Buffer): void => {
    stderrBytes += chunk.length
    if (stderrBytes > 16 * 1024) stop()
  }
  const onExit = (): void => {
    exited = true
    stopped = true
    rejectPending()
    resolveExit()
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onStderr)
  child.on('close', onExit)
  child.on('error', stop)
  child.stdin.on('error', stop)
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()

  const request = (
    operation: Record<string, unknown>,
    requestSignal = signal
  ): Promise<unknown> => {
    if (stopped || requestSignal.aborted) return Promise.reject(unavailable())
    return new Promise((resolve, reject) => {
      const id = ++nextId
      const line = `${JSON.stringify({ id, ...operation })}\n`
      if (Buffer.byteLength(line) > 8192) {
        reject(unavailable())
        return
      }
      const abortRequest = (): void => stop()
      if (requestSignal !== signal)
        requestSignal.addEventListener('abort', abortRequest, { once: true })
      pending.set(id, {
        resolve: (value) => {
          if (requestSignal !== signal) requestSignal.removeEventListener('abort', abortRequest)
          resolve(value)
        },
        reject: (error) => {
          if (requestSignal !== signal) requestSignal.removeEventListener('abort', abortRequest)
          reject(error)
        }
      })
      child.stdin.write(line, (error) => {
        if (error) stop()
      })
    })
  }
  const reader: LinuxMemoryReader = {
    read: async (path, requestSignal, expectedFs) => {
      const value = await request(
        { op: 'read', path, expectedFs: expectedFs?.toString() },
        requestSignal
      )
      if (typeof value !== 'string' || Buffer.byteLength(value) > 128 * 1024) throw unavailable()
      return value
    },
    pinInitialNamespace: async (requestSignal) => {
      const value = await request({ op: 'pinNamespace' }, requestSignal)
      if (!value || typeof value !== 'object') throw unavailable()
      const { identity, pin } = value as Record<string, unknown>
      if (typeof identity !== 'string' || !/^\d+:4026531835$/.test(identity)) throw unavailable()
      if (typeof pin !== 'number' || !Number.isSafeInteger(pin) || pin <= 0) throw unavailable()
      let closed = false
      return {
        identity,
        close: async () => {
          if (closed || stopped) return
          closed = true
          await request({ op: 'closeNamespace', pin })
        }
      }
    },
    pageSize: async (requestSignal) => {
      const value = await request({ op: 'pageSize' }, requestSignal)
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        (value & (value - 1)) !== 0
      )
        throw unavailable()
      return value
    }
  }
  return {
    reader,
    validateExecutionTree: async (owner, requestSignal) => {
      const value = await request({ op: 'validateExecutionTree', ...owner }, requestSignal)
      if (value !== null) throw unavailable()
    },
    close: () => {
      closePromise ??= (async () => {
        stopped = true
        rejectPending()
        child.stdin.end()
        const wait = (milliseconds: number): Promise<void> =>
          new Promise((resolve) => {
            const timer = setTimeout(resolve, milliseconds)
            exit.then(() => {
              clearTimeout(timer)
              resolve()
            })
          })
        await wait(250)
        if (!exited) {
          terminated = true
          child.kill()
          await wait(250)
        }
        if (!exited) {
          child.kill('SIGKILL')
          await wait(250)
        }
        signal.removeEventListener('abort', stop)
        child.stdout.off('data', onData)
        child.stderr.off('data', onStderr)
        // Keep error listeners until Node emits close after a failed spawn/kill.
        if (!exited || terminated || child.exitCode !== 0) throw unavailable()
      })()
      return closePromise
    }
  }
}
