// This companion owns only its window. NSIS/electron-updater still own installation and trust.
// Native handles pin process identities across PID reuse; no process is ever terminated here.
#include <windows.h>
#include <tlhelp32.h>
#include <commctrl.h>
#include <shellapi.h>
#include <filesystem>
#include <fstream>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
struct Handle {
  HANDLE value;
  explicit Handle(HANDLE h) : value(h) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
struct Process {
  DWORD pid, parent;
  ULONGLONG created;
  std::wstring path;
  std::shared_ptr<Handle> handle;
};
struct Config {
  DWORD parent;
  std::wstring token, parentExe, appExe, installerExe, logPath;
  std::wstring installing, starting, failed, close, unknown;
};
Config config;
std::filesystem::path directory;
std::map<DWORD, Process> owned;
ULONGLONG boundary = 0, began = 0;
bool failed = false, finished = false, uncertain = false;
HWND window = nullptr, label = nullptr, progress = nullptr, closeButton = nullptr;

ULONGLONG Time(FILETIME value) {
  ULARGE_INTEGER result; result.LowPart = value.dwLowDateTime; result.HighPart = value.dwHighDateTime;
  return result.QuadPart;
}
std::string Utf8(const std::wstring& value) {
  const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string result(size, '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
  return result;
}
std::string Json(const std::wstring& value) {
  std::string result = "\"";
  for (const unsigned char c : Utf8(value)) {
    if (c == '"' || c == '\\') { result += '\\'; result += c; }
    else if (c < 32) { char escaped[7]; sprintf_s(escaped, "\\u%04x", c); result += escaped; }
    else result += c;
  }
  return result + '"';
}
void Record(const char* event, const std::wstring& detail = L"") {
  SYSTEMTIME time; GetSystemTime(&time);
  char stamp[40]; sprintf_s(stamp, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute, time.wSecond, time.wMilliseconds);
  std::ofstream file(std::filesystem::path(config.logPath), std::ios::app);
  file << "{\"at\":\"" << stamp << "\",\"event\":\"" << event << "\",\"pid\":" << GetCurrentProcessId()
       << ",\"token\":" << Json(config.token) << ",\"detail\":" << Json(detail) << "}\n";
  if (!file) throw std::runtime_error("Cannot write update handoff evidence");
}
std::wstring Identity(const Process& process) {
  return L"pid=" + std::to_wstring(process.pid) + L" parent=" + std::to_wstring(process.parent) +
    L" created=" + std::to_wstring(process.created) + L" path=" + process.path;
}
DWORD Number(std::ifstream& input) {
  DWORD value = 0;
  if (!input.read(reinterpret_cast<char*>(&value), sizeof(value))) throw std::runtime_error("Truncated handoff configuration");
  return value;
}
std::wstring Text(std::ifstream& input) {
  const auto length = Number(input);
  if (!length || length > 32768) throw std::runtime_error("Invalid handoff string length");
  std::wstring value(length, L'\0');
  if (!input.read(reinterpret_cast<char*>(value.data()), length * sizeof(wchar_t)) || value.find(L'\0') != std::wstring::npos)
    throw std::runtime_error("Invalid handoff string");
  return value;
}
Process Capture(const PROCESSENTRY32W& row) {
  Process result{row.th32ProcessID, row.th32ParentProcessID, 0, L"", std::make_shared<Handle>(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, row.th32ProcessID))};
  if (!result.handle->value) throw std::runtime_error("Cannot open update process identity");
  FILETIME start, end, kernel, user;
  if (!GetProcessTimes(result.handle->value, &start, &end, &kernel, &user)) throw std::runtime_error("Cannot read update process lifetime");
  result.created = Time(start);
  std::vector<wchar_t> path(32768); DWORD length = static_cast<DWORD>(path.size());
  if (!QueryFullProcessImageNameW(result.handle->value, 0, path.data(), &length)) throw std::runtime_error("Cannot read update process executable");
  result.path.assign(path.data(), length);
  return result;
}
bool Exited(const Process& process) {
  const DWORD result = WaitForSingleObject(process.handle->value, 0);
  if (result == WAIT_FAILED) throw std::runtime_error("Cannot wait on update process");
  return result == WAIT_OBJECT_0;
}
std::vector<PROCESSENTRY32W> Snapshot() {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (snapshot.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot inspect update process ancestry");
  std::vector<PROCESSENTRY32W> rows;
  PROCESSENTRY32W row{}; row.dwSize = sizeof(row);
  if (!Process32FirstW(snapshot.value, &row)) throw std::runtime_error("Cannot read update process ancestry");
  do { rows.push_back(row); } while (Process32NextW(snapshot.value, &row));
  if (GetLastError() != ERROR_NO_MORE_FILES) throw std::runtime_error("Incomplete update process ancestry");
  return rows;
}
void Fail(const std::string& error) {
  failed = true;
  const std::wstring detail(error.begin(), error.end());
  try { Record("failed", detail); } catch (...) {}
  SetWindowTextW(label, config.failed.c_str());
  ShowWindow(progress, SW_HIDE); ShowWindow(closeButton, SW_SHOW);
}
bool Receipt(const std::wstring& stage) {
  const auto path = directory / (stage + L".receipt");
  if (!std::filesystem::exists(path)) return false;
  if (!std::filesystem::is_regular_file(std::filesystem::symlink_status(path)) || std::filesystem::file_size(path) > 128)
    throw std::runtime_error("Invalid update receipt file");
  std::ifstream input(path, std::ios::binary);
  const std::string text((std::istreambuf_iterator<char>(input)), {});
  if (text != Utf8(config.token) + "\r\n" + Utf8(stage) + "\r\n")
    throw std::runtime_error("Update receipt identity mismatch");
  return true;
}
void ClosedReceipt() {
  const auto temporary = directory / L"closed.receipt.tmp";
  const auto destination = directory / L"closed.receipt";
  const auto text = Utf8(config.token) + "\r\nclosed\r\n";
  Handle file(CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
  DWORD written = 0;
  if (file.value == INVALID_HANDLE_VALUE || !WriteFile(file.value, text.data(), static_cast<DWORD>(text.size()), &written, nullptr) || written != text.size() || !FlushFileBuffers(file.value))
    throw std::runtime_error("Cannot record closed update presentation");
  CloseHandle(file.value); file.value = nullptr;
  if (!MoveFileExW(temporary.c_str(), destination.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    throw std::runtime_error("Cannot publish closed update presentation");
}
void Unknown(const std::string& error) {
  if (!uncertain) { try { Record("unconfirmed", std::wstring(error.begin(), error.end())); } catch (...) {} }
  uncertain = true;
  SetWindowTextW(label, config.unknown.c_str());
  ShowWindow(progress, SW_HIDE); ShowWindow(closeButton, SW_SHOW);
}
void Tick() {
  const auto cancel = directory / L"cancel";
  if (std::filesystem::exists(cancel)) {
    std::ifstream file(cancel); std::string token((std::istreambuf_iterator<char>(file)), {});
    if (token != Utf8(config.token)) throw std::runtime_error("Invalid handoff cancellation");
    Record("presentation-dismissed"); DestroyWindow(window); return;
  }
  if (failed) return;
  if (Receipt(L"unconfirmed")) Unknown("The installer handoff could not be confirmed");
  if (Receipt(L"failed")) { Fail("Installer reported failure"); return; }
  const bool installed = Receipt(L"installed");
  if (installed && Receipt(L"ready") && Exited(owned.at(config.parent))) {
    Record("successor-ready"); finished = true; DestroyWindow(window); return;
  }
  if (GetTickCount64() - began > 20 * 60 * 1000) {
    Unknown("Timed out waiting for a confirmed update result"); return;
  }
  if (!uncertain) SetWindowTextW(label, installed ? config.starting.c_str() : config.installing.c_str());
}
LRESULT CALLBACK WindowProc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
  switch (message) {
    case WM_TIMER:
      try { Tick(); } catch (const std::exception& error) { Unknown(error.what()); }
      return 0;
    case WM_CLOSE: if (failed || uncertain) DestroyWindow(hwnd); return 0;
    case WM_COMMAND: if (LOWORD(wparam) == 1 && (failed || uncertain)) DestroyWindow(hwnd); return 0;
    case WM_DESTROY: KillTimer(hwnd, 1); PostQuitMessage(0); return 0;
  }
  return DefWindowProcW(hwnd, message, wparam, lparam);
}
} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
  try {
    int count; auto args = CommandLineToArgvW(GetCommandLineW(), &count);
    if (!args || count != 2) throw std::runtime_error("Expected a handoff configuration path");
    const std::filesystem::path file(args[1]); LocalFree(args);
    if (!file.is_absolute() || file.filename() != L"config.bin") throw std::runtime_error("Invalid handoff configuration path");
    directory = file.parent_path();
    std::ifstream input(file, std::ios::binary);
    if (Number(input) != 0x3250554f) throw std::runtime_error("Unsupported handoff configuration");
    config.parent = Number(input);
    config.token = Text(input); config.parentExe = Text(input); config.appExe = Text(input);
    config.installerExe = Text(input); config.logPath = Text(input);
    config.installing = Text(input); config.starting = Text(input); config.failed = Text(input); config.close = Text(input); config.unknown = Text(input);
    if (input.peek() != std::char_traits<char>::eof()) throw std::runtime_error("Unexpected handoff configuration data");
    input.close();
    if (config.token.size() != 36 || config.token.find_first_not_of(L"0123456789abcdef-") != std::wstring::npos) throw std::runtime_error("Invalid handoff token");
    bool parentVerified = false;
    for (const auto& row : Snapshot()) {
      if (row.th32ProcessID != GetCurrentProcessId()) continue;
      if (row.th32ParentProcessID != config.parent) throw std::runtime_error("Handoff parent PID mismatch");
      const auto self = Capture(row); boundary = self.created;
      for (const auto& candidate : Snapshot()) {
        if (candidate.th32ProcessID != config.parent) continue;
        auto parent = Capture(candidate);
        if (_wcsicmp(parent.path.c_str(), config.parentExe.c_str()) != 0 || parent.created > boundary || Exited(parent)) throw std::runtime_error("Handoff parent identity mismatch");
        owned.emplace(parent.pid, parent); parentVerified = true;
      }
    }
    if (!parentVerified) throw std::runtime_error("Handoff parent is unavailable");
    INITCOMMONCONTROLSEX controls{sizeof(controls), ICC_PROGRESS_CLASS}; InitCommonControlsEx(&controls);
    WNDCLASSW type{}; type.hInstance = instance; type.lpszClassName = L"OpenScienceUpdateHandoff";
    type.lpfnWndProc = WindowProc; type.hCursor = LoadCursorW(nullptr, IDC_ARROW); type.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    if (!RegisterClassW(&type)) throw std::runtime_error("Cannot register update window");
    window = CreateWindowExW(WS_EX_APPWINDOW, type.lpszClassName, L"Open-Science", WS_CAPTION | WS_BORDER,
      (GetSystemMetrics(SM_CXSCREEN) - 560) / 2, (GetSystemMetrics(SM_CYSCREEN) - 240) / 2, 560, 240, nullptr, nullptr, instance, nullptr);
    if (!window) throw std::runtime_error("Cannot create update window");
    label = CreateWindowW(L"STATIC", config.installing.c_str(), WS_CHILD | WS_VISIBLE, 24, 24, 500, 112, window, nullptr, instance, nullptr);
    progress = CreateWindowW(PROGRESS_CLASSW, nullptr, WS_CHILD | WS_VISIBLE | PBS_MARQUEE, 24, 158, 500, 20, window, nullptr, instance, nullptr);
    closeButton = CreateWindowW(L"BUTTON", config.close.c_str(), WS_CHILD | BS_PUSHBUTTON, 244, 150, 280, 32, window, reinterpret_cast<HMENU>(1), instance, nullptr);
    if (!label || !progress || !closeButton) throw std::runtime_error("Cannot create update controls");
    const auto font = GetStockObject(DEFAULT_GUI_FONT);
    SendMessageW(label, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
    SendMessageW(closeButton, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
    SendMessageW(progress, PBM_SETMARQUEE, TRUE, 0);
    ShowWindow(window, SW_SHOW); UpdateWindow(window);
    if (!IsWindowVisible(window)) throw std::runtime_error("Update window is not visible");
    began = GetTickCount64();
    if (!SetTimer(window, 1, 200, nullptr)) throw std::runtime_error("Cannot observe update handoff");
    Record("visible", Identity(owned.at(config.parent)));
    const auto ready = "{\"token\":" + Json(config.token) + ",\"pid\":" + std::to_string(GetCurrentProcessId()) + ",\"visible\":true}\n";
    DWORD written;
    if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), ready.data(), static_cast<DWORD>(ready.size()), &written, nullptr) || written != ready.size()) throw std::runtime_error("Cannot acknowledge update window readiness");
    MSG message;
    while (GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
    Record("closed", finished ? L"successor-ready" : failed ? L"failed" : L"dismissed");
    owned.clear();
    // A process's current directory is itself an open directory handle on Windows.
    if (!SetCurrentDirectoryW(directory.parent_path().c_str())) throw std::runtime_error("Cannot release handoff working directory");
    // The successor (or a later startup/uninstall) removes this exact request only after exit.
    // Windows must not delete the executable while it is still mapped in this process.
    ClosedReceipt();
    return failed ? 1 : 0;
  } catch (const std::exception& error) {
    DWORD written; const std::string text = error.what();
    WriteFile(GetStdHandle(STD_ERROR_HANDLE), text.data(), static_cast<DWORD>(text.size()), &written, nullptr);
    if (!config.logPath.empty()) { try { Record("startup-failed", std::wstring(text.begin(), text.end())); } catch (...) {} }
    return 1;
  }
}
