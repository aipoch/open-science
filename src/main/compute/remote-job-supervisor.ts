// Linux child-subreaper: orphaned descendants remain children of this job owner across setsid and
// double-fork. Only this owner reaps/signals its children; a child's PID cannot be reused before reap.
// https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html
export const remoteJobSupervisorSource = String.raw`import ctypes
import os
import signal
import subprocess
import sys
import time

os.umask(0o077)
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, ctypes.c_ulong(1), ctypes.c_ulong(0), ctypes.c_ulong(0), ctypes.c_ulong(0)) != 0:
    raise OSError(ctypes.get_errno(), "Cannot establish job child ownership")

def publish(name, value):
    with open(name + ".tmp", "w") as stream:
        stream.write(value + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(name + ".tmp", name)

def read(name):
    try:
        with open(name) as stream:
            return stream.read().strip()
    except FileNotFoundError:
        return ""

pid = os.getpid()
birth = read("/proc/self/stat").rsplit(")", 1)[1].split()[19]
identity = "supervisor-v1 %s %s %s" % (read("/proc/sys/kernel/random/boot_id"), pid, birth)
requested = False

def request_stop(signum, frame):
    global requested
    requested = True

signal.signal(signal.SIGTERM, request_stop)
signal.signal(signal.SIGINT, request_stop)
signal.signal(signal.SIGHUP, signal.SIG_IGN)
signal.signal(signal.SIGCHLD, signal.SIG_DFL)
publish("execution.scope", identity)
publish("job.pid", str(pid))
deadline = time.monotonic() + int(sys.argv[1])
stopping = None
kill_after = None
term_sent = set()
timed_out = False
root = None
result = 143
with open("stdout", "wb") as stdout, open("stderr", "wb") as stderr:
    if not requested and read("execution.cancel") != identity:
        try:
            root = subprocess.Popen(["bash", "-l", "-c", "if [ -r ~/.bashrc ]; then . ~/.bashrc || exit $?; fi; exec bash command.sh"], stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, start_new_session=True)
        except OSError as error:
            stderr.write((str(error) + "\n").encode())
            result = 127
    while True:
        # ECHILD is the completion proof, including adopted orphan descendants, not just root exit.
        empty = False
        while True:
            try:
                child, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                empty = True
                break
            if child == 0:
                break
            term_sent.discard(child)
            if root is not None and child == root.pid:
                result = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)
                root.returncode = result
        if empty:
            break
        now = time.monotonic()
        cancel_requested = requested or read("execution.cancel") == identity
        if stopping is None and (cancel_requested or now >= deadline):
            stopping = now
            timed_out = not cancel_requested and now >= deadline
            # Preserve timeout(1)'s existing 30-second cleanup grace. Explicit cancellation is
            # bounded separately, including a cancellation received during timeout cleanup.
            kill_after = now + (30 if timed_out else 3)
        if stopping is not None:
            if cancel_requested:
                kill_after = min(kill_after, now + 3)
            sig = signal.SIGKILL if now >= kill_after else signal.SIGTERM
            # Signal only immediate, unreaped children. Killing parents adopts the next generation;
            # repeat until waitpid proves no children. No global process scan or unsafe PID fallback.
            children = read("/proc/%s/task/%s/children" % (pid, pid)).split()
            for child in children:
                child = int(child)
                # Repeated TERM can re-enter a checkpoint handler and prevent it finishing.
                # PID identity stays pinned until our next reap; adopted children get one TERM.
                if sig == signal.SIGTERM and child in term_sent:
                    continue
                try:
                    os.kill(child, sig)
                    if sig == signal.SIGTERM:
                        term_sent.add(child)
                except ProcessLookupError:
                    pass
                except PermissionError:
                    pass  # Keep waiting; never publish completion while a child remains.
        time.sleep(0.1)
publish("exit_code", str(124 if timed_out else result))
publish("execution.stopped", identity)
`
