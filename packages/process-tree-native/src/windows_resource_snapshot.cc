#include <node_api.h>
#include <cstdint>
#include <string>
#include <vector>
#include <unordered_map>
#include <unordered_set>
#include <chrono>
#include <memory>

#ifdef _WIN32
#include <windows.h>
#include <psapi.h>
#include <tlhelp32.h>
#endif

namespace {
constexpr size_t kMaxProcesses = 4096;
#ifdef _WIN32
struct Handle {
  HANDLE value;
  explicit Handle(HANDLE value) : value(value) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
#endif
struct Identity { uint32_t pid; std::string birth; };
struct Process {
#ifdef _WIN32
  std::shared_ptr<Handle> handle;
#endif
  uint32_t pid = 0, parent = 0, error = 0;
  std::string birth;
  uint64_t private_bytes = 0, working_bytes = 0, handles = 0;
  bool memory_read = false, handles_read = false, parent_verified = false;
};
struct Query {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  bool include_processes = false, supported = false, complete = true, system_read = false;
  uint32_t system_error = 0;
  uint64_t commit = 0, limit = 0, available = 0;
  double started = 0, ended = 0;
  std::vector<Identity> retained;
  std::vector<Process> processes;
};
double Now() {
  return std::chrono::duration<double, std::milli>(std::chrono::system_clock::now().time_since_epoch()).count();
}
napi_value Object(napi_env env) { napi_value v; napi_create_object(env, &v); return v; }
void Number(napi_env env, napi_value obj, const char* key, double value) {
  napi_value v; napi_create_double(env, value, &v); napi_set_named_property(env, obj, key, v);
}
void Boolean(napi_env env, napi_value obj, const char* key, bool value) {
  napi_value v; napi_get_boolean(env, value, &v); napi_set_named_property(env, obj, key, v);
}
void Text(napi_env env, napi_value obj, const char* key, const std::string& value) {
  napi_value v; napi_create_string_utf8(env, value.c_str(), value.size(), &v); napi_set_named_property(env, obj, key, v);
}
#ifdef _WIN32
// Documented layout for NtQueryInformationProcess(ProcessBasicInformation). Resolve dynamically
// and fail closed if unavailable; no PEB or process memory contents are read.
// https://learn.microsoft.com/windows/win32/api/winternl/nf-winternl-ntqueryinformationprocess
struct BasicProcessInformation {
  LONG exit_status;
  void* peb;
  ULONG_PTR affinity;
  LONG priority;
  ULONG_PTR pid;
  ULONG_PTR parent;
};
using QueryProcessInformation = LONG (NTAPI*)(HANDLE, ULONG, void*, ULONG, ULONG*);
Process ReadProcess(DWORD pid, DWORD parent) {
  Process result; result.pid = pid; result.parent = parent;
  Handle opened(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  if (!opened.value) { result.error = GetLastError(); return result; }
  result.handle = std::make_shared<Handle>(opened.value);
  opened.value = nullptr;
  const HANDLE handle = result.handle->value;
  if (!handle) { result.error = GetLastError(); return result; }
  FILETIME created{}, exited{}, kernel{}, user{};
  if (!GetProcessTimes(handle, &created, &exited, &kernel, &user)) {
    result.error = GetLastError(); return result;
  }
  const uint64_t birth = (static_cast<uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
  result.birth = std::to_string(birth);
  static const auto query_information = reinterpret_cast<QueryProcessInformation>(
    GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess"));
  BasicProcessInformation basic{};
  ULONG returned = 0;
  // Check the parent on the same pinned object as the exact birth. This catches a recycled child
  // PID after the Toolhelp table without paying for a second full-system enumeration.
  if (query_information && query_information(handle, 0, &basic, sizeof(basic), &returned) >= 0 &&
      returned == sizeof(basic) && basic.pid == pid) {
    result.parent = static_cast<DWORD>(basic.parent);
    result.parent_verified = result.parent == parent;
  } else {
    result.parent = 0;
    result.error = ERROR_NOT_SUPPORTED;
  }
  PROCESS_MEMORY_COUNTERS_EX memory{};
  memory.cb = sizeof(memory);
  if (GetProcessMemoryInfo(handle, reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory), sizeof(memory))) {
    result.memory_read = true;
    result.private_bytes = memory.PrivateUsage;
    result.working_bytes = memory.WorkingSetSize;
  } else result.error = GetLastError();
  DWORD handles = 0;
  if (GetProcessHandleCount(handle, &handles)) { result.handles_read = true; result.handles = handles; }
  else result.error = GetLastError();
  return result;
}
std::unordered_map<DWORD, DWORD> ReadParents(Query* query) {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (snapshot.value == INVALID_HANDLE_VALUE) { query->complete = false; return {}; }
  std::unordered_map<DWORD, DWORD> parents;
  PROCESSENTRY32 entry{}; entry.dwSize = sizeof(entry);
  BOOL found = Process32First(snapshot.value, &entry);
  while (found && parents.size() < 65536) {
    parents[entry.th32ProcessID] = entry.th32ParentProcessID;
    found = Process32Next(snapshot.value, &entry);
  }
  if (found || GetLastError() != ERROR_NO_MORE_FILES) query->complete = false;
  return parents;
}
void Collect(Query* query) {
  query->supported = true;
  PERFORMANCE_INFORMATION info{}; info.cb = sizeof(info);
  if (GetPerformanceInfo(&info, sizeof(info))) {
    query->system_read = true;
    query->commit = static_cast<uint64_t>(info.CommitTotal) * info.PageSize;
    query->limit = static_cast<uint64_t>(info.CommitLimit) * info.PageSize;
    query->available = static_cast<uint64_t>(info.PhysicalAvailable) * info.PageSize;
  } else query->system_error = GetLastError();
  if (!query->include_processes) return;
  auto parents = ReadParents(query);
  if (parents.empty()) return;
  std::unordered_map<DWORD, std::vector<DWORD>> children;
  for (const auto& item : parents) children[item.second].push_back(item.first);
  std::unordered_set<DWORD> seen;
  std::unordered_set<DWORD> queued{GetCurrentProcessId()};
  std::vector<Process> pending;
  auto root = ReadProcess(GetCurrentProcessId(), parents[GetCurrentProcessId()]);
  pending.push_back(root);
  // Retained orphan identities may no longer be reachable through a live parent. A recycled PID
  // never inherits their membership. No command lines, environment or foreign memory are read.
  for (const auto& identity : query->retained) {
    if (identity.pid == GetCurrentProcessId()) continue;
    if (queued.count(identity.pid)) continue;
    if (pending.size() >= kMaxProcesses) { query->complete = false; break; }
    if (!parents.count(identity.pid)) continue;
    auto process = ReadProcess(identity.pid, parents[identity.pid]);
    if (process.birth == identity.birth && !process.birth.empty()) {
      pending.push_back(process);
      queued.insert(process.pid);
    }
    else if (process.birth.empty()) query->complete = false;
  }
  for (size_t i = 0; i < pending.size() && query->processes.size() < kMaxProcesses; ++i) {
    auto process = pending[i];
    if (!seen.insert(process.pid).second) continue;
    query->processes.push_back(process);
    if (process.birth.empty()) { query->complete = false; continue; }
    if (!process.memory_read || !process.handles_read || !process.parent_verified) query->complete = false;
    for (DWORD child_pid : children[process.pid]) {
      if (queued.count(child_pid)) continue;
      if (pending.size() >= kMaxProcesses) { query->complete = false; break; }
      auto child = ReadProcess(child_pid, process.pid);
      // FILETIME is an unsigned 64-bit decimal string. Compare its numeric value without JS loss.
      if (child.parent_verified && !child.birth.empty() && std::stoull(child.birth) >= std::stoull(process.birth)) {
        pending.push_back(child);
        queued.insert(child.pid);
      }
      else query->complete = false;
    }
  }
  if (seen.size() < pending.size() && query->processes.size() >= kMaxProcesses) query->complete = false;
  // Parents stay pinned throughout traversal, so their PIDs cannot recycle while child birth and
  // parent are checked. Pending copies release their final shared handles when Collect returns.
  for (auto& process : query->processes) process.handle.reset();
}
#endif
void Execute(napi_env, void* data) {
  auto* query = static_cast<Query*>(data);
  query->started = Now();
  try {
#ifdef _WIN32
    Collect(query);
#endif
  } catch (...) {
    query->complete = false;
    // Allocation failure cannot leave a partial candidate table or retained native handles.
    query->processes.clear();
  }
  query->ended = Now();
}
void Complete(napi_env env, napi_status status, void* data) {
  auto* query = static_cast<Query*>(data);
  napi_value result = Object(env), processes;
  Boolean(env, result, "supported", query->supported);
  Boolean(env, result, "complete", query->complete && status == napi_ok);
  Number(env, result, "startedAt", query->started);
  Number(env, result, "endedAt", query->ended);
  if (query->system_read) {
    napi_value system = Object(env);
    Number(env, system, "committedBytes", static_cast<double>(query->commit));
    Number(env, system, "commitLimitBytes", static_cast<double>(query->limit));
    Number(env, system, "availableBytes", static_cast<double>(query->available));
    napi_set_named_property(env, result, "system", system);
  } else Number(env, result, "systemError", query->system_error);
  napi_create_array_with_length(env, query->processes.size(), &processes);
  for (size_t i = 0; i < query->processes.size(); ++i) {
    const auto& p = query->processes[i];
    napi_value process = Object(env);
    Number(env, process, "pid", p.pid); Number(env, process, "parentPid", p.parent);
    if (!p.birth.empty()) Text(env, process, "birth", p.birth);
    if (p.memory_read) {
      Number(env, process, "privateBytes", static_cast<double>(p.private_bytes));
      Number(env, process, "workingSetBytes", static_cast<double>(p.working_bytes));
    }
    if (p.handles_read) Number(env, process, "handleCount", static_cast<double>(p.handles));
    if (p.error) Number(env, process, "error", p.error);
    napi_set_element(env, processes, i, process);
  }
  napi_set_named_property(env, result, "processes", processes);
  napi_resolve_deferred(env, query->deferred, result);
  napi_delete_async_work(env, query->work);
  delete query;
}
napi_value ReadBirth(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value arg, result; uint32_t pid = 0;
  napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  napi_get_null(env, &result);
  if (count != 1 || napi_get_value_uint32(env, arg, &pid) != napi_ok || !pid) return result;
#ifdef _WIN32
  // Open while the spawn/exit observer still refers to this child. No enumeration or disk IO.
  Handle handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  FILETIME created{}, exited{}, kernel{}, user{};
  if (handle.value && GetProcessTimes(handle.value, &created, &exited, &kernel, &user)) {
    const auto value = std::to_string((static_cast<uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime);
    napi_create_string_utf8(env, value.c_str(), value.size(), &result);
  }
#endif
  return result;
}
napi_value StartSample(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  auto owned = std::make_unique<Query>();
  auto* query = owned.get();
  bool valid = argc == 2 && napi_get_value_bool(env, args[0], &query->include_processes) == napi_ok;
  uint32_t count = 0;
  if (valid) valid = napi_get_array_length(env, args[1], &count) == napi_ok && count <= kMaxProcesses;
  for (uint32_t i = 0; valid && i < count; ++i) {
    napi_value item, pid_value, birth_value; uint32_t pid; char birth[24]; size_t length = 0;
    valid = napi_get_element(env, args[1], i, &item) == napi_ok &&
      napi_get_named_property(env, item, "pid", &pid_value) == napi_ok &&
      napi_get_value_uint32(env, pid_value, &pid) == napi_ok && pid > 0 &&
      napi_get_named_property(env, item, "birth", &birth_value) == napi_ok &&
      napi_get_value_string_utf8(env, birth_value, birth, sizeof(birth), &length) == napi_ok && length > 0 && length <= 20;
    if (valid) {
      std::string identity(birth, length);
      valid = identity.find_first_not_of("0123456789") == std::string::npos;
      if (valid) query->retained.push_back({pid, identity});
    }
  }
  if (!valid) { napi_throw_type_error(env, nullptr, "Invalid resource sample request"); return nullptr; }
  napi_value promise, name;
  napi_create_promise(env, &query->deferred, &promise);
  napi_create_string_utf8(env, "resource-snapshot", NAPI_AUTO_LENGTH, &name);
  if (napi_create_async_work(env, nullptr, name, Execute, Complete, query, &query->work) != napi_ok ||
      napi_queue_async_work(env, query->work) != napi_ok) {
    if (query->work) napi_delete_async_work(env, query->work);
    napi_value error, message;
    napi_create_string_utf8(env, "Resource sampler unavailable", NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, nullptr, message, &error);
    napi_reject_deferred(env, query->deferred, error);
  } else owned.release(); // Completion owns the query only after successful admission.
  return promise;
}
napi_value Sample(napi_env env, napi_callback_info info) {
  try { return StartSample(env, info); }
  catch (...) { napi_throw_error(env, nullptr, "Resource sampler unavailable"); return nullptr; }
}
napi_value Birth(napi_env env, napi_callback_info info) {
  try { return ReadBirth(env, info); }
  catch (...) { napi_value result; napi_get_null(env, &result); return result; }
}
}

void RegisterResourceSnapshot(napi_env env, napi_value exports) {
  napi_value sample;
  napi_create_function(env, "sampleWindowsResources", NAPI_AUTO_LENGTH, Sample, nullptr, &sample);
  napi_set_named_property(env, exports, "sampleWindowsResources", sample);
  napi_value birth;
  napi_create_function(env, "readWindowsResourceBirth", NAPI_AUTO_LENGTH, Birth, nullptr, &birth);
  napi_set_named_property(env, exports, "readWindowsResourceBirth", birth);
}
