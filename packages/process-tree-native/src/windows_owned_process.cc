#include <node_api.h>
#include <cstddef>
#include <cstdio>
#include <string>
#include <vector>
#include <map>
#include <memory>

#ifdef _WIN32
// libuv includes Winsock 2; load it before windows.h can pull in legacy Winsock.
#include <uv.h>
#include <windows.h>
#include <sddl.h>
#include <tlhelp32.h>
#include <restartmanager.h>
#include <shellapi.h>

namespace {
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~Handle() { if (value != INVALID_HANDLE_VALUE && value != nullptr) CloseHandle(value); }
  HANDLE release() { HANDLE result = value; value = INVALID_HANDLE_VALUE; return result; }
};
struct Process {
  Handle job;
  Handle process;
};
napi_value Fail(napi_env env, const char* operation) {
  const std::string message = std::string(operation) + " failed (" + std::to_string(GetLastError()) + ")";
  napi_throw_error(env, nullptr, message.c_str());
  return nullptr;
}
napi_value Number(napi_env env, int64_t input) {
  napi_value result; napi_create_int64(env, input, &result); return result;
}
bool Text(napi_env env, napi_value value, std::wstring& result) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::vector<char16_t> buffer(length + 1);
  if (napi_get_value_string_utf16(env, value, buffer.data(), buffer.size(), &length) != napi_ok) return false;
  result.assign(reinterpret_cast<wchar_t*>(buffer.data()), length);
  return result.find(L'\0') == std::wstring::npos;
}
bool Arguments(napi_env env, napi_callback_info info, size_t count, napi_value* args) {
  size_t actual = count;
  return napi_get_cb_info(env, info, &actual, args, nullptr, nullptr) == napi_ok && actual == count;
}
bool JobName(const std::wstring& name) {
  const std::wstring prefix = L"Local\\OpenScience.Delegation.";
  if (name.compare(0, prefix.size(), prefix) != 0 || name.size() != prefix.size() + 36) return false;
  for (size_t i = prefix.size(); i < name.size(); ++i) {
    wchar_t c = name[i];
    if (c != L'-' && !(c >= L'0' && c <= L'9') && !(c >= L'a' && c <= L'f')) return false;
  }
  return true;
}
// A quoted argv element follows the Windows C runtime backslash/quote convention.
std::wstring Quote(const std::wstring& arg) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (wchar_t c : arg) {
    if (c == L'\\') { ++slashes; continue; }
    result.append(c == L'"' ? slashes * 2 + 1 : slashes, L'\\');
    result += c;
    slashes = 0;
  }
  result.append(slashes * 2, L'\\');
  return result + L'"';
}
bool Pipe(const std::wstring& name, bool input, Handle& parent, Handle& child) {
  parent.value = CreateNamedPipeW(name.c_str(),
    (input ? PIPE_ACCESS_OUTBOUND : PIPE_ACCESS_INBOUND) | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 65536, 0, nullptr);
  if (parent.value == INVALID_HANDLE_VALUE) return false;
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  child.value = CreateFileW(name.c_str(), input ? GENERIC_READ : GENERIC_WRITE,
    0, &security, OPEN_EXISTING, 0, nullptr);
  if (child.value == INVALID_HANDLE_VALUE) return false;
  return ConnectNamedPipe(parent.value, nullptr) || GetLastError() == ERROR_PIPE_CONNECTED;
}
napi_value Spawn(napi_env env, napi_callback_info info) {
  napi_value args[6];
  std::wstring name, executable, cwd;
  if (!Arguments(env, info, 6, args) || !Text(env, args[0], name) || !JobName(name) ||
      !Text(env, args[1], executable) || executable.empty() || !Text(env, args[4], cwd)) {
    napi_throw_type_error(env, nullptr, "Invalid owned process launch"); return nullptr;
  }
  bool verbatim = false;
  if (napi_get_value_bool(env, args[5], &verbatim) != napi_ok) return nullptr;
  uint32_t count = 0;
  if (napi_get_array_length(env, args[2], &count) != napi_ok) return nullptr;
  std::wstring command = Quote(executable);
  for (uint32_t i = 0; i < count; ++i) {
    napi_value item; std::wstring text;
    napi_get_element(env, args[2], i, &item);
    if (!Text(env, item, text)) { napi_throw_type_error(env, nullptr, "Invalid process argument"); return nullptr; }
    command += L" " + (verbatim ? text : Quote(text));
  }
  if (napi_get_array_length(env, args[3], &count) != napi_ok) return nullptr;
  std::vector<wchar_t> environment;
  for (uint32_t i = 0; i < count; ++i) {
    napi_value item; std::wstring text;
    napi_get_element(env, args[3], i, &item);
    if (!Text(env, item, text)) { napi_throw_type_error(env, nullptr, "Invalid environment entry"); return nullptr; }
    environment.insert(environment.end(), text.begin(), text.end()); environment.push_back(0);
  }
  if (environment.empty()) environment.push_back(0);
  environment.push_back(0);

  // Explicit current-user DACL; job and process handles are never inherited by the provider.
  Handle token;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value)) return Fail(env, "OpenProcessToken");
  DWORD bytes = 0;
  GetTokenInformation(token.value, TokenUser, nullptr, 0, &bytes);
  std::vector<unsigned char> user(bytes);
  if (!GetTokenInformation(token.value, TokenUser, user.data(), bytes, &bytes)) return Fail(env, "GetTokenInformation");
  LPWSTR sid = nullptr;
  if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid, &sid)) return Fail(env, "ConvertSidToStringSid");
  std::wstring sddl = L"D:P(A;;GA;;;" + std::wstring(sid) + L")";
  LocalFree(sid);
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) return Fail(env, "Job security descriptor");
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), descriptor, FALSE};
  auto process = new Process();
  SetLastError(ERROR_SUCCESS);
  process->job.value = CreateJobObjectW(&security, name.c_str());
  DWORD creationError = GetLastError();
  LocalFree(descriptor);
  if (!process->job.value || creationError == ERROR_ALREADY_EXISTS) {
    delete process; SetLastError(creationError); return Fail(env, "Create exclusive Job");
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(process->job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    delete process; return Fail(env, "Set Job limits");
  }
  Handle parents[3], children[3];
  for (int i = 0; i < 3; ++i) {
    const std::wstring pipe = L"\\\\.\\pipe\\OpenScience.Delegation." + name.substr(name.size() - 36) + L"." + std::to_wstring(i);
    if (!Pipe(pipe, i == 0, parents[i], children[i])) { delete process; return Fail(env, "Create process pipe"); }
  }
  SIZE_T size = 0;
  InitializeProcThreadAttributeList(nullptr, 2, 0, &size);
  std::vector<unsigned char> attributes(size);
  auto list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
  if (!InitializeProcThreadAttributeList(list, 2, 0, &size)) { delete process; return Fail(env, "Initialize process attributes"); }
  HANDLE inherited[] = {children[0].value, children[1].value, children[2].value};
  bool configured = UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &process->job.value, sizeof(HANDLE), nullptr, nullptr) &&
    UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr);
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  startup.StartupInfo.wShowWindow = SW_HIDE;
  startup.StartupInfo.hStdInput = inherited[0]; startup.StartupInfo.hStdOutput = inherited[1]; startup.StartupInfo.hStdError = inherited[2];
  startup.lpAttributeList = list;
  PROCESS_INFORMATION launched{};
  const bool spawned = configured && CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
    EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
    environment.data(), cwd.empty() ? nullptr : cwd.c_str(), &startup.StartupInfo, &launched);
  DWORD spawnError = GetLastError();
  DeleteProcThreadAttributeList(list);
  if (!spawned) { delete process; SetLastError(spawnError); return Fail(env, "Create owned process"); }
  CloseHandle(launched.hThread);
  process->process.value = launched.hProcess;
  int fds[3] = {-1, -1, -1};
  for (int i = 0; i < 3; ++i) {
    fds[i] = uv_open_osfhandle(parents[i].value);
    if (fds[i] < 0) {
      for (int j = 0; j < i; ++j) {
        uv_fs_t request;
        uv_fs_close(nullptr, &request, fds[j], nullptr);
        uv_fs_req_cleanup(&request);
      }
      delete process; return Fail(env, "Transfer process pipe");
    }
    parents[i].release();
  }
  napi_value result, handle, descriptors;
  napi_create_object(env, &result);
  napi_create_external(env, process, [](napi_env, void* value, void*) { delete static_cast<Process*>(value); }, nullptr, &handle);
  napi_set_named_property(env, result, "handle", handle);
  napi_set_named_property(env, result, "pid", Number(env, launched.dwProcessId));
  napi_create_array_with_length(env, 3, &descriptors);
  for (int i = 0; i < 3; ++i) napi_set_element(env, descriptors, i, Number(env, fds[i]));
  napi_set_named_property(env, result, "fds", descriptors);
  return result;
}
napi_value ExitCode(napi_env env, napi_callback_info info) {
  napi_value args[1]; void* external = nullptr;
  if (!Arguments(env, info, 1, args) || napi_get_value_external(env, args[0], &external) != napi_ok) return nullptr;
  auto process = static_cast<Process*>(external);
  if (WaitForSingleObject(process->process.value, 0) == WAIT_OBJECT_0) {
    DWORD code;
    if (!GetExitCodeProcess(process->process.value, &code)) return Fail(env, "Get process exit code");
    return Number(env, code);
  }
  napi_value result; napi_get_null(env, &result); return result;
}
bool ProcessParents(std::map<DWORD, DWORD>& parents) {
  Handle snapshot;
  snapshot.value = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot.value == INVALID_HANDLE_VALUE) return false;
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  if (!Process32FirstW(snapshot.value, &entry)) return false;
  do { parents[entry.th32ProcessID] = entry.th32ParentProcessID; }
  while (Process32NextW(snapshot.value, &entry));
  return GetLastError() == ERROR_NO_MORE_FILES;
}
napi_value Descendants(napi_env env, napi_callback_info) {
  const DWORD root = GetCurrentProcessId();
  std::map<DWORD, DWORD> parents;
  if (!ProcessParents(parents)) return Fail(env, "Snapshot runtime descendants");
  // Open only candidates rooted in this live runtime. Retain handles through the second snapshot
  // so PID reuse between enumeration and OpenProcess cannot manufacture a parent relationship.
  std::map<DWORD, std::unique_ptr<Handle>> handles;
  std::map<DWORD, FILETIME> births;
  FILETIME created, exited, kernel, user;
  if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) return Fail(env, "Query runtime identity");
  births[root] = created;
  bool changed = true;
  while (changed) {
    changed = false;
    for (const auto& [pid, parent] : parents) {
      if (pid == root || births.count(pid) || !births.count(parent)) continue;
      auto handle = std::make_unique<Handle>();
      handle->value = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
      if (!handle->value) {
        if (GetLastError() == ERROR_INVALID_PARAMETER) continue;
        return Fail(env, "Open runtime descendant");
      }
      if (WaitForSingleObject(handle->value, 0) != WAIT_TIMEOUT) continue;
      if (!GetProcessTimes(handle->value, &created, &exited, &kernel, &user)) return Fail(env, "Query descendant identity");
      if (CompareFileTime(&created, &births[parent]) < 0) continue;
      births[pid] = created;
      handles[pid] = std::move(handle);
      changed = true;
    }
  }
  std::map<DWORD, DWORD> current;
  if (!ProcessParents(current)) return Fail(env, "Verify runtime descendants");
  std::map<DWORD, bool> verified{{root, true}};
  changed = true;
  while (changed) {
    changed = false;
    for (const auto& [pid, handle] : handles) {
      if (verified.count(pid) || !current.count(pid) || current[pid] != parents[pid] ||
          !verified.count(current[pid]) || WaitForSingleObject(handle->value, 0) != WAIT_TIMEOUT) continue;
      verified[pid] = true;
      changed = true;
    }
  }
  napi_value result; napi_create_array(env, &result);
  uint32_t index = 0;
  for (const auto& [pid, present] : verified)
    if (pid != root) napi_set_element(env, result, index++, Number(env, pid));
  return result;
}
napi_value Members(napi_env env, napi_callback_info info) {
  napi_value args[1]; void* external = nullptr;
  if (!Arguments(env, info, 1, args) || napi_get_value_external(env, args[0], &external) != napi_ok || !external) {
    napi_throw_type_error(env, nullptr, "Invalid owned Job handle"); return nullptr;
  }
  auto process = static_cast<Process*>(external);
  for (DWORD capacity = 64; capacity <= 65536; capacity *= 2) {
    // ULONG_PTR storage keeps the variable-length native structure correctly aligned.
    std::vector<ULONG_PTR> storage(capacity + sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) / sizeof(ULONG_PTR));
    auto list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(storage.data());
    if (!QueryInformationJobObject(process->job.value, JobObjectBasicProcessIdList, list,
        static_cast<DWORD>(storage.size() * sizeof(ULONG_PTR)), nullptr)) {
      if (GetLastError() == ERROR_MORE_DATA) continue;
      return Fail(env, "Query owned Job members");
    }
    if (list->NumberOfProcessIdsInList < list->NumberOfAssignedProcesses) continue;
    if (list->NumberOfProcessIdsInList > capacity) continue;
    napi_value result;
    napi_create_array_with_length(env, list->NumberOfProcessIdsInList, &result);
    for (DWORD i = 0; i < list->NumberOfProcessIdsInList; ++i)
      napi_set_element(env, result, i, Number(env, list->ProcessIdList[i]));
    return result;
  }
  napi_throw_error(env, nullptr, "Owned Job process list remained incomplete"); return nullptr;
}
napi_value Reap(napi_env env, napi_callback_info info) {
  napi_value args[1]; std::wstring name;
  if (!Arguments(env, info, 1, args) || !Text(env, args[0], name) || !JobName(name)) {
    napi_throw_type_error(env, nullptr, "Invalid owned Job name"); return nullptr;
  }
  Handle job;
  job.value = OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, FALSE, name.c_str());
  bool reaped = false;
  if (!job.value) {
    reaped = GetLastError() == ERROR_FILE_NOT_FOUND;
  } else {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (TerminateJobObject(job.value, 1) && QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) {
      reaped = accounting.ActiveProcesses == 0;
    }
  }
  napi_value result; napi_get_boolean(env, reaped, &result); return result;
}
// The signaled state is the termination proof. An exit code of STILL_ACTIVE (259) is ambiguous:
// a process can really exit with 259, so the code alone never proves that it is running.
bool Exited(napi_env env, HANDLE process, bool& exited) {
  const DWORD state = WaitForSingleObject(process, 0);
  if (state == WAIT_OBJECT_0) { exited = true; return true; }
  if (state == WAIT_TIMEOUT) { exited = false; return true; }
  Fail(env, "Wait for process state");
  return false;
}
// Process identity reads open only PROCESS_QUERY_LIMITED_INFORMATION and SYNCHRONIZE. A missing
// process returns null; every other failure throws so callers keep treating unknown identity as
// unproved.
bool OpenQueried(napi_env env, napi_callback_info info, Handle& handle, bool& missing) {
  napi_value args[1]; double pid = 0;
  missing = false;
  if (!Arguments(env, info, 1, args) || napi_get_value_double(env, args[0], &pid) != napi_ok ||
      !(pid >= 1 && pid <= 4294967295.0) || pid != static_cast<double>(static_cast<int64_t>(pid))) {
    napi_throw_type_error(env, nullptr, "Invalid process identifier"); return false;
  }
  handle.value = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, static_cast<DWORD>(pid));
  if (!handle.value) {
    handle.value = INVALID_HANDLE_VALUE;
    if (GetLastError() == ERROR_INVALID_PARAMETER) { missing = true; return false; }
    Fail(env, "Open process for query");
    return false;
  }
  // An exited process object stays openable while another handle is held. It no longer has a
  // live identity, matching the previous Get-Process behavior, so report it as missing.
  if (!Exited(env, handle.value, missing)) return false;
  return !missing;
}
napi_value Null(napi_env env) { napi_value result; napi_get_null(env, &result); return result; }
napi_value CreationTime(napi_env env, napi_callback_info info) {
  Handle handle; bool missing;
  if (!OpenQueried(env, info, handle, missing)) return missing ? Null(env) : nullptr;
  FILETIME created, exited, kernel, user;
  if (!GetProcessTimes(handle.value, &created, &exited, &kernel, &user)) return Fail(env, "Get process times");
  // FILETIME: 100-nanosecond intervals since 1601-01-01 UTC, returned as a decimal string.
  const uint64_t value = (static_cast<uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
  const std::string text = std::to_string(value);
  napi_value result; napi_create_string_utf8(env, text.c_str(), text.size(), &result); return result;
}
typedef LONG (NTAPI* QueryProcess)(HANDLE, ULONG, PVOID, ULONG, PULONG);
QueryProcess Ntdll() {
  static QueryProcess query = reinterpret_cast<QueryProcess>(
    GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess"));
  return query;
}
napi_value NtFail(napi_env env, const char* operation, LONG status) {
  char code[16]; snprintf(code, sizeof(code), "0x%08lX", static_cast<unsigned long>(status));
  const std::string message = std::string(operation) + " failed (" + code + ")";
  napi_throw_error(env, nullptr, message.c_str());
  return nullptr;
}
napi_value CommandLine(napi_env env, napi_callback_info info) {
  Handle handle; bool missing;
  if (!OpenQueried(env, info, handle, missing)) return missing ? Null(env) : nullptr;
  QueryProcess query = Ntdll();
  if (!query) return Fail(env, "Resolve NtQueryInformationProcess");
  constexpr ULONG ProcessCommandLineInformation = 60;
  constexpr LONG InfoLengthMismatch = static_cast<LONG>(0xC0000004L);
  ULONG size = 0;
  LONG status = query(handle.value, ProcessCommandLineInformation, nullptr, 0, &size);
  for (int attempt = 0; attempt < 3 && status == InfoLengthMismatch && size > 0 && size <= 1024 * 1024; ++attempt) {
    // Align the buffer for UNICODE_STRING's pointer member.
    std::vector<ULONG_PTR> buffer((size + sizeof(ULONG_PTR) - 1) / sizeof(ULONG_PTR));
    status = query(handle.value, ProcessCommandLineInformation, buffer.data(), static_cast<ULONG>(buffer.size() * sizeof(ULONG_PTR)), &size);
    if (status < 0) continue;
    struct Text { USHORT Length; USHORT MaximumLength; PWSTR Buffer; };
    auto text = reinterpret_cast<Text*>(buffer.data());
    napi_value result;
    napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(text->Buffer), text->Length / sizeof(wchar_t), &result);
    return result;
  }
  return NtFail(env, "Query process command line", status);
}
napi_value ParentProcessId(napi_env env, napi_callback_info info) {
  Handle handle; bool missing;
  if (!OpenQueried(env, info, handle, missing)) return missing ? Null(env) : nullptr;
  QueryProcess query = Ntdll();
  if (!query) return Fail(env, "Resolve NtQueryInformationProcess");
  struct Basic { LONG ExitStatus; PVOID PebBaseAddress; ULONG_PTR AffinityMask; LONG BasePriority; ULONG_PTR UniqueProcessId; ULONG_PTR InheritedFromUniqueProcessId; };
  Basic basic{};
  const LONG status = query(handle.value, 0 /* ProcessBasicInformation */, &basic, sizeof(basic), nullptr);
  if (status < 0) return NtFail(env, "Query process parent", status);
  return Number(env, static_cast<int64_t>(basic.InheritedFromUniqueProcessId));
}
bool TextArray(napi_env env, napi_value value, std::vector<std::wstring>& result) {
  bool array = false;
  uint32_t count = 0;
  if (napi_is_array(env, value, &array) != napi_ok || !array || napi_get_array_length(env, value, &count) != napi_ok) return false;
  result.resize(count);
  for (uint32_t i = 0; i < count; ++i) {
    napi_value item;
    if (napi_get_element(env, value, i, &item) != napi_ok || !Text(env, item, result[i]) || result[i].empty()) return false;
  }
  return true;
}
struct OccupancyQuery {
  std::vector<std::wstring> files;
  std::vector<DWORD> pids;
  const char* failure = nullptr;
  DWORD code = ERROR_SUCCESS;
  napi_deferred deferred = nullptr;
  napi_async_work work = nullptr;
};
// Read-only Restart Manager query: no RmShutdown, name matching or termination authority.
// Runs without touching N-API so the asynchronous form can execute on the libuv thread pool.
void QueryOccupants(OccupancyQuery& query) {
  if (query.files.empty()) return;
  DWORD session = 0;
  WCHAR key[CCH_RM_SESSION_KEY + 1] = {};
  query.code = RmStartSession(&session, 0, key);
  if (query.code != ERROR_SUCCESS) { query.failure = "Start Restart Manager session"; return; }
  for (size_t offset = 0; offset < query.files.size() && !query.failure; offset += 256) {
    std::vector<LPCWSTR> batch;
    for (size_t i = offset; i < query.files.size() && i < offset + 256; ++i) batch.push_back(query.files[i].c_str());
    query.code = RmRegisterResources(session, static_cast<UINT>(batch.size()), batch.data(), 0, nullptr, 0, nullptr);
    if (query.code != ERROR_SUCCESS) query.failure = "Register installation resources";
  }
  // Avoid the size-only RmGetList call on the common small-installation case. The capacity is
  // only an allocation hint: ERROR_MORE_DATA below still expands the buffer to the complete list.
  constexpr UINT kInitialOccupantCapacity = 32;
  UINT needed = 0, count = kInitialOccupantCapacity;
  DWORD reasons = 0;
  std::vector<RM_PROCESS_INFO> rows(kInitialOccupantCapacity);
  bool complete = false;
  for (int retry = 0; retry < 3 && !query.failure && !complete; ++retry) {
    rows.resize(count);
    query.code = RmGetList(session, &needed, &count, rows.data(), &reasons);
    if (query.code == ERROR_MORE_DATA) {
      if (needed <= count) {
        query.failure = "List installation resource users";
        break;
      }
      count = needed;
      continue;
    }
    if (query.code != ERROR_SUCCESS) query.failure = "List installation resource users";
    else if (count <= rows.size()) complete = true;
    else query.failure = "List installation resource users";
  }
  if (!query.failure && !complete) { query.failure = "List installation resource users"; query.code = ERROR_MORE_DATA; }
  const DWORD ended = RmEndSession(session);
  if (query.failure) return;
  if (ended != ERROR_SUCCESS) { query.failure = "End Restart Manager session"; query.code = ended; return; }
  for (UINT i = 0; i < count; ++i) {
    // Restart Manager keeps reporting a terminated process while another handle keeps its kernel
    // object alive. An exited process cannot use files, and a PID is reused only after the
    // original object is freed, so an exited process at this PID proves the occupant is gone.
    // A live (possibly reused) or unreadable process remains an occupant.
    // Termination is proved only by the signaled process object, never by exit code 259.
    const DWORD pid = rows[i].Process.dwProcessId;
    Handle process;
    process.value = OpenProcess(SYNCHRONIZE, FALSE, pid);
    if (!process.value) {
      process.value = INVALID_HANDLE_VALUE;
      if (GetLastError() == ERROR_INVALID_PARAMETER) continue;
    } else if (WaitForSingleObject(process.value, 0) == WAIT_OBJECT_0) {
      continue;
    }
    query.pids.push_back(pid);
  }
}
napi_value OccupantArray(napi_env env, const OccupancyQuery& query) {
  napi_value result;
  napi_create_array_with_length(env, query.pids.size(), &result);
  for (size_t i = 0; i < query.pids.size(); ++i) napi_set_element(env, result, static_cast<uint32_t>(i), Number(env, query.pids[i]));
  return result;
}
napi_value OccupantError(napi_env env, const OccupancyQuery& query) {
  const std::string text = std::string(query.failure) + " failed (" + std::to_string(query.code) + ")";
  napi_value message, error;
  napi_create_string_utf8(env, text.c_str(), text.size(), &message);
  napi_create_error(env, nullptr, message, &error);
  return error;
}
napi_value InstallationOccupants(napi_env env, napi_callback_info info) {
  napi_value args[1]; OccupancyQuery query;
  if (!Arguments(env, info, 1, args) || !TextArray(env, args[0], query.files)) {
    napi_throw_type_error(env, nullptr, "Invalid installation resource list"); return nullptr;
  }
  QueryOccupants(query);
  if (query.failure) { napi_throw(env, OccupantError(env, query)); return nullptr; }
  return OccupantArray(env, query);
}
napi_value InstallationOccupantsAsync(napi_env env, napi_callback_info info) {
  napi_value args[1];
  auto query = new OccupancyQuery();
  if (!Arguments(env, info, 1, args) || !TextArray(env, args[0], query->files)) {
    delete query; napi_throw_type_error(env, nullptr, "Invalid installation resource list"); return nullptr;
  }
  napi_value promise, name;
  napi_create_promise(env, &query->deferred, &promise);
  napi_create_string_utf8(env, "listWindowsInstallationOccupantsAsync", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, nullptr, name,
    [](napi_env, void* data) { QueryOccupants(*static_cast<OccupancyQuery*>(data)); },
    [](napi_env env, napi_status, void* data) {
      auto query = static_cast<OccupancyQuery*>(data);
      if (query->failure) napi_reject_deferred(env, query->deferred, OccupantError(env, *query));
      else napi_resolve_deferred(env, query->deferred, OccupantArray(env, *query));
      napi_delete_async_work(env, query->work);
      delete query;
    }, query, &query->work);
  napi_queue_async_work(env, query->work);
  return promise;
}
// A whole-system snapshot. Image paths of protected processes are null, as with CIM.
napi_value Processes(napi_env env, napi_callback_info info) {
  napi_value args[1];
  if (!Arguments(env, info, 0, args)) { napi_throw_type_error(env, nullptr, "Unexpected arguments"); return nullptr; }
  Handle snapshot;
  snapshot.value = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot.value == INVALID_HANDLE_VALUE) return Fail(env, "Snapshot processes");
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (!Process32FirstW(snapshot.value, &entry)) return Fail(env, "Read process snapshot");
  napi_value result;
  napi_create_array(env, &result);
  uint32_t index = 0;
  do {
    napi_value row, path;
    napi_create_object(env, &row);
    napi_set_named_property(env, row, "pid", Number(env, entry.th32ProcessID));
    napi_set_named_property(env, row, "ppid", Number(env, entry.th32ParentProcessID));
    napi_get_null(env, &path);
    Handle process;
    process.value = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ProcessID);
    if (!process.value) process.value = INVALID_HANDLE_VALUE;
    else {
      std::vector<wchar_t> buffer(32768);
      DWORD size = static_cast<DWORD>(buffer.size());
      if (QueryFullProcessImageNameW(process.value, 0, buffer.data(), &size))
        napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(buffer.data()), size, &path);
    }
    napi_set_named_property(env, row, "executablePath", path);
    napi_set_element(env, result, index++, row);
  } while (Process32NextW(snapshot.value, &entry));
  if (GetLastError() != ERROR_NO_MORE_FILES) return Fail(env, "Read process snapshot");
  return result;
}
// Windows' own argv rules; callers must not infer quoted paths with substring matching.
napi_value SplitCommandLine(napi_env env, napi_callback_info info) {
  napi_value args[1]; std::wstring line;
  if (!Arguments(env, info, 1, args) || !Text(env, args[0], line) || line.empty()) {
    napi_throw_type_error(env, nullptr, "Invalid command line"); return nullptr;
  }
  int count = 0;
  LPWSTR* argv = CommandLineToArgvW(line.c_str(), &count);
  if (!argv) return Fail(env, "Split command line");
  napi_value result;
  napi_create_array_with_length(env, count, &result);
  for (int i = 0; i < count; ++i) {
    napi_value item;
    napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(argv[i]), wcslen(argv[i]), &item);
    napi_set_element(env, result, i, item);
  }
  LocalFree(argv);
  return result;
}
} // namespace
#endif

void RegisterWindowsOwnedProcess(napi_env env, napi_value exports) {
#ifdef _WIN32
  napi_property_descriptor functions[] = {
    {"spawnWindowsOwnedProcess", nullptr, Spawn, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"windowsOwnedProcessExitCode", nullptr, ExitCode, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"windowsOwnedJobProcessIds", nullptr, Members, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"windowsCurrentProcessDescendants", nullptr, Descendants, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"reapWindowsOwnedJob", nullptr, Reap, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"getWindowsProcessCreationTime", nullptr, CreationTime, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"getWindowsProcessCommandLine", nullptr, CommandLine, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"getWindowsParentProcessId", nullptr, ParentProcessId, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"listWindowsInstallationOccupants", nullptr, InstallationOccupants, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"listWindowsInstallationOccupantsAsync", nullptr, InstallationOccupantsAsync, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"listWindowsProcesses", nullptr, Processes, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"splitWindowsCommandLine", nullptr, SplitCommandLine, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, sizeof(functions) / sizeof(functions[0]), functions);
#endif
}
