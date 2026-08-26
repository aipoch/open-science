# Minimal fake exec-loop for driving NotebookKernelExecutor tests without a real conda env. Speaks
# both the Python JSON-lines and R length-prefixed request protocols, then writes one JSON response
# per line.
# Special codes drive the timeout paths:
#   __SLEEP__          sleep, but catch the SIGINT-raised KeyboardInterrupt and still reply (soft path)
#   __IGNORE_SIGINT__  ignore SIGINT entirely and sleep, forcing the driver's hard SIGKILL path
#   __CANCEL_RESPONSE_BEFORE_ACK__  reply before a simulated late interrupt reaches the next request
#   __SET_NAMESPACE__ / __CHECK_NAMESPACE__  prove process-local state survives a cancellation probe
#   __MASK_SYS_SLEEP__  simulate user code masking Sys.sleep in the persistent R namespace
#   __CANCEL_CAUGHT_INTERRUPT__  simulate user code catching SIGINT before the outer R handler
#   __FIGURE__         write a real 1x1 PNG into the figures dir and reference it in the response
#   __OVERSIZED_LINE__:<bytes>  write an unframed stdout line of the requested size
#   __WRITE_FILE__      write an output file into the kernel working directory
#   __WRITE_HANDOFF_FILE__ write an output file into the shared handoff directory
#   __OVERWRITE_FILE__  replace a pre-existing output in the kernel working directory
#   __WRITE_DELAYED_A__ / __WRITE_DELAYED_B__ overlap two kernels writing the same data root
import base64
import json
import os
import signal
import sys
import time

_FIGURES_DIR = os.environ.get("OPEN_SCIENCE_KERNEL_FIGURES_DIR", "")
# A real 1x1 PNG so the driver's read+base64 path exercises actual image bytes.
_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
)


def _respond(req_id, code, error=None, interrupt_ack=False, namespace=None):
    figures = []
    if code == "__FIGURE__" and _FIGURES_DIR:
        path = os.path.join(_FIGURES_DIR, "fake.png")
        with open(path, "wb") as handle:
            handle.write(_PNG)
        figures = [{"mime": "image/png", "path": path}]
    if code == "__WRITE_FILE__":
        with open("generated.csv", "w", encoding="utf-8") as handle:
            handle.write("x,y\n1,2\n")
    if code == "__WRITE_HANDOFF_FILE__":
        handoff_dir = os.environ["OPEN_SCIENCE_HANDOFF_DIR"]
        with open(os.path.join(handoff_dir, "generated.csv"), "w", encoding="utf-8") as handle:
            handle.write("x,y\n1,2\n")
    if code == "__OVERWRITE_FILE__":
        previous = os.stat("generated.csv")
        with open("generated.csv", "w", encoding="utf-8") as handle:
            handle.write("x,y\n3,4\n")
        os.utime("generated.csv", ns=(previous.st_atime_ns, previous.st_mtime_ns))
    if code in ("__WRITE_DELAYED_A__", "__WRITE_DELAYED_B__"):
        time.sleep(0.1)
        suffix = code.removeprefix("__WRITE_DELAYED_").removesuffix("__").lower()
        with open(f"generated-{suffix}.csv", "w", encoding="utf-8") as handle:
            handle.write("x,y\n1,2\n")
    response = {
        "req_id": req_id,
        "stdout": code,
        "stderr": "",
        "error": error,
        "interrupt_ack": interrupt_ack,
        "result": None,
        "cwd": os.getcwd(),
        "figures": figures,
    }
    if namespace is not None:
        response["namespace"] = namespace
    sys.stdout.write(json.dumps(response) + "\n")
    sys.stdout.flush()


def main():
    late_interrupt_pending = False
    namespace_value = None
    sys_sleep_masked = False
    stream = sys.stdin.buffer
    while True:
        line = stream.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception:
            try:
                parts = line.decode("utf-8").split(" ")
                req_id, raw_length = parts[:2]
                request = {
                    "req_id": req_id,
                    "code": stream.read(int(raw_length)).decode("utf-8"),
                    "operation": parts[2] if len(parts) > 2 else "execute",
                }
            except Exception:
                continue
        code = request.get("code", "")
        req_id = request.get("req_id")
        if request.get("operation") == "inspect_namespace":
            include_private = request.get("include_private") is True or code == "private"
            variables = [
                {"name": "answer", "type": "int", "size_bytes": 28, "preview": "42"}
            ]
            if include_private:
                variables.append(
                    {"name": "_private", "type": "str", "preview": "'hidden'", "is_private": True}
                )
            _respond(
                req_id,
                code,
                namespace={
                    "variable_count": len(variables),
                    "variables_truncated": False,
                    "variables": variables,
                },
            )
            continue
        if late_interrupt_pending:
            if code == "Sys.sleep(0.05)" and sys_sleep_masked:
                late_interrupt_pending = False
                namespace_value = None
                _respond(req_id, code, error="user-masked Sys.sleep was invoked")
                continue
            late_interrupt_pending = False
            _respond(req_id, code, error="interrupted", interrupt_ack=True)
            continue
        if code == "__IGNORE_SIGINT__":
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            time.sleep(30)
            continue
        if code.startswith("__OVERSIZED_LINE__:"):
            remaining = int(code.split(":", 1)[1])
            chunk = "x" * (64 * 1024)
            while remaining > 0:
                written = min(remaining, len(chunk))
                sys.stdout.write(chunk[:written])
                sys.stdout.flush()
                remaining -= written
            continue
        if code == "__CANCEL_RESPONSE_BEFORE_ACK__":
            time.sleep(0.1)
            _respond(req_id, code)
            late_interrupt_pending = True
            continue
        if code == "__CANCEL_CAUGHT_INTERRUPT__":
            time.sleep(0.1)
            _respond(req_id, code)
            continue
        if code == "__SET_NAMESPACE__":
            namespace_value = 41
        if code == "__MASK_SYS_SLEEP__":
            sys_sleep_masked = True
        if code == "__CHECK_NAMESPACE__" and namespace_value != 41:
            _respond(req_id, code, error="namespace was not preserved")
            continue
        if code == "__SLEEP__":
            try:
                time.sleep(30)
            except KeyboardInterrupt:
                pass
        _respond(req_id, code)


if __name__ == "__main__":
    main()
