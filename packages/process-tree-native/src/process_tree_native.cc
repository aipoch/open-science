#include <node_api.h>

#include <cstdint>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

#ifdef __APPLE__
#include <cerrno>
#include <dlfcn.h>
#include <libproc.h>
#include <signal.h>
#include <sys/sysctl.h>
#include <sys/proc_info.h>
#include <sys/types.h>
#include <unistd.h>

// Apple exposes this process-generation record through proc_pidinfo but keeps the flavor and
// structure behind its PRIVATE SDK guard. The stable ABI has been present since macOS 10.7.
constexpr int kProcPidUniqueIdentifierInfo = 17;
struct DarwinUniqueIdentifierInfo {
  uint8_t executable_uuid[16];
  uint64_t unique_id;
  uint64_t parent_unique_id;
  int32_t id_version;
  uint32_t reserved2;
  uint64_t reserved3;
  uint64_t reserved4;
};

struct DarwinProcessIdentity {
  int32_t pid;
  int32_t ppid;
  int32_t pgid;
  int32_t sid;
  uint64_t unique_id;
  uint64_t parent_unique_id;
  int32_t id_version;
};

// ABI: https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h
// Resource coalitions are inherited by ordinary fork/exec (osfmk/kern/task.c,
// task_create_internal). Choosing another coalition at spawn requires a privileged
// coalition/entitlement (bsd/kern/kern_exec.c). A different coalition is therefore
// negative evidence for an unproven ordinary descendant, never positive ownership.
constexpr int kProcPidCoalitionInfo = 20;
struct DarwinCoalitionInfo {
  uint64_t ids[2];
  uint64_t reserved[3];
};

enum class ProcessReadStatus { kIncluded, kSafelyIgnored, kIncomplete };
enum class EnvironmentReadStatus { kFound, kAbsent, kIncomplete };
#endif

void RegisterWindowsOwnedProcess(napi_env env, napi_value exports);

