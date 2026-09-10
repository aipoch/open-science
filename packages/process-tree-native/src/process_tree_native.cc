#include <node_api.h>

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#ifdef __APPLE__
#include <cerrno>
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
};

enum class ProcessReadStatus { kIncluded, kSafelyIgnored, kIncomplete };
enum class EnvironmentReadStatus { kFound, kAbsent, kIncomplete };
#endif

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
  };
  return output->pid == pid && output->unique_id != 0 ? ProcessReadStatus::kIncluded
                                                      : ProcessReadStatus::kIncomplete;
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

napi_value Init(napi_env env, napi_value exports) {
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
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
