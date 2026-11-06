#include <node_api.h>
#include <cerrno>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

#ifdef __APPLE__
#include <cstring>
#include <dlfcn.h>
#include <libproc.h>
#include <mach/message.h>
#include <signal.h>
#include <sys/proc_info.h>
#include <unistd.h>
#endif

namespace {
napi_value Null(napi_env env) { napi_value out; napi_get_null(env, &out); return out; }
napi_value Bool(napi_env env, bool value) {
  napi_value out; napi_get_boolean(env, value, &out); return out;
}
napi_value Fail(napi_env env, const char* stage) {
  // Fixed stage/code only: paths, argv and environment never cross this diagnostic boundary.
  const std::string message = std::string(stage) + ";errno=" + std::to_string(errno);
  napi_throw_error(env, nullptr, message.c_str());
  return nullptr;
}
bool String(napi_env env, napi_value value, std::string* out) {
  size_t size = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &size) != napi_ok) return false;
  std::vector<char> buffer(size + 1);
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &size) != napi_ok)
    return false;
  out->assign(buffer.data(), size);
  return out->find('\0') == std::string::npos;
}

#ifdef __APPLE__
// Same long-standing PROC_PIDUNIQIDENTIFIERINFO ABI as process_tree_native.cc.
constexpr int kUniqueInfo = 17;
struct UniqueInfo {
  uint8_t uuid[16];
  uint64_t unique_id;
  uint64_t parent_unique_id;
  int32_t id_version;
  uint32_t reserved2;
  uint64_t reserved3;
  uint64_t reserved4;
};
bool Gone(pid_t pid) { return kill(pid, 0) == -1 && errno == ESRCH; }
bool Unique(pid_t pid, UniqueInfo* out) {
  return proc_pidinfo(pid, kUniqueInfo, 0, out, sizeof(*out)) == sizeof(*out) &&
         out->unique_id != 0;
}
bool Inside(const std::string& path, const std::string& root) {
  return path == root || (path.size() > root.size() && path.compare(0, root.size(), root) == 0 &&
                          path[root.size()] == '/');
}
#endif

napi_value Executable(napi_env env, napi_callback_info info) {
#ifdef __APPLE__
  size_t argc = 2; napi_value argv[2]; int32_t pid = 0; std::string generation;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2 ||
      napi_get_value_int32(env, argv[0], &pid) != napi_ok || pid <= 0 ||
      !String(env, argv[1], &generation)) { errno = EINVAL; return Fail(env, "executable-input"); }
  UniqueInfo before{}, after{};
  if (!Unique(pid, &before)) return Gone(pid) ? Null(env) : Fail(env, "executable-identity");
  if (std::to_string(before.unique_id) != generation) return Null(env);
  char path[PROC_PIDPATHINFO_MAXSIZE]{};
  if (proc_pidpath(pid, path, sizeof(path)) <= 0)
    return Gone(pid) ? Null(env) : Fail(env, "executable-path");
  if (!Unique(pid, &after)) return Gone(pid) ? Null(env) : Fail(env, "executable-recheck");
  if (before.unique_id != after.unique_id || before.id_version != after.id_version) return Null(env);
  napi_value out; napi_create_string_utf8(env, path, NAPI_AUTO_LENGTH, &out); return out;
#else
  (void)info; return Null(env);
#endif
}

napi_value Signal(napi_env env, napi_callback_info info) {
#ifdef __APPLE__
  size_t argc = 4; napi_value argv[4]; int32_t pid = 0, signal = 0;
  std::string generation, expected_path;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 4 ||
      napi_get_value_int32(env, argv[0], &pid) != napi_ok || pid <= 1 || pid == getpid() ||
      !String(env, argv[1], &generation) ||
      napi_get_value_int32(env, argv[2], &signal) != napi_ok ||
      (signal != SIGTERM && signal != SIGKILL) || !String(env, argv[3], &expected_path) ||
      expected_path.empty() || expected_path[0] != '/') { errno = EINVAL; return Fail(env, "signal-input"); }
  proc_bsdinfo bsd{};
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, sizeof(bsd)) != sizeof(bsd))
    return Gone(pid) ? Bool(env, false) : Fail(env, "signal-owner");
  if (bsd.pbi_uid != geteuid()) { errno = EPERM; return Fail(env, "signal-owner"); }
  UniqueInfo identity{};
  if (!Unique(pid, &identity)) return Gone(pid) ? Bool(env, false) : Fail(env, "signal-identity");
  if (std::to_string(identity.unique_id) != generation) return Bool(env, false);
  char current_path[PROC_PIDPATHINFO_MAXSIZE]{};
  if (proc_pidpath(pid, current_path, sizeof(current_path)) <= 0)
    return Gone(pid) ? Bool(env, false) : Fail(env, "signal-executable");
  if (expected_path != current_path) return Bool(env, false);
  UniqueInfo path_identity{};
  if (!Unique(pid, &path_identity)) return Gone(pid) ? Bool(env, false) : Fail(env, "signal-executable-recheck");
  if (identity.unique_id != path_identity.unique_id || identity.id_version != path_identity.id_version)
    return Bool(env, false);
  using SignalAuditToken = int (*)(audit_token_t*, int);
  const auto signal_audit = reinterpret_cast<SignalAuditToken>(
      dlsym(RTLD_DEFAULT, "proc_signal_with_audittoken"));
  int error = 0;
  if (signal_audit) {
    // The kernel checks PID version while taking the signal target reference. A reused PID
    // cannot borrow the validated process's authority between inspection and delivery.
    audit_token_t token{};
    token.val[5] = static_cast<uint32_t>(pid);
    token.val[7] = static_cast<uint32_t>(identity.id_version);
    error = signal_audit(&token, signal);
  } else {
    // macOS 12 predates the audit-token signal API. Preserve the repository's POSIX policy:
    // revalidate the birth identity in this synchronous native call immediately before kill.
    UniqueInfo current{};
    if (!Unique(pid, &current)) return Gone(pid) ? Bool(env, false) : Fail(env, "signal-recheck");
    if (current.unique_id != identity.unique_id || current.id_version != identity.id_version)
      return Bool(env, false);
    if (kill(pid, signal) != 0) error = errno;
  }
  if (error == ESRCH) return Bool(env, false);
  if (error) { errno = error; return Fail(env, "signal-delivery"); }
  return Bool(env, true);