namespace {

napi_value Null(napi_env env) {
  napi_value value;
  napi_get_null(env, &value);
  return value;
}

napi_value Boolean(napi_env env, bool input) {
  napi_value value;
  napi_get_boolean(env, input, &value);
  return value;
}

napi_value Int32(napi_env env, int32_t input) {
  napi_value value;
  napi_create_int32(env, input, &value);
  return value;
}

napi_value Uint64String(napi_env env, uint64_t input) {
  napi_value value;
  const std::string text = std::to_string(input);
  napi_create_string_utf8(env, text.c_str(), text.size(), &value);
  return value;
}

napi_value Status(napi_env env, const char* status, int error = 0) {
  napi_value result, text;
  napi_create_object(env, &result);
  napi_create_string_utf8(env, status, NAPI_AUTO_LENGTH, &text);
  napi_set_named_property(env, result, "status", text);
  if (error) napi_set_named_property(env, result, "error", Int32(env, error));
  return result;
}

#ifdef __APPLE__
bool ProcessVanished(int32_t pid) {
  if (kill(pid, 0) == 0) return false;
  return errno == ESRCH;
}

ProcessReadStatus ReadDarwinProcess(int32_t pid, DarwinProcessIdentity* output) {
  proc_bsdinfo bsd{};
  errno = 0;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, sizeof(bsd)) != sizeof(bsd)) {
    const int read_error = errno;
    if (read_error == EPERM || read_error == ESRCH) {
      return ProcessReadStatus::kSafelyIgnored;
    }
    return ProcessVanished(pid) ? ProcessReadStatus::kSafelyIgnored
                                : ProcessReadStatus::kIncomplete;
  }
  if (bsd.pbi_uid != geteuid()) return ProcessReadStatus::kSafelyIgnored;

  DarwinUniqueIdentifierInfo unique_before{};
  errno = 0;
  if (proc_pidinfo(pid, kProcPidUniqueIdentifierInfo, 0, &unique_before,
                   sizeof(unique_before)) != sizeof(unique_before)) {
    const int read_error = errno;
    if (read_error == ESRCH) return ProcessReadStatus::kSafelyIgnored;
    return ProcessVanished(pid) ? ProcessReadStatus::kSafelyIgnored
                                : ProcessReadStatus::kIncomplete;
  }
  proc_bsdinfo verified_bsd{};
  errno = 0;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &verified_bsd, sizeof(verified_bsd)) !=
      sizeof(verified_bsd)) {
    const int read_error = errno;
    if (read_error == ESRCH) return ProcessReadStatus::kSafelyIgnored;
    return ProcessVanished(pid) ? ProcessReadStatus::kSafelyIgnored
                                : ProcessReadStatus::kIncomplete;
  }
  if (verified_bsd.pbi_uid != geteuid()) return ProcessReadStatus::kIncomplete;
  errno = 0;
  const pid_t sid = getsid(pid);
  if (sid <= 0) {
    const int read_error = errno;
    if (read_error == ESRCH) return ProcessReadStatus::kSafelyIgnored;
    return ProcessVanished(pid) ? ProcessReadStatus::kSafelyIgnored
                                : ProcessReadStatus::kIncomplete;
  }
  DarwinUniqueIdentifierInfo unique_after{};
  errno = 0;
  if (proc_pidinfo(pid, kProcPidUniqueIdentifierInfo, 0, &unique_after,
                   sizeof(unique_after)) != sizeof(unique_after)) {
    const int read_error = errno;
    if (read_error == ESRCH) return ProcessReadStatus::kSafelyIgnored;
    return ProcessVanished(pid) ? ProcessReadStatus::kSafelyIgnored
                                : ProcessReadStatus::kIncomplete;
  }
  if (unique_before.unique_id == 0 || unique_before.unique_id != unique_after.unique_id ||
      unique_before.parent_unique_id != unique_after.parent_unique_id) {
    return ProcessReadStatus::kIncomplete;
  }
  *output = {
      static_cast<int32_t>(verified_bsd.pbi_pid),
      static_cast<int32_t>(verified_bsd.pbi_ppid),
      static_cast<int32_t>(verified_bsd.pbi_pgid),
      static_cast<int32_t>(sid),
      unique_after.unique_id,
      unique_after.parent_unique_id,
      unique_after.id_version,
  };
  return output->pid == pid && output->unique_id != 0 ? ProcessReadStatus::kIncluded
                                                      : ProcessReadStatus::kIncomplete;
}

bool ReadUint64String(napi_env env, napi_value input, uint64_t* output) {
  size_t size = 0;
  if (napi_get_value_string_utf8(env, input, nullptr, 0, &size) != napi_ok ||
      size == 0 || size > 20) return false;
  char buffer[21]{};
  if (napi_get_value_string_utf8(env, input, buffer, sizeof(buffer), &size) != napi_ok) return false;
  uint64_t value = 0;
  for (size_t i = 0; i < size; ++i) {
    if (buffer[i] < '0' || buffer[i] > '9') return false;
    const uint64_t digit = static_cast<uint64_t>(buffer[i] - '0');
    if (value > (std::numeric_limits<uint64_t>::max() - digit) / 10) return false;
    value = value * 10 + digit;
  }
  if (value == 0) return false;
  *output = value;
  return true;
}

// Returns errno, never a guessed absence. In particular EPERM is unavailable.
int ReadDarwinCoalition(int32_t pid, uint64_t* cid) {
  DarwinCoalitionInfo info{};
  errno = 0;
  if (proc_pidinfo(pid, kProcPidCoalitionInfo, 0, &info, sizeof(info)) != sizeof(info)) {
    const int error = errno;
    return error == ESRCH || ProcessVanished(pid) ? ESRCH : (error ? error : EIO);
  }
  if (!info.ids[0]) return EIO;
  *cid = info.ids[0];
  return 0;
}

