#include <node_api.h>
#include <string>
#include <vector>

#ifdef _WIN32
// libuv includes Winsock 2; load it before windows.h can pull in legacy Winsock.
#include <uv.h>
#include <windows.h>
#include <sddl.h>

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
} // namespace
#endif

void RegisterWindowsOwnedProcess(napi_env env, napi_value exports) {
#ifdef _WIN32
  napi_property_descriptor functions[] = {
    {"spawnWindowsOwnedProcess", nullptr, Spawn, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"windowsOwnedProcessExitCode", nullptr, ExitCode, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"reapWindowsOwnedJob", nullptr, Reap, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, 3, functions);
#endif
}
