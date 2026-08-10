#include <node_api.h>

#include <cerrno>
#include <cstddef>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/syscall.h>
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif
#endif
#ifdef __APPLE__
#include <stdio.h>
#ifndef RENAME_EXCL
#define RENAME_EXCL 0x00000004
#endif
#endif
#endif

namespace {

napi_value ThrowError(napi_env env, const std::string& message, const char* code) {
  napi_value message_value;
  napi_value error;
  napi_value code_value;
  napi_create_string_utf8(env, message.c_str(), message.size(), &message_value);
  napi_create_error(env, nullptr, message_value, &error);
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value);
  napi_set_named_property(env, error, "code", code_value);
  napi_throw(env, error);
  return nullptr;
}

bool ReadString(napi_env env, napi_value value, std::string* output) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::vector<char> buffer(length + 1);
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length) != napi_ok) {
    return false;
  }
  output->assign(buffer.data(), length);
  return true;
}

bool IsSimpleName(const std::string& value) {
  if (value.empty() || value == "." || value == ".." ||
      value.find('/') != std::string::npos || value.find('\\') != std::string::npos) {
    return false;
  }
#ifdef _WIN32
  if (value.find(':') != std::string::npos) return false;
#endif
  return true;
}

bool SplitRelativePath(const std::string& value, std::vector<std::string>* components) {
  if (value.empty()) return true;
  size_t start = 0;
  while (start < value.size()) {
#ifdef _WIN32
    const size_t separator = value.find_first_of("/\\", start);
#else
    const size_t separator = value.find('/', start);
#endif
    const size_t end = separator == std::string::npos ? value.size() : separator;
    const std::string component = value.substr(start, end - start);
    if (!IsSimpleName(component)) return false;
    components->push_back(component);
    if (separator == std::string::npos) return true;
    start = separator + 1;
  }
  return false;
}

#ifdef _WIN32

std::wstring Utf8ToWide(const std::string& value) {
  if (value.empty()) return {};
  const int length =
      MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), value.size(), nullptr, 0);
  if (length <= 0) return {};
  std::wstring output(length, L'\0');
  if (MultiByteToWideChar(
          CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), value.size(), output.data(), length) <= 0) {
    return {};
  }
  return output;
}

