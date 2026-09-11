"""Read-only /proc inspection. Never opens migration files or changes processes/permissions."""
import errno
import json
import os
import re
import sys
import time

request = json.load(sys.stdin)
roots = [os.path.realpath(root) for root in request['roots']]
ignored = {os.getpid(), request['ownerPid']}
occupied = []
errors = []
permission_denied = False
identities = set()
mapped_groups = set()
root_names = set(roots)
root_prefixes = tuple(root.rstrip('/') + '/' for root in roots)
deadline = time.monotonic() + 25


def check_budget():
    if time.monotonic() >= deadline:
        raise TimeoutError('Task inspection did not finish within its budget; stop writers and retry')


def fail(path, error):
    global permission_denied
    permission_denied |= getattr(error, 'errno', None) in (errno.EACCES, errno.EPERM)
    errors.append('Cannot inspect ' + path + ': ' + str(error))


def identity(base):
    with open(base + '/stat') as stream:
        # comm can contain spaces and parentheses. Fields after its final ')' start at state (3).
        fields = stream.read().rsplit(')', 1)[1].split()
    return fields[19], fields[0], int(fields[6])  # starttime (22), state, flags (9)


def record(pid, descriptor, path, file_identity=None):
    if path.endswith(' (deleted)'):
        path = path[:-10]
    if file_identity in identities or path in root_names or path.startswith(root_prefixes):
        occupied.append({'pid': pid, 'descriptor': descriptor})


def inspect_thread(pid, base, expected_start, group):
    before = identity(base)
    if before[0] != expected_start:
        errors.append('Task identity changed before inspection: ' + base)
        return
    # Zombies have already released files; PF_KTHREAD is kernel evidence, not a UID/argv guess.
    if before[1] in ('Z', 'X') or before[2] & 0x00200000:
        return
    local_errors = []
    for name in ('cwd', 'root', 'exe'):
        try:
            path = base + '/' + name
            node = os.stat(path)
            record(pid, name, os.readlink(path), (node.st_dev, node.st_ino))
        except OSError as error:
            local_errors.append((base + '/' + name, error))
    try:
        for fd in os.listdir(base + '/fd'):
            try:
                path = base + '/fd/' + fd
                node = os.stat(path)
                record(pid, 'fd/' + fd, os.readlink(path), (node.st_dev, node.st_ino))
            except FileNotFoundError:
                pass  # Descriptor closed between enumeration and readlink.
            except OSError as error:
                local_errors.append((base + '/fd/' + fd, error))
    except OSError as error:
        local_errors.append((base + '/fd', error))
    maps_read = False
    if group not in mapped_groups:
        try:
            with open(base + '/maps') as stream:
                for line in stream:
                    fields = line.rstrip('\n').split(None, 5)
                    if len(fields) == 6:
                        # proc maps escapes newline as octal, unlike fd/cwd readlink.
                        path = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), fields[5])
                        device = fields[3].split(':')
                        record(pid, 'maps', path, (os.makedev(int(device[0], 16), int(device[1], 16)), int(fields[4])))
            # CLONE_THREAD requires CLONE_VM: all live threads share this mapping table.
            # Only a complete read is reusable, within this probe and this process identity.
            # cwd and descriptors can be unshared and are still inspected for every thread.
            maps_read = True
        except OSError as error:
            local_errors.append((base + '/maps', error))
    try:
        after = identity(base)
    except FileNotFoundError:
        return  # The task exited; it can no longer hold these resources.
    if before != after and (before[0] != after[0] or after[1] in ('Z', 'X')):
        if before[0] != after[0]:
            errors.append('Process identity changed during inspection: ' + base)
        return
    if maps_read:
        mapped_groups.add(group)
    for path, error in local_errors:
        fail(path, error)


def index_tree(path):
    check_budget()
    node = os.lstat(path)
    identities.add((node.st_dev, node.st_ino))
    if not os.path.islink(path) and os.path.isdir(path):
        for name in os.listdir(path):
            index_tree(os.path.join(path, name))


try:
    # Identity matching also catches open hardlinks, renamed files and alternate bind-mount paths.
    for root in roots:
        try:
            index_tree(root)
        except FileNotFoundError:
            if os.path.lexists(root):
                raise
    # hidepid can omit whole PIDs without a permission error. Such a partial view is not proof.
    with open('/proc/mounts') as stream:
        proc_mounts = [line.split() for line in stream if line.split()[1] == '/proc']
    if len(proc_mounts) != 1 or proc_mounts[0][2] != 'proc' or any(
        option.startswith('hidepid=') and option not in ('hidepid=0', 'hidepid=off')
        for option in proc_mounts[0][3].split(',')
    ):
        raise RuntimeError('A complete /proc mount without hidepid is required')
    # Inspect every task, and re-enumerate identities rather than only PIDs. Threads may unshare
    # cwd/fds; a replaced PID or a new thread in an already inspected process must not disappear.
    def tasks():
        result = set()
        for name in os.listdir('/proc'):
            check_budget()
            if not name.isdigit() or int(name) in ignored:
                continue
            pid = int(name)
            base = '/proc/' + name
            try:
                leader = identity(base)
            except FileNotFoundError:
                continue
            except OSError as error:
                fail(base, error)
                continue
            try:
                tids = os.listdir(base + '/task')
                if not tids:
                    raise RuntimeError('Empty task inventory for a live process')
                for tid in tids:
                    thread = base + '/task/' + tid
                    try:
                        result.add((pid, leader[0], int(tid), identity(thread)[0]))
                    except FileNotFoundError:
                        pass
                    except OSError as error:
                        fail(thread, error)
            except (OSError, RuntimeError) as error:
                try:
                    # A dead leader can retain live threads. Only ESRCH/vanished identity proves
                    # the group disappeared; never infer this from the leader's Z state.
                    identity(base)
                except FileNotFoundError:
                    continue
                except OSError as remaining_error:
                    fail(base, remaining_error)
                fail(base + '/task', error)
        return result

    seen = set()
    # Leave room for reporting inside the parent's unchanged 30-second process timeout.
    while time.monotonic() < deadline:
        pending = tasks() - seen
        if not pending:
            break
        # execve can replace the shared mappings without changing the leader's starttime.
        # A later round containing new threads must therefore read the group's maps again.
        mapped_groups.clear()
        for pid, leader_start, tid, thread_start in sorted(pending):
            check_budget()
            base = '/proc/' + str(pid)
            thread = base + '/task/' + str(tid)
            try:
                if identity(base)[0] != leader_start:
                    errors.append('Process identity changed before inspection: ' + base)
                else:
                    inspect_thread(pid, thread, thread_start, (pid, leader_start))
            except FileNotFoundError:
                pass
            except OSError as error:
                fail(thread, error)
            seen.add((pid, leader_start, tid, thread_start))
            if errors:
                break
        if errors:
            # Incomplete inspection is already a refusal. Do not spend another full scan on
            # unreadable system threads; any authorized retry starts a fresh privileged probe.
            break
    else:
        errors.append('Task inventory kept changing during inspection; stop writers and retry')

except Exception as error:
    fail('/proc', error)

print(json.dumps({'version': 1, 'complete': not errors, 'permissionDenied': permission_denied,
                  'occupied': occupied, 'errors': errors[:12]}))