#else
  (void)info; return Bool(env, false);
#endif
}

// Independent of ps/lsof. Only read executable/mapped paths; ordinary descriptors do not
// establish replacement occupancy. The caller runs this potentially long scan in a bounded child.
napi_value Mappings(napi_env env, napi_callback_info info) {
#ifdef __APPLE__
  size_t argc = 1; napi_value argv[1]; std::string root;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
      !String(env, argv[0], &root) || root.empty() || root[0] != '/') {
    errno = EINVAL; return Fail(env, "mapping-input");
  }
  while (root.size() > 1 && root.back() == '/') root.pop_back();
  int capacity = proc_listallpids(nullptr, 0);
  if (capacity <= 0) return Fail(env, "mapping-list");
  capacity += 512;
  std::vector<pid_t> pids(static_cast<size_t>(capacity));
  const int count = proc_listallpids(pids.data(), static_cast<int>(pids.size() * sizeof(pid_t)));
  if (count <= 0 || count >= capacity) return Fail(env, "mapping-list-truncated");
  napi_value found; napi_create_array(env, &found); uint32_t index = 0;
  bool complete = true;
  for (int i = 0; i < count; ++i) {
    const pid_t pid = pids[i];
    if (pid <= 0 || pid == getpid()) continue;
    proc_bsdinfo bsd{};
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, sizeof(bsd)) != sizeof(bsd)) {
      if (!Gone(pid)) complete = false;
      continue;
    }
    // Read-only occupancy is wider than termination authority. Another login account can use
    // this very same /Applications bundle; unreadable mappings must remain unknown.
    if (bsd.pbi_status == 5 /* SZOMB */) continue;
    char path[PROC_PIDPATHINFO_MAXSIZE]{};
    bool occupant = false;
    if (proc_pidpath(pid, path, sizeof(path)) > 0) occupant = Inside(path, root);
    else if (!Gone(pid)) complete = false;
    uint64_t address = 0;
    bool finished = occupant;
    for (int region = 0; !finished && region < 65536; ++region) {
      proc_regionwithpathinfo mapping{};
      errno = 0;
      const int bytes = proc_pidinfo(pid, PROC_PIDREGIONPATHINFO, address, &mapping, sizeof(mapping));
      if (bytes != sizeof(mapping)) {
        // EINVAL is the documented end-of-address-space result, not an inaccessible region.
        if (errno != EINVAL && errno != ESRCH && !Gone(pid)) complete = false;
        finished = true;
        break;
      }
      if (Inside(mapping.prp_vip.vip_path, root)) { occupant = true; finished = true; break; }
      const uint64_t next = mapping.prp_prinfo.pri_address + mapping.prp_prinfo.pri_size;
      if (next <= address) { complete = false; finished = true; break; }
      address = next;
    }
    if (!finished) complete = false;
    if (occupant) { napi_value value; napi_create_int32(env, pid, &value); napi_set_element(env, found, index++, value); }
  }
  napi_value out; napi_create_object(env, &out);
  napi_set_named_property(env, out, "pids", found);
  napi_set_named_property(env, out, "complete", Bool(env, complete));
  return out;
#else
  (void)info; return Null(env);
#endif
}
}  // namespace

void RegisterDarwinInstallationProcesses(napi_env env, napi_value exports) {
  for (const auto& item : std::vector<std::pair<const char*, napi_callback>>{
           {"getDarwinProcessExecutable", Executable}, {"signalDarwinProcess", Signal},
           {"listDarwinInstallationMappings", Mappings}}) {
    napi_value fn; napi_create_function(env, item.first, NAPI_AUTO_LENGTH, item.second, nullptr, &fn);
    napi_set_named_property(env, exports, item.first, fn);
  }
}