std::wstring HandlePath(HANDLE handle) {
  const DWORD length =
      GetFinalPathNameByHandleW(handle, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (length == 0) return {};
  std::vector<wchar_t> buffer(length + 1);
  const DWORD written = GetFinalPathNameByHandleW(
      handle, buffer.data(), buffer.size(), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (written == 0 || written >= buffer.size()) return {};
  return std::wstring(buffer.data(), written);
}

std::wstring ParentPath(const std::wstring& path) {
  const size_t separator = path.find_last_of(L"\\/");
  return separator == std::wstring::npos ? std::wstring() : path.substr(0, separator);
}

bool SamePath(const std::wstring& left, const std::wstring& right) {
  return CompareStringOrdinal(left.c_str(), -1, right.c_str(), -1, TRUE) == CSTR_EQUAL;
}

bool IsRemoteHandle(HANDLE handle) {
  FILE_REMOTE_PROTOCOL_INFO info{};
  info.StructureVersion = 2;
  info.StructureSize = sizeof(info);
  return GetFileInformationByHandleEx(handle, FileRemoteProtocolInfo, &info, sizeof(info)) &&
         info.Protocol != 0;
}

bool QueryHardLinkSupport(HANDLE handle, bool* supports_hard_links) {
  DWORD file_system_flags = 0;
  if (!GetVolumeInformationByHandleW(
          handle, nullptr, 0, nullptr, nullptr, &file_system_flags, nullptr, 0)) {
    return false;
  }
  *supports_hard_links = (file_system_flags & FILE_SUPPORTS_HARD_LINKS) != 0;
  return true;
}

bool IsSameOrDescendant(const std::wstring& root, const std::wstring& candidate) {
  if (SamePath(root, candidate)) return true;
  if (candidate.size() <= root.size() ||
      CompareStringOrdinal(candidate.c_str(), static_cast<int>(root.size()), root.c_str(),
                           static_cast<int>(root.size()), TRUE) != CSTR_EQUAL) {
    return false;
  }
  return candidate[root.size()] == L'\\' || candidate[root.size()] == L'/';
}

const char* WindowsErrorCode(DWORD error) {
  switch (error) {
    case ERROR_FILE_EXISTS:
    case ERROR_ALREADY_EXISTS:
      return "EEXIST";
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
      return "ENOENT";
    case ERROR_NOT_SAME_DEVICE:
      return "EXDEV";
    case ERROR_INVALID_FUNCTION:
    case ERROR_INVALID_PARAMETER:
    case ERROR_NOT_SUPPORTED:
      return "ENOTSUP";
    case ERROR_ACCESS_DENIED:
    case ERROR_SHARING_VIOLATION:
      return "EPERM";
    default:
      return "EIO";
  }
}

struct NativeIoStatusBlock {
  union {
    LONG status;
    void* pointer;
  };
  ULONG_PTR information;
};

struct NativeFileLinkInformation {
  BOOLEAN replace_if_exists;
  HANDLE root_directory;
  ULONG file_name_length;
  WCHAR file_name[1];
};

using NtSetInformationFileFunction = LONG(NTAPI*)(
    HANDLE, NativeIoStatusBlock*, void*, ULONG, ULONG);
using RtlNtStatusToDosErrorFunction = ULONG(NTAPI*)(LONG);

constexpr ULONG kFileLinkInformation = 11;

napi_value PublishWindows(
    napi_env env,
    const std::string& root_utf8,
    const std::vector<std::string>& parent_components,
    const std::string& source_utf8,
    const std::string& destination_utf8) {
  const std::wstring root = Utf8ToWide(root_utf8);
  const std::wstring source_name = Utf8ToWide(source_utf8);
  const std::wstring destination_name = Utf8ToWide(destination_utf8);
  if (root.empty() || source_name.empty() || destination_name.empty()) {
    return ThrowError(env, "Invalid UTF-8 path for atomic publication.", "EINVAL");
  }

  std::wstring parent = root;
  for (const std::string& component_utf8 : parent_components) {
    const std::wstring component = Utf8ToWide(component_utf8);
    if (component.empty()) {
      return ThrowError(env, "Invalid UTF-8 path for atomic publication.", "EINVAL");
    }
    if (parent.back() != L'\\' && parent.back() != L'/') parent.push_back(L'\\');
    parent.append(component);
  }

  HANDLE root_handle = CreateFileW(
      root.c_str(),
      FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr);
  if (root_handle == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    return ThrowError(env, "Could not open the storage root.", WindowsErrorCode(error));
  }

  if (IsRemoteHandle(root_handle)) {
    CloseHandle(root_handle);
    return ThrowError(env, "Network storage roots are not supported for atomic publication.",
                      "ENOTSUP");
  }
  bool supports_hard_links = false;
  if (!QueryHardLinkSupport(root_handle, &supports_hard_links) || !supports_hard_links) {
    CloseHandle(root_handle);
    return ThrowError(env, "The storage root file system does not support hard links.", "ENOTSUP");
  }

  FILE_ATTRIBUTE_TAG_INFO root_attributes{};
  if (!GetFileInformationByHandleEx(
          root_handle, FileAttributeTagInfo, &root_attributes, sizeof(root_attributes)) ||
      (root_attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
      (root_attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
    CloseHandle(root_handle);
    return ThrowError(env, "The storage root is not an anchored directory.", "ELOOP");
  }

  HANDLE parent_handle = CreateFileW(
      parent.c_str(),
      FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr);
  if (parent_handle == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    CloseHandle(root_handle);
    return ThrowError(env, "Could not open the publication parent.", WindowsErrorCode(error));
  }

  FILE_ATTRIBUTE_TAG_INFO parent_attributes{};
  if (!GetFileInformationByHandleEx(
          parent_handle, FileAttributeTagInfo, &parent_attributes, sizeof(parent_attributes)) ||
      (parent_attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
      (parent_attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
    CloseHandle(parent_handle);
    CloseHandle(root_handle);
    return ThrowError(env, "The publication parent is not an anchored directory.", "ELOOP");
  }

  const std::wstring anchored_root_path = HandlePath(root_handle);
  const std::wstring anchored_parent_path = HandlePath(parent_handle);
  if (anchored_root_path.empty() || anchored_parent_path.empty() ||
      !IsSameOrDescendant(anchored_root_path, anchored_parent_path)) {
    CloseHandle(parent_handle);
    CloseHandle(root_handle);
    return ThrowError(env, "The publication parent escaped the storage root.", "ELOOP");
  }

  std::wstring source_path = anchored_parent_path;
  if (!source_path.empty() && source_path.back() != L'\\' && source_path.back() != L'/') {
    source_path.push_back(L'\\');
  }
  source_path.append(source_name);
  HANDLE source_handle = CreateFileW(
      source_path.c_str(),
      DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr);
  if (source_handle == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    CloseHandle(parent_handle);
    CloseHandle(root_handle);
    return ThrowError(env, "Could not open the publication source.", WindowsErrorCode(error));
  }

  FILE_ATTRIBUTE_TAG_INFO source_attributes{};
  const bool source_is_safe =
      GetFileInformationByHandleEx(
          source_handle, FileAttributeTagInfo, &source_attributes, sizeof(source_attributes)) &&
      (source_attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0 &&
      (source_attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
  const std::wstring opened_source_path = HandlePath(source_handle);
  if (!source_is_safe || anchored_parent_path.empty() || opened_source_path.empty() ||
      !SamePath(anchored_parent_path, ParentPath(opened_source_path))) {
    CloseHandle(source_handle);
    CloseHandle(parent_handle);
    CloseHandle(root_handle);
    return ThrowError(env, "The publication source is outside the anchored parent.", "ELOOP");
  }

  const size_t destination_bytes = destination_name.size() * sizeof(wchar_t);
  const size_t link_prefix_size = offsetof(NativeFileLinkInformation, file_name);
  const size_t max_native_buffer = (std::numeric_limits<ULONG>::max)();
  if (destination_bytes > max_native_buffer - link_prefix_size) {
    CloseHandle(source_handle);
    CloseHandle(parent_handle);
    CloseHandle(root_handle);
    return ThrowError(env, "The publication destination name is too long.", "EINVAL");
  }
  size_t link_size = link_prefix_size + destination_bytes;
  if (link_size < sizeof(NativeFileLinkInformation)) {
    link_size = sizeof(NativeFileLinkInformation);
  }
  std::vector<unsigned char> link_buffer(link_size);
  auto* link_info = reinterpret_cast<NativeFileLinkInformation*>(link_buffer.data());
  link_info->replace_if_exists = FALSE;
  link_info->root_directory = parent_handle;
  link_info->file_name_length = static_cast<ULONG>(destination_bytes);
  std::memcpy(link_info->file_name, destination_name.data(), destination_bytes);

  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  const auto nt_set_information_file =
      ntdll == nullptr
          ? nullptr
          : reinterpret_cast<NtSetInformationFileFunction>(
                GetProcAddress(ntdll, "NtSetInformationFile"));
  const auto rtl_nt_status_to_dos_error =
      ntdll == nullptr
          ? nullptr
          : reinterpret_cast<RtlNtStatusToDosErrorFunction>(
                GetProcAddress(ntdll, "RtlNtStatusToDosError"));
  if (nt_set_information_file == nullptr || rtl_nt_status_to_dos_error == nullptr) {
    CloseHandle(source_handle);
    CloseHandle(parent_handle);
    CloseHandle(root_handle);
    return ThrowError(env, "Handle-relative publication is unavailable.", "ENOTSUP");
  }

  // FileLinkInformation binds both the already-open source and parent handles while creating the
  // destination atomically without replacement. Removing the temporary alias is best effort.
  NativeIoStatusBlock io_status{};
  const LONG link_status = nt_set_information_file(
      source_handle,
      &io_status,
      link_info,
      static_cast<ULONG>(link_buffer.size()),
      kFileLinkInformation);
  const bool linked = link_status >= 0;
  const DWORD link_error =
      linked ? ERROR_SUCCESS : rtl_nt_status_to_dos_error(link_status);
  if (linked) {
    FILE_DISPOSITION_INFO disposition{};
    disposition.DeleteFile = TRUE;
    (void)SetFileInformationByHandle(
        source_handle, FileDispositionInfo, &disposition, sizeof(disposition));
  }
  CloseHandle(source_handle);
  CloseHandle(parent_handle);
  CloseHandle(root_handle);
  if (!linked) {
    return ThrowError(env, "Atomic no-replace publication failed.", WindowsErrorCode(link_error));
  }

  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

#else

const char* PosixErrorCode(int error) {
  switch (error) {
    case EEXIST:
    case ENOTEMPTY:
      return "EEXIST";
    case ENOENT:
      return "ENOENT";
    case EXDEV:
      return "EXDEV";
#ifdef ENOTSUP
    case ENOTSUP:
      return "ENOTSUP";
#endif
    case ENOSYS:
      return "ENOTSUP";
    case EACCES:
    case EPERM:
      return "EPERM";
    case ELOOP:
      return "ELOOP";
    default:
      return "EIO";
  }
}

napi_value PublishPosix(
    napi_env env,
    const std::string& root,
    const std::vector<std::string>& parent_components,
    const std::string& source,
    const std::string& destination) {
  const int root_fd = open(root.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root_fd < 0) {
    return ThrowError(env, "Could not open the storage root.", PosixErrorCode(errno));
  }

  int parent_fd = root_fd;
  for (const std::string& component : parent_components) {
    const int next_fd =
        openat(parent_fd, component.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next_fd < 0) {
      const int error = errno;
      if (parent_fd != root_fd) close(parent_fd);
      close(root_fd);
      return ThrowError(env, "Could not anchor the publication parent.", PosixErrorCode(error));
    }
    if (parent_fd != root_fd) close(parent_fd);
    parent_fd = next_fd;
  }

  const int source_fd = openat(parent_fd, source.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (source_fd < 0) {
    const int error = errno;
    if (parent_fd != root_fd) close(parent_fd);
    close(root_fd);
    return ThrowError(env, "Could not open the publication source.", PosixErrorCode(error));
  }

  struct stat source_info {};
  if (fstat(source_fd, &source_info) != 0 || !S_ISREG(source_info.st_mode)) {
    const int error = errno == 0 ? ELOOP : errno;
    close(source_fd);
    if (parent_fd != root_fd) close(parent_fd);
    close(root_fd);
    return ThrowError(env, "The publication source is not anchored safely.", PosixErrorCode(error));
  }

#ifdef __linux__
  int result = static_cast<int>(syscall(
      SYS_renameat2,
      parent_fd,
      source.c_str(),
      parent_fd,
      destination.c_str(),
      RENAME_NOREPLACE));
  int rename_error = result == 0 ? 0 : errno;
  if (result != 0 &&
      (rename_error == ENOSYS || rename_error == EOPNOTSUPP || rename_error == EINVAL)) {
    // linkat creates the destination name atomically without replacing an existing entry. This
    // preserves no-replace publication on older kernels and filesystems that reject renameat2.
    result = linkat(parent_fd, source.c_str(), parent_fd, destination.c_str(), 0);
    rename_error = result == 0 ? 0 : errno;
    if (result != 0 && rename_error != EEXIST && rename_error != ENOTEMPTY) {
      rename_error = ENOTSUP;
    }
    if (result == 0) {
      // Publication is already complete once linkat succeeds. A failed best-effort unlink leaves
      // only the verified temporary alias, which recovery can reclaim as a stale attempt later.
      (void)unlinkat(parent_fd, source.c_str(), 0);
    }
  }
#elif defined(__APPLE__)
  const int result =
      renameatx_np(parent_fd, source.c_str(), parent_fd, destination.c_str(), RENAME_EXCL);
  const int rename_error = result == 0 ? 0 : errno;
#else
#error Unsupported platform for atomic no-replace publication
#endif
  close(source_fd);
  if (parent_fd != root_fd) close(parent_fd);
  close(root_fd);
  if (result != 0) {
    return ThrowError(env, "Atomic no-replace publication failed.", PosixErrorCode(rename_error));
  }

  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

#endif

napi_value InspectPath(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    return ThrowError(env, "inspectPath requires a path.", "EINVAL");
  }

  std::string path;
  if (!ReadString(env, argv[0], &path) || path.empty()) {
    return ThrowError(env, "Invalid storage-path query.", "EINVAL");
  }

  bool is_remote = false;
  bool supports_hard_links = true;
#ifdef _WIN32
  const std::wstring wide_path = Utf8ToWide(path);
  if (wide_path.empty()) {
    return ThrowError(env, "Invalid UTF-8 path for storage-path query.", "EINVAL");
  }
  HANDLE handle = CreateFileW(
      wide_path.c_str(),
      FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS,
      nullptr);
  if (handle == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    return ThrowError(env, "Could not inspect the storage path.", WindowsErrorCode(error));
  }
  is_remote = IsRemoteHandle(handle);
  if (is_remote) {
    supports_hard_links = false;
  } else if (!QueryHardLinkSupport(handle, &supports_hard_links)) {
    const DWORD error = GetLastError();
    CloseHandle(handle);
    return ThrowError(env, "Could not inspect the storage volume.", WindowsErrorCode(error));
  }
  CloseHandle(handle);
#endif

  napi_value result;
  napi_create_object(env, &result);
  napi_value is_remote_value;
  napi_get_boolean(env, is_remote, &is_remote_value);
  napi_set_named_property(env, result, "isRemote", is_remote_value);
  napi_value supports_hard_links_value;
  napi_get_boolean(env, supports_hard_links, &supports_hard_links_value);
  napi_set_named_property(env, result, "supportsHardLinks", supports_hard_links_value);
  return result;
}

napi_value PublishNoReplace(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 4) {
    return ThrowError(
        env, "publishNoReplace requires root, parent, source, and destination.", "EINVAL");
  }

  std::string root;
  std::string relative_parent;
  std::string source;
  std::string destination;
  std::vector<std::string> parent_components;
  if (!ReadString(env, argv[0], &root) || !ReadString(env, argv[1], &relative_parent) ||
      !ReadString(env, argv[2], &source) || !ReadString(env, argv[3], &destination) ||
      root.empty() || !SplitRelativePath(relative_parent, &parent_components) ||
      !IsSimpleName(source) ||
      !IsSimpleName(destination)) {
    return ThrowError(env, "Invalid atomic publication path.", "EINVAL");
  }

#ifdef _WIN32
  return PublishWindows(env, root, parent_components, source, destination);
#else
  return PublishPosix(env, root, parent_components, source, destination);
#endif
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value publish;
  napi_create_function(
      env, "publishNoReplace", NAPI_AUTO_LENGTH, PublishNoReplace, nullptr, &publish);
  napi_set_named_property(env, exports, "publishNoReplace", publish);
  napi_value inspect_path;
  napi_create_function(
      env, "inspectPath", NAPI_AUTO_LENGTH, InspectPath, nullptr, &inspect_path);
  napi_set_named_property(env, exports, "inspectPath", inspect_path);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
