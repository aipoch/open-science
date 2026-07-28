# Minimal fake exec-loop for driving NotebookKernelExecutor tests without a real conda env. Speaks
# the python_loop.py wire protocol: reads one JSON request per line, writes one JSON response per line.
# Special codes drive the timeout paths:
#   __SLEEP__          sleep, but catch the SIGINT-raised KeyboardInterrupt and still reply (soft path)
#   __IGNORE_SIGINT__  ignore SIGINT entirely and sleep, forcing the driver's hard SIGKILL path
#   __FIGURE__         write a real 1x1 PNG into the figures dir and reference it in the response
#   __WRITE_FILE__      write an output file into the kernel working directory
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


def _respond(req_id, code):
    figures = []
    if code == "__FIGURE__" and _FIGURES_DIR:
        path = os.path.join(_FIGURES_DIR, "fake.png")
        with open(path, "wb") as handle:
            handle.write(_PNG)
        figures = [{"mime": "image/png", "path": path}]
    if code == "__WRITE_FILE__":
        with open("generated.csv", "w", encoding="utf-8") as handle:
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
    sys.stdout.write(
        json.dumps(
            {
                "req_id": req_id,
                "stdout": code,
                "stderr": "",
                "error": None,
                "result": None,
                "cwd": os.getcwd(),
                "figures": figures,
            }
        )
        + "\n"
    )
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception:
            continue
        code = request.get("code", "")
        req_id = request.get("req_id")
        if code == "__IGNORE_SIGINT__":
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            time.sleep(30)
            continue
        if code == "__SLEEP__":
            try:
                time.sleep(30)
            except KeyboardInterrupt:
                pass
        _respond(req_id, code)


if __name__ == "__main__":
    main()