int ReadDarwinCoalitionMember(int32_t pid, DarwinProcessIdentity* identity, uint64_t* cid) {
  const auto status = ReadDarwinProcess(pid, identity);
  if (status != ProcessReadStatus::kIncluded) return ProcessVanished(pid) ? ESRCH : EIO;
  const int error = ReadDarwinCoalition(pid, cid);
  if (error) return error;
  DarwinUniqueIdentifierInfo verified{};
  errno = 0;
  if (proc_pidinfo(pid, kProcPidUniqueIdentifierInfo, 0, &verified, sizeof(verified)) != sizeof(verified)) {
    const int read_error = errno;
    return read_error == ESRCH || ProcessVanished(pid) ? ESRCH : (read_error ? read_error : EIO);
  }
  // pidversion changes across exec; do not authorize a signal with an old token.
  if (identity->unique_id != verified.unique_id || identity->id_version != verified.id_version) return EAGAIN;
  return 0;
}

EnvironmentReadStatus ReadDarwinEnvironmentValue(int32_t pid, const std::string& name,
                                                 std::string* output) {
  int mib[] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t size = 0;
  errno = 0;
  if (sysctl(mib, 3, nullptr, &size, nullptr, 0) != 0 || size <= sizeof(int)) {
    const int read_error = errno;
    return read_error == ESRCH || ProcessVanished(pid) ? EnvironmentReadStatus::kAbsent
                                                       : EnvironmentReadStatus::kIncomplete;
  }
  std::vector<char> buffer(size);
  errno = 0;
  if (sysctl(mib, 3, buffer.data(), &size, nullptr, 0) != 0 || size <= sizeof(int)) {
    const int read_error = errno;
    return read_error == ESRCH || ProcessVanished(pid) ? EnvironmentReadStatus::kAbsent
                                                       : EnvironmentReadStatus::kIncomplete;
  }

  const std::string prefix = name + "=";
  size_t offset = sizeof(int);
  while (offset < size) {
    const size_t length = strnlen(buffer.data() + offset, size - offset);
    if (length >= prefix.size() &&
        std::memcmp(buffer.data() + offset, prefix.data(), prefix.size()) == 0) {
      output->assign(buffer.data() + offset + prefix.size(), length - prefix.size());
      return EnvironmentReadStatus::kFound;
    }
    if (length == size - offset) break;
    offset += length + 1;
  }
  return EnvironmentReadStatus::kAbsent;
}

napi_value ProcessIdentity(napi_env env, const DarwinProcessIdentity& identity) {
  napi_value value;
  napi_create_object(env, &value);
  napi_set_named_property(env, value, "pid", Int32(env, identity.pid));
  napi_set_named_property(env, value, "ppid", Int32(env, identity.ppid));
  napi_set_named_property(env, value, "pgid", Int32(env, identity.pgid));
  napi_set_named_property(env, value, "sid", Int32(env, identity.sid));
  napi_set_named_property(env, value, "uniqueId", Uint64String(env, identity.unique_id));
  napi_set_named_property(
      env, value, "parentUniqueId", Uint64String(env, identity.parent_unique_id));
  return value;
}
#endif

napi_value GetDarwinProcess(napi_env env, napi_callback_info info) {
#ifdef __APPLE__
  size_t argc = 1;
  napi_value argv[1];
  int32_t pid = 0;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
      napi_get_value_int32(env, argv[0], &pid) != napi_ok || pid <= 0) {
    return Null(env);
  }
  DarwinProcessIdentity identity{};
  return ReadDarwinProcess(pid, &identity) == ProcessReadStatus::kIncluded
             ? ProcessIdentity(env, identity)
             : Null(env);
#else
  (void)info;
  return Null(env);
#endif
}

