#include <node_api.h>

#include <cerrno>
#include <charconv>
#include <sstream>
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
#include <sys/file.h>
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

struct NativeFileRenameInformation {
  BOOLEAN replace_if_exists;
  HANDLE root_directory;
  ULONG file_name_length;
  WCHAR file_name[1];
};

using NtSetInformationFileFunction = LONG(NTAPI*)(
    HANDLE, NativeIoStatusBlock*, void*, ULONG, ULONG);
using RtlNtStatusToDosErrorFunction = ULONG(NTAPI*)(LONG);

constexpr ULONG kFileRenameInformation = 10;

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
  const size_t rename_prefix_size = offsetof(NativeFileRenameInformation, file_name);
  const size_t max_native_buffer = (std::numeric_limits<ULONG>::max)();
  if (destination_bytes > max_native_buffer - rename_prefix_size) {
    CloseHandle(source_handle);
    CloseHandle(parent_handle);
    CloseHandle(root_handle);
    return ThrowError(env, "The publication destination name is too long.", "EINVAL");
  }
  size_t rename_size = rename_prefix_size + destination_bytes;
  if (rename_size < sizeof(NativeFileRenameInformation)) {
    rename_size = sizeof(NativeFileRenameInformation);
  }
  std::vector<unsigned char> rename_buffer(rename_size);
  auto* rename_info = reinterpret_cast<NativeFileRenameInformation*>(rename_buffer.data());
  rename_info->replace_if_exists = FALSE;
  rename_info->root_directory = parent_handle;
  rename_info->file_name_length = static_cast<ULONG>(destination_bytes);
  std::memcpy(rename_info->file_name, destination_name.data(), destination_bytes);

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

  // FileRenameInformation binds both the already-open source and parent handles while moving the
  // source atomically without replacement. Unlike a hard link, FAT/exFAT supports this operation.
  NativeIoStatusBlock io_status{};
  const LONG rename_status = nt_set_information_file(
      source_handle,
      &io_status,
      rename_info,
      static_cast<ULONG>(rename_buffer.size()),
      kFileRenameInformation);
  const bool renamed = rename_status >= 0;
  const DWORD rename_error =
      renamed ? ERROR_SUCCESS : rtl_nt_status_to_dos_error(rename_status);
  CloseHandle(source_handle);
  CloseHandle(parent_handle);
  CloseHandle(root_handle);
  if (!renamed) {
    return ThrowError(env, "Atomic no-replace publication failed.", WindowsErrorCode(rename_error));
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
    case ESTALE:
      return "ESTALE";
    case EINVAL:
      return "EINVAL";
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

bool IsRemovalDirectory(const std::string& name) {
  const std::string prefix = ".publication-recovery-";
  if (name.size() != prefix.size() + 36 || name.compare(0, prefix.size(), prefix) != 0) return false;
  const std::string id = name.substr(prefix.size());
  for (size_t i = 0; i < id.size(); ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (id[i] != '-') return false;
    } else if (!((id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f'))) return false;
  }
  return id[14] == '4' && (id[19] == '8' || id[19] == '9' || id[19] == 'a' || id[19] == 'b');
}

bool IsPublicationTemporary(const std::string& name) {
  if (name.size() != 105 || name[64] != '.' || name.substr(101) != ".tmp") return false;
  for (size_t i = 0; i < 64; ++i) {
    if (!((name[i] >= '0' && name[i] <= '9') || (name[i] >= 'a' && name[i] <= 'f'))) return false;
  }
  return IsRemovalDirectory(".publication-recovery-" + name.substr(65, 36));
}

#ifndef _WIN32
struct RemovalFd {
  int value;
  explicit RemovalFd(int fd) : value(fd) {}
  ~RemovalFd() { if (value >= 0) close(value); }
  RemovalFd(const RemovalFd&) = delete;
  RemovalFd& operator=(const RemovalFd&) = delete;
};

struct RemovalReceipt {
  std::string name;
  uint64_t parent_dev, parent_ino, dev, ino, size;
  int64_t mtime;
};

int OpenRemovalParent(const std::string& root, const std::vector<std::string>& components,
                      uint64_t dev, uint64_t ino) {
  int parent = open(root.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (parent < 0) return -1;
  for (const auto& component : components) {
    const int next = openat(parent, component.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    const int error = errno;
    close(parent);
    if (next < 0) { errno = error; return -1; }
    parent = next;
  }
  struct stat info {};
  if (fstat(parent, &info) != 0 || static_cast<uint64_t>(info.st_dev) != dev ||
      static_cast<uint64_t>(info.st_ino) != ino) {
    close(parent);
    errno = ESTALE;
    return -1;
  }
  return parent;
}

bool MatchesRemovalFile(const struct stat& info, const RemovalReceipt& receipt) {
#ifdef __APPLE__
  const auto modified = info.st_mtimespec;
#else
  const auto modified = info.st_mtim;
#endif
  return S_ISREG(info.st_mode) && static_cast<uint64_t>(info.st_dev) == receipt.dev &&
      static_cast<uint64_t>(info.st_ino) == receipt.ino &&
      static_cast<uint64_t>(info.st_size) == receipt.size &&
      modified.tv_sec * INT64_C(1000000000) + modified.tv_nsec == receipt.mtime;
}

// Both names are relative to held directories. Never overwrite a concurrently installed leaf.
int MoveRemovalFile(int from, const char* source, int to, const char* destination) {
#ifdef __APPLE__
  return renameatx_np(from, source, to, destination, RENAME_EXCL);
#else
  return static_cast<int>(syscall(SYS_renameat2, from, source, to, destination, RENAME_NOREPLACE));
#endif
}

template <typename T>
bool ReadRemovalNumber(std::istringstream& stream, T* value) {
  std::string line;
  if (!std::getline(stream, line)) return false;
  const auto parsed = std::from_chars(line.data(), line.data() + line.size(), *value);
  return parsed.ec == std::errc() && parsed.ptr == line.data() + line.size() &&
      line == std::to_string(*value);
}

int ReadRemovalReceipt(int directory, RemovalReceipt* receipt) {
  RemovalFd file(openat(directory, "receipt", O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC));
  if (file.value < 0) return -1;
  struct stat info {};
  if (fstat(file.value, &info) != 0 || !S_ISREG(info.st_mode) || info.st_size <= 0 || info.st_size > 4096) {
    errno = EINVAL;
    return -1;
  }
  std::string bytes(static_cast<size_t>(info.st_size), '\0');
  size_t offset = 0;
  while (offset < bytes.size()) {
    const auto count = read(file.value, &bytes[offset], bytes.size() - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { errno = EINVAL; return -1; }
    offset += count;
  }
  std::istringstream stream(bytes);
  std::string version, extra;
  if (!std::getline(stream, version) || version != "publication-removal-v1" ||
      !std::getline(stream, receipt->name) || !IsPublicationTemporary(receipt->name) ||
      receipt->name.find('\0') != std::string::npos || receipt->name.find('\r') != std::string::npos ||
      !ReadRemovalNumber(stream, &receipt->parent_dev) || !ReadRemovalNumber(stream, &receipt->parent_ino) ||
      !ReadRemovalNumber(stream, &receipt->dev) || !ReadRemovalNumber(stream, &receipt->ino) ||
      !ReadRemovalNumber(stream, &receipt->size) || !ReadRemovalNumber(stream, &receipt->mtime) ||
      std::getline(stream, extra)) {
    errno = EINVAL;
    return -1;
  }
  return 0;
}

int WriteRemovalReceipt(int directory, const RemovalReceipt& receipt) {
  const std::string bytes = "publication-removal-v1\n" + receipt.name + "\n" +
      std::to_string(receipt.parent_dev) + "\n" + std::to_string(receipt.parent_ino) + "\n" +
      std::to_string(receipt.dev) + "\n" + std::to_string(receipt.ino) + "\n" +
      std::to_string(receipt.size) + "\n" + std::to_string(receipt.mtime) + "\n";
  RemovalFd file(openat(directory, "receipt", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600));
  if (file.value < 0) return -1;
  size_t offset = 0;
  while (offset < bytes.size()) {
    const auto count = write(file.value, bytes.data() + offset, bytes.size() - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return -1;
    offset += count;
  }
  return fsync(file.value);
}

int FinishRemoval(int parent, int quarantine, const std::string& directory, const RemovalReceipt& receipt) {
  struct stat parent_info {}, payload {}, source {};
  if (fstat(parent, &parent_info) != 0 || static_cast<uint64_t>(parent_info.st_dev) != receipt.parent_dev ||
      static_cast<uint64_t>(parent_info.st_ino) != receipt.parent_ino) { errno = ESTALE; return -1; }
  if (fstatat(quarantine, "payload", &payload, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno != ENOENT) return -1;
    if (fstatat(parent, receipt.name.c_str(), &source, AT_SYMLINK_NOFOLLOW) == 0) {
      if (!MatchesRemovalFile(source, receipt)) { errno = ESTALE; return -1; }
      if (MoveRemovalFile(parent, receipt.name.c_str(), quarantine, "payload") != 0) return -1;
      // The receipt is already durable. Make capture durable before destroying its only copy.
      if (fsync(quarantine) != 0 || fsync(parent) != 0) return -1;
      if (fstatat(quarantine, "payload", &payload, AT_SYMLINK_NOFOLLOW) != 0) return -1;
    } else if (errno != ENOENT) return -1;
    else {
      // A completed unlink, or a candidate removed before capture. Never follow other names.
      if (unlinkat(quarantine, "receipt", 0) != 0 || fsync(quarantine) != 0) return -1;
      if (unlinkat(parent, directory.c_str(), AT_REMOVEDIR) != 0) return -1;
      return fsync(parent);
    }
  }
  if (fstatat(parent, receipt.name.c_str(), &source, AT_SYMLINK_NOFOLLOW) == 0) {
    errno = EEXIST;
    return -1; // Preserve both copies and the receipt; do not admit the reused name on another sweep.
  }
  if (errno != ENOENT) return -1;
  if (!MatchesRemovalFile(payload, receipt)) {
    // Restore without replacement, but retain the receipt as a conflict barrier on later sweeps.
    if (MoveRemovalFile(quarantine, "payload", parent, receipt.name.c_str()) == 0) {
      if (fsync(parent) != 0 || fsync(quarantine) != 0) return -1;
    }
    errno = ESTALE;
    return -1;
  }
  // Only this owner writes the private, locked quarantine. No unlink is performed in the public
  // source directory, so replacing the source leaf cannot redirect this removal.
  if (unlinkat(quarantine, "payload", 0) != 0 || fsync(quarantine) != 0 ||
      unlinkat(quarantine, "receipt", 0) != 0 || fsync(quarantine) != 0) return -1;
  if (unlinkat(parent, directory.c_str(), AT_REMOVEDIR) != 0) return -1;
  return fsync(parent);
}

int OpenRemovalQuarantine(int parent, const std::string& directory) {
  const int fd = openat(parent, directory.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  struct stat info {};
  if (fstat(fd, &info) != 0 || info.st_uid != geteuid() || (info.st_mode & 0077) != 0 ||
      flock(fd, LOCK_EX | LOCK_NB) != 0) {
    close(fd);
    errno = EPERM;
    return -1;
  }
  return fd;
}
#endif

// Bind deletion to an opened parent, not a path checked earlier by JavaScript.
napi_value RemoveAnchoredFile(napi_env env, napi_callback_info info) {
  size_t argc = 10;
  napi_value argv[10];
  std::string root, relative_parent, filename, quarantine;
  std::vector<std::string> components;
  uint64_t expected_dev = 0, expected_ino = 0;
  uint64_t file_dev = 0, file_ino = 0, file_size = 0;
  int64_t file_mtime = 0;
  bool dev_lossless = false, ino_lossless = false, file_dev_ok = false, file_ino_ok = false, size_ok = false, time_ok = false;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 10 ||
      !ReadString(env, argv[0], &root) || !ReadString(env, argv[1], &relative_parent) ||
      !ReadString(env, argv[2], &filename) || root.empty() ||
      root.find('\0') != std::string::npos || relative_parent.find('\0') != std::string::npos ||
      filename.find('\0') != std::string::npos || filename.find_first_of("\r\n") != std::string::npos ||
      !SplitRelativePath(relative_parent, &components) || !IsSimpleName(filename) ||
      napi_get_value_bigint_uint64(env, argv[3], &expected_dev, &dev_lossless) != napi_ok ||
      napi_get_value_bigint_uint64(env, argv[4], &expected_ino, &ino_lossless) != napi_ok ||
      !dev_lossless || !ino_lossless ||
      napi_get_value_bigint_uint64(env, argv[5], &file_dev, &file_dev_ok) != napi_ok ||
      napi_get_value_bigint_uint64(env, argv[6], &file_ino, &file_ino_ok) != napi_ok ||
      napi_get_value_bigint_uint64(env, argv[7], &file_size, &size_ok) != napi_ok ||
      napi_get_value_bigint_int64(env, argv[8], &file_mtime, &time_ok) != napi_ok ||
      !file_dev_ok || !file_ino_ok || !size_ok || !time_ok ||
      !ReadString(env, argv[9], &quarantine) || !IsRemovalDirectory(quarantine)) {
    return ThrowError(env, "Invalid anchored removal arguments.", "EINVAL");
  }
#ifdef _WIN32
  // Denying delete sharing pins every directory while the child is opened. OPEN_REPARSE_POINT
  // rejects junctions at every level; deletion then targets the opened file handle itself.
  std::wstring path = Utf8ToWide(root);
  std::vector<HANDLE> directories;
  auto close_directories = [&]() {
    for (HANDLE handle : directories) CloseHandle(handle);
  };
  for (size_t index = 0; index <= components.size(); ++index) {
    const std::wstring previous_parent = path;
    if (index != 0) {
      if (path.back() != L'\\' && path.back() != L'/') path.push_back(L'\\');
      const auto component = Utf8ToWide(components[index - 1]);
      if (component.empty()) {
        close_directories();
        return ThrowError(env, "Invalid removal directory.", "EINVAL");
      }
      path.append(component);
    }
    HANDLE handle = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES | FILE_TRAVERSE,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
      const DWORD error = GetLastError();
      close_directories();
      return ThrowError(env, "Could not anchor the removal directory.", WindowsErrorCode(error));
    }
    directories.push_back(handle);
    BY_HANDLE_FILE_INFORMATION attributes{};
    if (!GetFileInformationByHandle(handle, &attributes) ||
        (attributes.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
        (attributes.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || IsRemoteHandle(handle)) {
      close_directories();
      return ThrowError(env, "Unsafe removal directory.", "ELOOP");
    }
    if (index == components.size() &&
        (attributes.dwVolumeSerialNumber != expected_dev ||
         ((static_cast<uint64_t>(attributes.nFileIndexHigh) << 32) |
          attributes.nFileIndexLow) != expected_ino)) {
      close_directories();
      return ThrowError(env, "Removal directory changed.", "ESTALE");
    }
    const auto anchored = HandlePath(handle);
    if (anchored.empty() || (index != 0 && !SamePath(ParentPath(anchored), previous_parent))) {
      close_directories();
      return ThrowError(env, "Removal directory escaped its parent.", "ELOOP");
    }
    path = anchored;
  }
  const auto name = Utf8ToWide(filename);
  if (name.empty()) {
    close_directories();
    return ThrowError(env, "Invalid removal filename.", "EINVAL");
  }
  HANDLE file = CreateFileW((path + L"\\" + name).c_str(), DELETE | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    close_directories();
    return ThrowError(env, "Could not open the removal file.", WindowsErrorCode(error));
  }
  BY_HANDLE_FILE_INFORMATION attributes{};
  const bool safe = GetFileInformationByHandle(file, &attributes) &&
      (attributes.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0 &&
      SamePath(ParentPath(HandlePath(file)), path);
  const uint64_t modified = (static_cast<uint64_t>(attributes.ftLastWriteTime.dwHighDateTime) << 32) |
      attributes.ftLastWriteTime.dwLowDateTime;
  const bool matches = safe && attributes.dwVolumeSerialNumber == file_dev &&
      ((static_cast<uint64_t>(attributes.nFileIndexHigh) << 32) | attributes.nFileIndexLow) == file_ino &&
      ((static_cast<uint64_t>(attributes.nFileSizeHigh) << 32) | attributes.nFileSizeLow) == file_size &&
      (static_cast<int64_t>(modified) - INT64_C(116444736000000000)) * 100 == file_mtime;
  if (!matches) {
    CloseHandle(file);
    close_directories();
    return ThrowError(env, "Removal file changed.", "ESTALE");
  }
  FILE_DISPOSITION_INFO disposition{TRUE};
  const bool removed = safe && SetFileInformationByHandle(file, FileDispositionInfo,
      &disposition, sizeof(disposition));
  const DWORD error = GetLastError();
  CloseHandle(file);
  close_directories();
  if (!removed) return ThrowError(env, "Anchored removal failed.", safe ? WindowsErrorCode(error) : "ELOOP");
#else
  RemovalFd parent(OpenRemovalParent(root, components, expected_dev, expected_ino));
  if (parent.value < 0) return ThrowError(env, "Could not anchor removal parent.", PosixErrorCode(errno));
  if (mkdirat(parent.value, quarantine.c_str(), 0700) != 0)
    return ThrowError(env, "Could not create removal quarantine.", PosixErrorCode(errno));
  RemovalFd held(OpenRemovalQuarantine(parent.value, quarantine));
  if (held.value < 0) return ThrowError(env, "Unsafe removal quarantine.", PosixErrorCode(errno));
  const RemovalReceipt receipt{filename, expected_dev, expected_ino, file_dev, file_ino, file_size, file_mtime};
  if (WriteRemovalReceipt(held.value, receipt) != 0 || fsync(held.value) != 0 || fsync(parent.value) != 0 ||
      FinishRemoval(parent.value, held.value, quarantine, receipt) != 0)
    return ThrowError(env, "Publication quarantine requires recovery: " + quarantine, PosixErrorCode(errno));
#endif
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value RecoverAnchoredRemoval(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  std::string root, relative_parent, directory;
  std::vector<std::string> components;
  uint64_t dev = 0, ino = 0;
  bool dev_ok = false, ino_ok = false;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 5 ||
      !ReadString(env, argv[0], &root) || root.empty() || root.find('\0') != std::string::npos ||
      !ReadString(env, argv[1], &relative_parent) || relative_parent.find('\0') != std::string::npos ||
      !SplitRelativePath(relative_parent, &components) || !ReadString(env, argv[2], &directory) ||
      !IsRemovalDirectory(directory) ||
      napi_get_value_bigint_uint64(env, argv[3], &dev, &dev_ok) != napi_ok ||
      napi_get_value_bigint_uint64(env, argv[4], &ino, &ino_ok) != napi_ok || !dev_ok || !ino_ok)
    return ThrowError(env, "Invalid removal recovery arguments.", "EINVAL");
#ifdef _WIN32
  // Windows deletes an identity-checked open handle directly. A transferred POSIX receipt cannot
  // prove identity on this volume; preserve it rather than guessing ownership after migration.
  return ThrowError(env, "POSIX publication quarantine requires its original filesystem.", "ENOTSUP");
#else
  RemovalFd parent(OpenRemovalParent(root, components, dev, ino));
  if (parent.value < 0) return ThrowError(env, "Could not anchor recovery parent.", PosixErrorCode(errno));
  RemovalFd held(OpenRemovalQuarantine(parent.value, directory));
  if (held.value < 0) return ThrowError(env, "Unsafe recovery quarantine.", PosixErrorCode(errno));
  RemovalReceipt receipt{};
  if (ReadRemovalReceipt(held.value, &receipt) != 0) {
    if (errno != ENOENT || unlinkat(parent.value, directory.c_str(), AT_REMOVEDIR) != 0)
      return ThrowError(env, "Unrecognized publication recovery receipt.", PosixErrorCode(errno));
    if (fsync(parent.value) != 0) return ThrowError(env, "Could not sync recovery directory.", PosixErrorCode(errno));
  } else if (components.size() != 3 || components[0] != "content" || components[1] != "blobs" ||
             components[2] != receipt.name.substr(0, 2)) {
    return ThrowError(env, "Recovery receipt is outside the publication namespace.", "EINVAL");
  } else if (FinishRemoval(parent.value, held.value, directory, receipt) != 0) {
    return ThrowError(env, "Publication quarantine requires recovery: " + directory, PosixErrorCode(errno));
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
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
  napi_value remove;
  napi_create_function(env, "removeAnchoredFile", NAPI_AUTO_LENGTH, RemoveAnchoredFile, nullptr, &remove);
  napi_set_named_property(env, exports, "removeAnchoredFile", remove);
  napi_value recover;
  napi_create_function(env, "recoverAnchoredRemoval", NAPI_AUTO_LENGTH, RecoverAnchoredRemoval, nullptr, &recover);
  napi_set_named_property(env, exports, "recoverAnchoredRemoval", recover);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
