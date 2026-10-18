"""Independent OS evidence. Never return argv, environment variables or arbitrary errors."""
import json
import sys

import psutil


def snapshot():
    records = []
    for process in psutil.process_iter():
        if process.pid == 0:
            continue
        try:
            records.append({
                "pid": process.pid,
                "parentPid": process.ppid(),
                "created": process.create_time(),
                "status": process.status(),
            })
        except psutil.NoSuchProcess:
            continue
        except psutil.AccessDenied:
            # Keep unknown identities in the table. A selected identity cannot silently disappear.
            records.append({"pid": process.pid, "unknown": True})
    if not records:
        raise RuntimeError("empty snapshot")
    return records


def cleanup(identities):
    results = []
    for identity in identities:
        result = {**identity, "action": "absent"}
        try:
            process = psutil.Process(identity["pid"])
            if process.create_time() != identity["created"]:
                result["action"] = "reused-preserved"
            elif process.status() == psutil.STATUS_ZOMBIE:
                result["action"] = "exited-zombie"
            else:
                # psutil checks its cached process identity again before sending the signal.
                process.kill()
                result["action"] = "kill-requested"
        except psutil.NoSuchProcess:
            pass
        except (psutil.AccessDenied, OSError):
            result["action"] = "unconfirmed"
        results.append(result)
    return results


try:
    request = json.load(sys.stdin)
    result = cleanup(request["identities"]) if request["operation"] == "cleanup" else snapshot()
    print(json.dumps({"complete": True, "records": result}))
except Exception as error:
    print(json.dumps({"complete": False, "error": type(error).__name__}))
    sys.exit(1)