napi_value GetDarwinEnvironmentValue(napi_env env, napi_callback_info info) {
#ifdef __APPLE__
  size_t argc = 2;
  napi_value argv[2];
  int32_t pid = 0;
  size_t name_size = 0;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2 ||
      napi_get_value_int32(env, argv[0], &pid) != napi_ok || pid <= 0 ||
      napi_get_value_string_utf8(env, argv[1], nullptr, 0, &name_size) != napi_ok ||
      name_size == 0 || name_size > 255) {
    return Null(env);
  }
  std::string name(name_size, '\0');
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, argv[1], name.data(), name.size() + 1, &copied) != napi_ok ||
      copied != name_size) {
    return Null(env);
  }
  std::string value;
  const EnvironmentReadStatus status = ReadDarwinEnvironmentValue(pid, name, &value);
  if (status == EnvironmentReadStatus::kIncomplete) return Null(env);
  if (status == EnvironmentReadStatus::kAbsent) return Boolean(env, false);
  napi_value result;
  napi_create_string_utf8(env, value.c_str(), value.size(), &result);
  return result;
#else
  (void)info;
  return Null(env);
#endif
}

napi_value ListDarwinProcesses(napi_env env, napi_callback_info info) {
  (void)info;
#ifdef __APPLE__
  int capacity = proc_listallpids(nullptr, 0);
  if (capacity <= 0) return Null(env);

  bool complete = false;
  std::vector<pid_t> pids;
  int count = 0;
  for (int attempt = 0; attempt < 3; attempt += 1) {
    capacity += 256;
    pids.assign(static_cast<size_t>(capacity), 0);
    count = proc_listallpids(pids.data(), static_cast<int>(pids.size() * sizeof(pid_t)));
    if (count < 0) return Null(env);
    if (count < capacity) {
      complete = true;
      break;
    }
    capacity *= 2;
  }

  napi_value processes;
  napi_create_array(env, &processes);
  uint32_t output_index = 0;
  for (int index = 0; index < count && index < static_cast<int>(pids.size()); index += 1) {
    if (pids[index] <= 0) continue;
    DarwinProcessIdentity identity{};
    const ProcessReadStatus status = ReadDarwinProcess(pids[index], &identity);
    if (status == ProcessReadStatus::kSafelyIgnored) continue;
    if (status == ProcessReadStatus::kIncomplete) {
      complete = false;
      continue;
    }
    napi_set_element(env, processes, output_index, ProcessIdentity(env, identity));
    output_index += 1;
  }

  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "processes", processes);
  napi_set_named_property(env, result, "complete", Boolean(env, complete));
  return result;
#else
  return Null(env);
#endif
}

napi_value GetDarwinProcessCoalition(napi_env env, napi_callback_info info) {
#ifdef __APPLE__
  size_t argc = 1;
  napi_value argv[1];
  int32_t pid = 0;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
      napi_get_value_int32(env, argv[0], &pid) != napi_ok || pid <= 0) return Status(env, "unavailable", EINVAL);
  DarwinProcessIdentity identity{};
  uint64_t cid = 0;
  const int error = ReadDarwinCoalitionMember(pid, &identity, &cid);
  if (error) return Status(env, error == ESRCH ? "missing" : "unavailable", error);
  napi_value result = Status(env, "ok");
  napi_set_named_property(env, result, "coalitionId", Uint64String(env, cid));
  napi_set_named_property(env, result, "process", ProcessIdentity(env, identity));
  return result;
#else
  (void)info;
  return Status(env, "unavailable");
#endif
}

napi_value SignalDarwinProcess(napi_env env, napi_callback_info info) {
#ifdef __APPLE__
  using SignalAuditToken = int (*)(audit_token_t*, int);
  static const auto send = reinterpret_cast<SignalAuditToken>(dlsym(RTLD_DEFAULT, "proc_signal_with_audittoken"));
  const auto result = [env](const char* status, int error = 0) {
    napi_value value = Status(env, status, error);
    napi_value mode;
    napi_create_string_utf8(env, send ? "atomic" : "legacy", NAPI_AUTO_LENGTH, &mode);
    napi_set_named_property(env, value, "signalMode", mode);
    return value;
  };
  size_t argc = 3;
  napi_value argv[3];
  uint64_t unique_id = 0;
  int32_t pid = 0, signal = 0;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 3 ||
      napi_get_value_int32(env, argv[0], &pid) != napi_ok || pid <= 0 ||
      !ReadUint64String(env, argv[1], &unique_id) || napi_get_value_int32(env, argv[2], &signal) != napi_ok ||
      signal <= 0 || signal >= NSIG) return result("unavailable", EINVAL);
  DarwinProcessIdentity identity{};
  if (ReadDarwinProcess(pid, &identity) != ProcessReadStatus::kIncluded) {
    return ProcessVanished(pid) ? result("missing", ESRCH) : result("unavailable", EIO);
  }
  if (identity.unique_id != unique_id) return result("mismatch");
  if (!send) {
    // macOS 12-14 lack the audit-token API. Preserve their supported execution
    // path by rechecking the birth identity immediately before a single-PID kill.
    // This is explicitly legacy assurance: userspace cannot eliminate PID reuse
    // between this final check and kill(). Never signal a numeric process group.
    DarwinProcessIdentity verified{};
    if (ReadDarwinProcess(pid, &verified) != ProcessReadStatus::kIncluded) {
      return ProcessVanished(pid) ? result("missing", ESRCH) : result("unavailable", EIO);
    }
    if (verified.unique_id != unique_id) return result("mismatch");
    errno = 0;
    if (kill(pid, signal) == 0) return result("ok");
    const int error = errno ? errno : EIO;
    return result(error == ESRCH ? "missing" : "unavailable", error);
  }
  // XNU kern_proc.c proc_find_audit_token resolves PID + pidversion to a proc ref;
  // proc_info.c psignal_by_audit_token revalidates that identity before signaling.
  // An available audit-token API never falls back on error: permissions, PID reuse
  // or intervening exec must not authorize an unchecked legacy signal.
  audit_token_t token{};
  token.val[5] = static_cast<uint32_t>(pid);
  token.val[7] = static_cast<uint32_t>(identity.id_version);
  const int signal_error = send(&token, signal);
  if (signal_error == ESRCH) {
    DarwinProcessIdentity current{};
    const auto current_status = ReadDarwinProcess(pid, &current);
    if (ProcessVanished(pid) || (current_status == ProcessReadStatus::kIncluded && current.unique_id != unique_id)) {
      return result("missing", ESRCH);
    }
    // An intervening exec changes pidversion but can preserve the birth identity.
    // Failure to signal an old exec generation is not proof that its process died.
    return result("unavailable", EAGAIN);
  }
  return result(signal_error == 0 ? "ok" : "unavailable", signal_error);
#else
  (void)info;
  return Status(env, "unavailable");
#endif
}

napi_value Init(napi_env env, napi_value exports) {
  RegisterWindowsOwnedProcess(env, exports);
  napi_value get_process;
  napi_create_function(
      env, "getDarwinProcess", NAPI_AUTO_LENGTH, GetDarwinProcess, nullptr, &get_process);
  napi_set_named_property(env, exports, "getDarwinProcess", get_process);
  napi_value get_environment_value;
  napi_create_function(env, "getDarwinEnvironmentValue", NAPI_AUTO_LENGTH,
                       GetDarwinEnvironmentValue, nullptr, &get_environment_value);
  napi_set_named_property(env, exports, "getDarwinEnvironmentValue", get_environment_value);
  napi_value list_processes;
  napi_create_function(
      env, "listDarwinProcesses", NAPI_AUTO_LENGTH, ListDarwinProcesses, nullptr, &list_processes);
  napi_set_named_property(env, exports, "listDarwinProcesses", list_processes);
  const napi_property_descriptor coalition_methods[] = {
      {"getDarwinProcessCoalition", nullptr, GetDarwinProcessCoalition, nullptr, nullptr, nullptr, napi_default_jsproperty, nullptr},
      {"signalDarwinProcess", nullptr, SignalDarwinProcess, nullptr, nullptr, nullptr, napi_default_jsproperty, nullptr},
  };
  napi_define_properties(env, exports, sizeof(coalition_methods) / sizeof(coalition_methods[0]), coalition_methods);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
