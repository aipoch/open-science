#include <node_api.h>

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/syscall.h>
#ifndef AT_EMPTY_PATH
#define AT_EMPTY_PATH 0x1000
#endif
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif
#endif
#ifdef __APPLE__
#include <CommonCrypto/CommonDigest.h>
#include <stdio.h>
#include <sys/clonefile.h>
#ifndef RENAME_EXCL
#define RENAME_EXCL 0x00000004
#endif
#elif defined(__linux__)
#include <openssl/sha.h>
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

bool IsSha256Hex(const std::string& value) {
  if (value.size() != 64) return false;
  return std::all_of(value.begin(), value.end(), [](unsigned char character) {
    return (character >= '0' && character <= '9') ||
           (character >= 'a' && character <= 'f');
  });
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

bool ReadPathArguments(
    napi_env env,
    napi_callback_info info,
    size_t expected_argc,
    napi_value* argv,
    std::string* root,
    std::vector<std::string>* parent_components,
    std::string* name) {
  size_t argc = expected_argc;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok ||
      argc != expected_argc) {
    return false;
  }
  std::string relative_parent;
  return ReadString(env, argv[0], root) && !root->empty() &&
         ReadString(env, argv[1], &relative_parent) &&
         SplitRelativePath(relative_parent, parent_components) && ReadString(env, argv[2], name) &&
         IsSimpleName(*name);
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
    case ENOTDIR:
      return "ELOOP";
    default:
      return "EIO";
  }
}

void CloseAnchoredDirectories(int root_fd, int parent_fd) {
  if (parent_fd != root_fd) close(parent_fd);
  close(root_fd);
}

bool UnlinkNameIfIdentityMatches(
    int parent_fd,
    const std::string& name,
    const struct stat& expected_info) {
  struct stat current_info {};
  if (fstatat(parent_fd, name.c_str(), &current_info, AT_SYMLINK_NOFOLLOW) != 0) {
    return errno == ENOENT;
  }
  if (!S_ISREG(current_info.st_mode) || current_info.st_dev != expected_info.st_dev ||
      current_info.st_ino != expected_info.st_ino) {
    return false;
  }
  return unlinkat(parent_fd, name.c_str(), 0) == 0 || errno == ENOENT;
}

bool NativeTestHooksEnabled() {
  const char* enabled = std::getenv("OPEN_SCIENCE_NATIVE_TEST_HOOKS");
  const char* node_env = std::getenv("NODE_ENV");
  const char* vitest = std::getenv("VITEST");
  return enabled != nullptr && std::strcmp(enabled, "1") == 0 && node_env != nullptr &&
         std::strcmp(node_env, "test") == 0 && vitest != nullptr &&
         std::strcmp(vitest, "true") == 0;
}

void ExitAfterDurableTempForTest() {
  if (!NativeTestHooksEnabled()) return;
  const char* test_exit = std::getenv("OPEN_SCIENCE_TEST_EXIT_AFTER_DURABLE_TEMP");
  if (test_exit != nullptr && std::strcmp(test_exit, "86") == 0) _exit(86);
}

void PauseAfterVerifiedTempForTest() {
  if (!NativeTestHooksEnabled()) return;
  const char* marker = std::getenv("OPEN_SCIENCE_TEST_VERIFIED_TEMP_MARKER");
  const char* resume = std::getenv("OPEN_SCIENCE_TEST_VERIFIED_TEMP_RESUME");
  if (marker == nullptr || resume == nullptr || marker[0] == '\0' || resume[0] == '\0') return;
  const int marker_fd = open(marker, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (marker_fd < 0) _exit(87);
  static constexpr char kVerified[] = "verified";
  if (write(marker_fd, kVerified, sizeof(kVerified) - 1) !=
          static_cast<ssize_t>(sizeof(kVerified) - 1) ||
      fsync(marker_fd) != 0) {
    close(marker_fd);
    _exit(87);
  }
  close(marker_fd);
  for (size_t attempt = 0; attempt < 10'000; attempt += 1) {
    if (access(resume, F_OK) == 0) return;
    usleep(1'000);
  }
  _exit(88);
}

void PauseAfterBoundedReadSizeForTest() {
  if (!NativeTestHooksEnabled()) return;
  const char* marker = std::getenv("OPEN_SCIENCE_TEST_BOUNDED_READ_MARKER");
  const char* resume = std::getenv("OPEN_SCIENCE_TEST_BOUNDED_READ_RESUME");
  if (marker == nullptr || resume == nullptr || marker[0] == '\0' || resume[0] == '\0') return;
  const int marker_fd = open(marker, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (marker_fd < 0) _exit(89);
  close(marker_fd);
  for (size_t attempt = 0; attempt < 10'000; attempt += 1) {
    if (access(resume, F_OK) == 0) return;
    usleep(1'000);
  }
  _exit(90);
}

bool OpenAnchoredParent(
    const std::string& root,
    const std::vector<std::string>& parent_components,
    bool create,
    int* root_fd_out,
    int* parent_fd_out,
    int* error_out) {
  const int root_fd = open(root.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root_fd < 0) {
    *error_out = errno;
    return false;
  }

  int parent_fd = root_fd;
  for (const std::string& component : parent_components) {
    int next_fd =
        openat(parent_fd, component.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    bool created = false;
    if (next_fd < 0 && errno == ENOENT && create) {
      if (mkdirat(parent_fd, component.c_str(), 0700) != 0) {
        *error_out = errno;
        CloseAnchoredDirectories(root_fd, parent_fd);
        return false;
      }
      created = true;
      next_fd =
          openat(parent_fd, component.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    }
    if (next_fd < 0) {
      *error_out = errno;
      CloseAnchoredDirectories(root_fd, parent_fd);
      return false;
    }
    if (created && (fsync(next_fd) != 0 || fsync(parent_fd) != 0)) {
      *error_out = errno;
      close(next_fd);
      CloseAnchoredDirectories(root_fd, parent_fd);
      return false;
    }
    if (parent_fd != root_fd) close(parent_fd);
    parent_fd = next_fd;
  }
  *root_fd_out = root_fd;
  *parent_fd_out = parent_fd;
  return true;
}

bool VerifyFdSha256(
    int file_fd,
    size_t expected_size,
    const std::string& expected_sha256,
    bool* matches,
    int* error_out) {
  *matches = false;
  struct stat info {};
  if (fstat(file_fd, &info) != 0) {
    *error_out = errno;
    return false;
  }
  if (!S_ISREG(info.st_mode)) {
    *error_out = ELOOP;
    return false;
  }
  if (info.st_size < 0 || static_cast<uintmax_t>(info.st_size) != expected_size) return true;
  if (lseek(file_fd, 0, SEEK_SET) < 0) {
    *error_out = errno;
    return false;
  }

#ifdef __APPLE__
  CC_SHA256_CTX context;
  if (CC_SHA256_Init(&context) != 1) {
    *error_out = EIO;
    return false;
  }
#elif defined(__linux__)
  SHA256_CTX context;
  if (SHA256_Init(&context) != 1) {
    *error_out = EIO;
    return false;
  }
#endif
  std::vector<unsigned char> chunk(64 * 1024);
  size_t total = 0;
  while (true) {
    const ssize_t count = read(file_fd, chunk.data(), chunk.size());
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) {
      *error_out = errno;
      return false;
    }
    if (count == 0) break;
    const size_t byte_count = static_cast<size_t>(count);
    if (byte_count > expected_size - (std::min)(total, expected_size)) return true;
#ifdef __APPLE__
    if (CC_SHA256_Update(&context, chunk.data(), static_cast<CC_LONG>(byte_count)) != 1) {
      *error_out = EIO;
      return false;
    }
#elif defined(__linux__)
    if (SHA256_Update(&context, chunk.data(), byte_count) != 1) {
      *error_out = EIO;
      return false;
    }
#endif
    total += byte_count;
  }
  if (total != expected_size) return true;

#ifdef __APPLE__
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  if (CC_SHA256_Final(digest, &context) != 1) {
    *error_out = EIO;
    return false;
  }
#elif defined(__linux__)
  unsigned char digest[SHA256_DIGEST_LENGTH];
  if (SHA256_Final(digest, &context) != 1) {
    *error_out = EIO;
    return false;
  }
#endif
  static constexpr char kHex[] = "0123456789abcdef";
  std::string actual_sha256;
  actual_sha256.resize(64);
  for (size_t index = 0; index < 32; index += 1) {
    actual_sha256[index * 2] = kHex[digest[index] >> 4];
    actual_sha256[index * 2 + 1] = kHex[digest[index] & 0x0f];
  }
  *matches = actual_sha256 == expected_sha256;
  return true;
}

bool FileDescriptorMatchesBytes(
    int file_fd,
    const void* expected_bytes,
    size_t expected_size,
    int* error_out) {
  struct stat info {};
  if (fstat(file_fd, &info) != 0) {
    *error_out = errno;
    return false;
  }
  if (!S_ISREG(info.st_mode) || info.st_size < 0 ||
      static_cast<uintmax_t>(info.st_size) != expected_size) {
    *error_out = EIO;
    return false;
  }
  if (lseek(file_fd, 0, SEEK_SET) < 0) {
    *error_out = errno;
    return false;
  }
  const auto* expected = static_cast<const unsigned char*>(expected_bytes);
  std::vector<unsigned char> chunk(64 * 1024);
  size_t offset = 0;
  while (offset < expected_size) {
    const size_t requested = (std::min)(chunk.size(), expected_size - offset);
    const ssize_t count = read(file_fd, chunk.data(), requested);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0 ||
        std::memcmp(chunk.data(), expected + offset, static_cast<size_t>(count)) != 0) {
      *error_out = count < 0 ? errno : EIO;
      return false;
    }
    offset += static_cast<size_t>(count);
  }
  unsigned char growth_probe = 0;
  ssize_t probe_count = 0;
  do {
    probe_count = read(file_fd, &growth_probe, 1);
  } while (probe_count < 0 && errno == EINTR);
  if (probe_count != 0) {
    *error_out = probe_count < 0 ? errno : EIO;
    return false;
  }
  return true;
}

#ifdef __linux__
int LinkOpenFileDescriptorNoReplace(
    int file_fd,
    int parent_fd,
    const std::string& destination_name) {
  // AT_EMPTY_PATH binds publication to the descriptor that was verified. Some kernels require a
  // capability for this form, so the fallback resolves the same open descriptor through procfs.
  int result = linkat(file_fd, "", parent_fd, destination_name.c_str(), AT_EMPTY_PATH);
  if (result == 0) return 0;
  const int direct_error = errno;
  if (direct_error != EPERM && direct_error != EINVAL && direct_error != ENOENT &&
      direct_error != ENOSYS && direct_error != EOPNOTSUPP) {
    errno = direct_error;
    return -1;
  }
  const std::string source_fd_path = "/proc/self/fd/" + std::to_string(file_fd);
  result = linkat(
      AT_FDCWD,
      source_fd_path.c_str(),
      parent_fd,
      destination_name.c_str(),
      AT_SYMLINK_FOLLOW);
  if (result != 0 && errno == ENOENT) errno = ENOTSUP;
  return result;
}
#endif

napi_value WriteAndPublishNoReplacePosix(
    napi_env env,
    const std::string& root,
    const std::vector<std::string>& parent_components,
    const std::string& temporary_name,
    const std::string& destination_name,
    const void* bytes,
    size_t byte_length) {
  int root_fd = -1;
  int parent_fd = -1;
  int error = 0;
  if (!OpenAnchoredParent(root, parent_components, true, &root_fd, &parent_fd, &error)) {
    return ThrowError(env, "Could not create the anchored temporary parent.", PosixErrorCode(error));
  }
  const int file_fd = openat(
      parent_fd,
      temporary_name.c_str(),
      O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
      0600);
  if (file_fd < 0) {
    error = errno;
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Could not exclusively create the temporary file.", PosixErrorCode(error));
  }

  const auto* cursor = static_cast<const unsigned char*>(bytes);
  size_t remaining = byte_length;
  while (remaining > 0) {
    const ssize_t written = write(file_fd, cursor, remaining);
    if (written < 0) {
      if (errno == EINTR) continue;
      error = errno;
      close(file_fd);
      (void)unlinkat(parent_fd, temporary_name.c_str(), 0);
      CloseAnchoredDirectories(root_fd, parent_fd);
      return ThrowError(env, "Could not write the temporary file.", PosixErrorCode(error));
    }
    cursor += written;
    remaining -= static_cast<size_t>(written);
  }
  if (fsync(file_fd) != 0) {
    error = errno;
    close(file_fd);
    (void)unlinkat(parent_fd, temporary_name.c_str(), 0);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Could not sync the temporary file.", PosixErrorCode(error));
  }
  // Persist the temporary directory entry before publication so startup recovery can find the
  // complete file even if the process exits between this barrier and the no-replace publish.
  if (fsync(parent_fd) != 0) {
    error = errno;
    close(file_fd);
    (void)unlinkat(parent_fd, temporary_name.c_str(), 0);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Could not sync the temporary file parent.", PosixErrorCode(error));
  }
  ExitAfterDurableTempForTest();
  struct stat source_info {};
  if (fstat(file_fd, &source_info) != 0 || !S_ISREG(source_info.st_mode)) {
    error = errno == 0 ? ELOOP : errno;
    close(file_fd);
    (void)unlinkat(parent_fd, temporary_name.c_str(), 0);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "The temporary file identity is invalid.", PosixErrorCode(error));
  }
  PauseAfterVerifiedTempForTest();

#ifdef __linux__
  const int result = LinkOpenFileDescriptorNoReplace(file_fd, parent_fd, destination_name);
  const int publish_error = result == 0 ? 0 : errno;
#elif defined(__APPLE__)
  const int result = fclonefileat(file_fd, parent_fd, destination_name.c_str(), 0);
  const int publish_error = result == 0 ? 0 : errno;
#else
#error Unsupported platform for anchored managed-file publication
#endif
  if (result != 0) {
    close(file_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Atomic no-replace publication failed.", PosixErrorCode(publish_error));
  }

  const int destination_fd =
      openat(parent_fd, destination_name.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  struct stat destination_info {};
  bool destination_is_owned =
      destination_fd >= 0 && fstat(destination_fd, &destination_info) == 0 &&
      S_ISREG(destination_info.st_mode);
#ifdef __linux__
  destination_is_owned = destination_is_owned && source_info.st_dev == destination_info.st_dev &&
                         source_info.st_ino == destination_info.st_ino;
#elif defined(__APPLE__)
  if (destination_is_owned) {
    destination_is_owned =
        FileDescriptorMatchesBytes(destination_fd, bytes, byte_length, &error);
  }
#endif
  if (!destination_is_owned) {
    if (destination_fd >= 0) close(destination_fd);
    close(file_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Published destination identity changed.", "ELOOP");
  }
  if (fsync(destination_fd) != 0) {
    error = errno;
    close(destination_fd);
    close(file_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Could not sync the published destination.", PosixErrorCode(error));
  }
  if (fsync(parent_fd) != 0) {
    error = errno;
    close(destination_fd);
    close(file_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Could not sync the published destination.", PosixErrorCode(error));
  }
  close(destination_fd);
  (void)UnlinkNameIfIdentityMatches(parent_fd, temporary_name, source_info);
  if (fsync(parent_fd) != 0) {
    error = errno;
    close(file_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Could not sync temporary file cleanup.", PosixErrorCode(error));
  }
  close(file_fd);
  CloseAnchoredDirectories(root_fd, parent_fd);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value ReadFilePosix(
    napi_env env,
    const std::string& root,
    const std::vector<std::string>& parent_components,
    const std::string& name,
    size_t max_bytes = std::numeric_limits<size_t>::max()) {
  int root_fd = -1;
  int parent_fd = -1;
  int error = 0;
  if (!OpenAnchoredParent(root, parent_components, false, &root_fd, &parent_fd, &error)) {
    return ThrowError(env, "Could not open the anchored file parent.", PosixErrorCode(error));
  }
  const int file_fd = openat(parent_fd, name.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (file_fd < 0) {
    error = errno;
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Could not open the anchored file.", PosixErrorCode(error));
  }
  struct stat info {};
  if (fstat(file_fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_size < 0) {
    error = errno == 0 ? ELOOP : errno;
    close(file_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "The anchored file is not regular.", PosixErrorCode(error));
  }
  if (static_cast<uintmax_t>(info.st_size) > std::numeric_limits<size_t>::max()) {
    close(file_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "The anchored file is too large.", "EIO");
  }
  if (static_cast<uintmax_t>(info.st_size) > max_bytes) {
    close(file_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "The anchored file exceeds the bounded read limit.", "EFBIG");
  }
  PauseAfterBoundedReadSizeForTest();
  void* output = nullptr;
  napi_value buffer;
  const size_t size = static_cast<size_t>(info.st_size);
  if (napi_create_buffer(env, size, &output, &buffer) != napi_ok) {
    close(file_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Could not allocate the anchored file buffer.", "EIO");
  }
  auto* cursor = static_cast<unsigned char*>(output);
  size_t remaining = size;
  while (remaining > 0) {
    const ssize_t count = read(file_fd, cursor, remaining);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) {
      error = count == 0 ? EIO : errno;
      close(file_fd);
      CloseAnchoredDirectories(root_fd, parent_fd);
      return ThrowError(env, "Could not read the anchored file.", PosixErrorCode(error));
    }
    cursor += count;
    remaining -= static_cast<size_t>(count);
  }
  unsigned char growth_probe = 0;
  while (true) {
    const ssize_t count = read(file_fd, &growth_probe, 1);
    if (count < 0 && errno == EINTR) continue;
    if (count > 0) {
      close(file_fd);
      CloseAnchoredDirectories(root_fd, parent_fd);
      return ThrowError(env, "The anchored file grew during the bounded read.", "EFBIG");
    }
    if (count < 0) {
      error = errno;
      close(file_fd);
      CloseAnchoredDirectories(root_fd, parent_fd);
      return ThrowError(env, "Could not complete the anchored bounded read.", PosixErrorCode(error));
    }
    break;
  }
  close(file_fd);
  CloseAnchoredDirectories(root_fd, parent_fd);
  return buffer;
}

napi_value PublishVerifiedNoReplacePosix(
    napi_env env,
    const std::string& root,
    const std::vector<std::string>& parent_components,
    const std::string& temporary_name,
    const std::string& destination_name,
    const void* expected_bytes,
    size_t expected_size) {
  int root_fd = -1;
  int parent_fd = -1;
  int error = 0;
  if (!OpenAnchoredParent(root, parent_components, false, &root_fd, &parent_fd, &error)) {
    return ThrowError(env, "Could not open the anchored recovery parent.", PosixErrorCode(error));
  }
  const int file_fd = openat(parent_fd, temporary_name.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (file_fd < 0) {
    error = errno;
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Could not open the anchored recovery temp.", PosixErrorCode(error));
  }
  struct stat info {};
  if (fstat(file_fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_size < 0 ||
      static_cast<uintmax_t>(info.st_size) != expected_size) {
    error = errno == 0 ? EIO : errno;
    close(file_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "The anchored recovery temp size is invalid.", PosixErrorCode(error));
  }
  const auto* expected = static_cast<const unsigned char*>(expected_bytes);
  std::vector<unsigned char> chunk(64 * 1024);
  size_t offset = 0;
  while (offset < expected_size) {
    const size_t requested = (std::min)(chunk.size(), expected_size - offset);
    const ssize_t count = read(file_fd, chunk.data(), requested);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0 || std::memcmp(chunk.data(), expected + offset, static_cast<size_t>(count)) != 0) {
      error = count < 0 ? errno : EIO;
      close(file_fd);
      CloseAnchoredDirectories(root_fd, parent_fd);
      return ThrowError(env, "The anchored recovery temp content is invalid.", PosixErrorCode(error));
    }
    offset += static_cast<size_t>(count);
  }
  unsigned char growth_probe = 0;
  ssize_t probe_count = 0;
  do {
    probe_count = read(file_fd, &growth_probe, 1);
  } while (probe_count < 0 && errno == EINTR);
  if (probe_count != 0) {
    error = probe_count < 0 ? errno : EIO;
    close(file_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "The anchored recovery temp content is invalid.", PosixErrorCode(error));
  }
  if (fsync(file_fd) != 0) {
    error = errno;
    close(file_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Could not sync the anchored recovery temp.", PosixErrorCode(error));
  }
  PauseAfterVerifiedTempForTest();

#ifdef __linux__
  const int result = LinkOpenFileDescriptorNoReplace(file_fd, parent_fd, destination_name);
  const int publish_error = result == 0 ? 0 : errno;
#elif defined(__APPLE__)
  const int result = fclonefileat(file_fd, parent_fd, destination_name.c_str(), 0);
  const int publish_error = result == 0 ? 0 : errno;
#else
#error Unsupported platform for anchored managed-file recovery publication
#endif
  if (result != 0) {
    close(file_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Atomic no-replace recovery publication failed.", PosixErrorCode(publish_error));
  }

  const int destination_fd =
      openat(parent_fd, destination_name.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  struct stat destination_info {};
  bool destination_is_owned =
      destination_fd >= 0 && fstat(destination_fd, &destination_info) == 0 &&
      S_ISREG(destination_info.st_mode);
#ifdef __linux__
  destination_is_owned = destination_is_owned && info.st_dev == destination_info.st_dev &&
                         info.st_ino == destination_info.st_ino;
#elif defined(__APPLE__)
  if (destination_is_owned) {
    destination_is_owned =
        FileDescriptorMatchesBytes(destination_fd, expected_bytes, expected_size, &error);
  }
#endif
  if (!destination_is_owned) {
    if (destination_fd >= 0) close(destination_fd);
    close(file_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Published recovery destination identity changed.", "ELOOP");
  }
  if (fsync(destination_fd) != 0) {
    error = errno;
    close(destination_fd);
    close(file_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Could not sync the recovered destination.", PosixErrorCode(error));
  }
  if (fsync(parent_fd) != 0) {
    error = errno;
    close(destination_fd);
    close(file_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Could not sync the recovered destination.", PosixErrorCode(error));
  }
  close(destination_fd);
  (void)UnlinkNameIfIdentityMatches(parent_fd, temporary_name, info);
  if (fsync(parent_fd) != 0) {
    error = errno;
    close(file_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Could not sync recovery temp cleanup.", PosixErrorCode(error));
  }
  close(file_fd);
  CloseAnchoredDirectories(root_fd, parent_fd);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value VerifyFilePosix(
    napi_env env,
    const std::string& root,
    const std::vector<std::string>& parent_components,
    const std::string& name,
    size_t expected_size,
    const std::string& expected_sha256) {
  int root_fd = -1;
  int parent_fd = -1;
  int error = 0;
  if (!OpenAnchoredParent(root, parent_components, false, &root_fd, &parent_fd, &error)) {
    return ThrowError(env, "Could not open the anchored verification parent.", PosixErrorCode(error));
  }
  const int file_fd = openat(parent_fd, name.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (file_fd < 0) {
    error = errno;
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Could not open the anchored verification file.", PosixErrorCode(error));
  }
  bool matches = false;
  const bool verified = VerifyFdSha256(file_fd, expected_size, expected_sha256, &matches, &error);
  close(file_fd);
  CloseAnchoredDirectories(root_fd, parent_fd);
  if (!verified) {
    return ThrowError(env, "Could not verify the anchored file.", PosixErrorCode(error));
  }
  napi_value result;
  napi_get_boolean(env, matches, &result);
  return result;
}

napi_value StatFilePosix(
    napi_env env,
    const std::string& root,
    const std::vector<std::string>& parent_components,
    const std::string& name) {
  int root_fd = -1;
  int parent_fd = -1;
  int error = 0;
  if (!OpenAnchoredParent(root, parent_components, false, &root_fd, &parent_fd, &error)) {
    return ThrowError(env, "Could not open the anchored file parent.", PosixErrorCode(error));
  }
  const int file_fd = openat(parent_fd, name.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (file_fd < 0) {
    error = errno;
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Could not open the anchored file.", PosixErrorCode(error));
  }
  struct stat info {};
  if (fstat(file_fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_size < 0) {
    error = errno == 0 ? ELOOP : errno;
    close(file_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "The anchored file is not regular.", PosixErrorCode(error));
  }
  close(file_fd);
  CloseAnchoredDirectories(root_fd, parent_fd);
  napi_value result;
  napi_create_object(env, &result);
  napi_value size;
  napi_create_double(env, static_cast<double>(info.st_size), &size);
  napi_set_named_property(env, result, "sizeBytes", size);
  return result;
}

napi_value RemoveFilePosix(
    napi_env env,
    const std::string& root,
    const std::vector<std::string>& parent_components,
    const std::string& name) {
  int root_fd = -1;
  int parent_fd = -1;
  int error = 0;
  if (!OpenAnchoredParent(root, parent_components, false, &root_fd, &parent_fd, &error)) {
    if (error == ENOENT) {
      napi_value removed;
      napi_get_boolean(env, false, &removed);
      return removed;
    }
    return ThrowError(env, "Could not open the anchored cleanup parent.", PosixErrorCode(error));
  }
  const int file_fd = openat(parent_fd, name.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (file_fd < 0) {
    error = errno;
    CloseAnchoredDirectories(root_fd, parent_fd);
    if (error == ENOENT) {
      napi_value removed;
      napi_get_boolean(env, false, &removed);
      return removed;
    }
    return ThrowError(env, "Could not open the anchored cleanup file.", PosixErrorCode(error));
  }
  struct stat info {};
  if (fstat(file_fd, &info) != 0 || !S_ISREG(info.st_mode)) {
    error = errno == 0 ? ELOOP : errno;
    close(file_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "The anchored cleanup target is not regular.", PosixErrorCode(error));
  }
  struct stat current_info {};
  if (fstatat(parent_fd, name.c_str(), &current_info, AT_SYMLINK_NOFOLLOW) != 0) {
    error = errno;
    close(file_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Could not verify the anchored cleanup target.", PosixErrorCode(error));
  }
  if (!S_ISREG(current_info.st_mode) || current_info.st_dev != info.st_dev ||
      current_info.st_ino != info.st_ino) {
    close(file_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "The anchored cleanup target identity changed.", "EAGAIN");
  }
  if (unlinkat(parent_fd, name.c_str(), 0) != 0) {
    error = errno;
    close(file_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Could not remove the anchored file.", PosixErrorCode(error));
  }
  close(file_fd);
  if (fsync(parent_fd) != 0) {
    error = errno;
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Could not sync anchored cleanup.", PosixErrorCode(error));
  }
  CloseAnchoredDirectories(root_fd, parent_fd);
  napi_value removed;
  napi_get_boolean(env, true, &removed);
  return removed;
}

napi_value ListDirectoryPosix(
    napi_env env,
    const std::string& root,
    const std::vector<std::string>& parent_components) {
  int root_fd = -1;
  int parent_fd = -1;
  int error = 0;
  if (!OpenAnchoredParent(root, parent_components, false, &root_fd, &parent_fd, &error)) {
    return ThrowError(env, "Could not open the anchored directory.", PosixErrorCode(error));
  }
  const int directory_fd = dup(parent_fd);
  if (directory_fd < 0) {
    error = errno;
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Could not duplicate the anchored directory.", PosixErrorCode(error));
  }
  DIR* directory = fdopendir(directory_fd);
  if (directory == nullptr) {
    error = errno;
    close(directory_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Could not enumerate the anchored directory.", PosixErrorCode(error));
  }

  napi_value entries;
  napi_create_array(env, &entries);
  uint32_t index = 0;
  errno = 0;
  while (dirent* entry = readdir(directory)) {
    const std::string name(entry->d_name);
    if (name == "." || name == "..") continue;
    struct stat info {};
    if (fstatat(parent_fd, name.c_str(), &info, AT_SYMLINK_NOFOLLOW) != 0) {
      error = errno;
      closedir(directory);
      CloseAnchoredDirectories(root_fd, parent_fd);
      return ThrowError(env, "Could not inspect an anchored directory entry.", PosixErrorCode(error));
    }
    napi_value item;
    napi_create_object(env, &item);
    napi_value name_value;
    napi_create_string_utf8(env, name.c_str(), name.size(), &name_value);
    napi_set_named_property(env, item, "name", name_value);
    napi_value is_file;
    napi_get_boolean(env, S_ISREG(info.st_mode), &is_file);
    napi_set_named_property(env, item, "isFile", is_file);
#ifdef __APPLE__
    const double mtime_ms = static_cast<double>(info.st_mtimespec.tv_sec) * 1000.0 +
                            static_cast<double>(info.st_mtimespec.tv_nsec) / 1000000.0;
#else
    const double mtime_ms = static_cast<double>(info.st_mtim.tv_sec) * 1000.0 +
                            static_cast<double>(info.st_mtim.tv_nsec) / 1000000.0;
#endif
    napi_value mtime_value;
    napi_create_double(env, mtime_ms, &mtime_value);
    napi_set_named_property(env, item, "mtimeMs", mtime_value);
    napi_set_element(env, entries, index++, item);
  }
  error = errno;
  closedir(directory);
  CloseAnchoredDirectories(root_fd, parent_fd);
  if (error != 0) {
    return ThrowError(env, "Could not enumerate the anchored directory.", PosixErrorCode(error));
  }
  return entries;
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
  if (result != 0) {
    close(source_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Atomic no-replace publication failed.", PosixErrorCode(rename_error));
  }

  if (fsync(parent_fd) != 0) {
    const int sync_error = errno;
    close(source_fd);
    CloseAnchoredDirectories(root_fd, parent_fd);
    return ThrowError(env, "Atomic publication directory sync failed.", PosixErrorCode(sync_error));
  }
  close(source_fd);
  CloseAnchoredDirectories(root_fd, parent_fd);

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

napi_value WriteAndPublishNoReplace(napi_env env, napi_callback_info info) {
  napi_value argv[5];
  std::string root;
  std::string temporary_name;
  std::string destination_name;
  std::vector<std::string> parent_components;
  if (!ReadPathArguments(env, info, 5, argv, &root, &parent_components, &temporary_name) ||
      !ReadString(env, argv[3], &destination_name) || !IsSimpleName(destination_name)) {
    return ThrowError(
        env,
        "writeAndPublishNoReplace requires a safe root, parent, temporary name, destination, and Buffer.",
        "EINVAL");
  }
  bool is_buffer = false;
  void* bytes = nullptr;
  size_t byte_length = 0;
  if (napi_is_buffer(env, argv[4], &is_buffer) != napi_ok || !is_buffer ||
      napi_get_buffer_info(env, argv[4], &bytes, &byte_length) != napi_ok) {
    return ThrowError(env, "writeAndPublishNoReplace bytes must be a Buffer.", "EINVAL");
  }
#ifdef _WIN32
  return ThrowError(env, "Anchored write publication is unavailable on this platform.",
                    "ENOTSUP");
#else
  return WriteAndPublishNoReplacePosix(
      env, root, parent_components, temporary_name, destination_name, bytes, byte_length);
#endif
}

napi_value ReadAnchoredFile(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  std::string root;
  std::string name;
  std::vector<std::string> parent_components;
  if (!ReadPathArguments(env, info, 3, argv, &root, &parent_components, &name)) {
    return ThrowError(env, "readFile requires a safe root, parent, and name.", "EINVAL");
  }
#ifdef _WIN32
  return ThrowError(env, "Anchored file reading is unavailable on this platform.", "ENOTSUP");
#else
  return ReadFilePosix(env, root, parent_components, name);
#endif
}

napi_value ReadAnchoredFileBounded(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  std::string root;
  std::string name;
  std::vector<std::string> parent_components;
  if (!ReadPathArguments(env, info, 4, argv, &root, &parent_components, &name)) {
    return ThrowError(env, "readFileBounded requires a safe root, parent, name, and maxBytes.", "EINVAL");
  }
  double max_bytes = 0;
  if (napi_get_value_double(env, argv[3], &max_bytes) != napi_ok || !std::isfinite(max_bytes) ||
      std::floor(max_bytes) != max_bytes || max_bytes < 0 ||
      max_bytes > 9007199254740991.0 ||
      max_bytes > static_cast<double>(std::numeric_limits<size_t>::max())) {
    return ThrowError(env, "readFileBounded maxBytes is invalid.", "EINVAL");
  }
#ifdef _WIN32
  return ThrowError(env, "Anchored bounded reading is unavailable on this platform.", "ENOTSUP");
#else
  return ReadFilePosix(env, root, parent_components, name, static_cast<size_t>(max_bytes));
#endif
}

napi_value PublishVerifiedNoReplace(napi_env env, napi_callback_info info) {
  napi_value argv[5];
  std::string root;
  std::string temporary_name;
  std::string destination_name;
  std::vector<std::string> parent_components;
  if (!ReadPathArguments(env, info, 5, argv, &root, &parent_components, &temporary_name) ||
      !ReadString(env, argv[3], &destination_name) || !IsSimpleName(destination_name)) {
    return ThrowError(env, "publishVerifiedNoReplace requires safe anchored names and expected bytes.", "EINVAL");
  }
  bool is_buffer = false;
  void* bytes = nullptr;
  size_t byte_length = 0;
  if (napi_is_buffer(env, argv[4], &is_buffer) != napi_ok || !is_buffer ||
      napi_get_buffer_info(env, argv[4], &bytes, &byte_length) != napi_ok) {
    return ThrowError(env, "publishVerifiedNoReplace expected bytes must be a Buffer.", "EINVAL");
  }
#ifdef _WIN32
  return ThrowError(env, "Anchored recovery publication is unavailable on this platform.", "ENOTSUP");
#else
  return PublishVerifiedNoReplacePosix(
      env, root, parent_components, temporary_name, destination_name, bytes, byte_length);
#endif
}

napi_value VerifyAnchoredFile(napi_env env, napi_callback_info info) {
  napi_value argv[5];
  std::string root;
  std::string name;
  std::string expected_sha256;
  std::vector<std::string> parent_components;
  if (!ReadPathArguments(env, info, 5, argv, &root, &parent_components, &name) ||
      !ReadString(env, argv[4], &expected_sha256) || !IsSha256Hex(expected_sha256)) {
    return ThrowError(
        env, "verifyFile requires a safe root, parent, name, size, and lowercase SHA-256.", "EINVAL");
  }
  double expected_size = 0;
  if (napi_get_value_double(env, argv[3], &expected_size) != napi_ok ||
      !std::isfinite(expected_size) || std::floor(expected_size) != expected_size ||
      expected_size < 0 || expected_size > 9007199254740991.0 ||
      expected_size > static_cast<double>(std::numeric_limits<size_t>::max())) {
    return ThrowError(env, "verifyFile expected size is invalid.", "EINVAL");
  }
#ifdef _WIN32
  return ThrowError(env, "Anchored streaming verification is unavailable on this platform.",
                    "ENOTSUP");
#else
  return VerifyFilePosix(
      env,
      root,
      parent_components,
      name,
      static_cast<size_t>(expected_size),
      expected_sha256);
#endif
}

napi_value StatAnchoredFile(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  std::string root;
  std::string name;
  std::vector<std::string> parent_components;
  if (!ReadPathArguments(env, info, 3, argv, &root, &parent_components, &name)) {
    return ThrowError(env, "statFile requires a safe root, parent, and name.", "EINVAL");
  }
#ifdef _WIN32
  return ThrowError(env, "Anchored file metadata is unavailable on this platform.", "ENOTSUP");
#else
  return StatFilePosix(env, root, parent_components, name);
#endif
}

napi_value RemoveAnchoredFile(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  std::string root;
  std::string name;
  std::vector<std::string> parent_components;
  if (!ReadPathArguments(env, info, 3, argv, &root, &parent_components, &name)) {
    return ThrowError(env, "removeFile requires a safe root, parent, and name.", "EINVAL");
  }
#ifdef _WIN32
  return ThrowError(env, "Anchored file cleanup is unavailable on this platform.", "ENOTSUP");
#else
  return RemoveFilePosix(env, root, parent_components, name);
#endif
}

napi_value ListAnchoredDirectory(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2) {
    return ThrowError(env, "listDirectory requires a safe root and parent.", "EINVAL");
  }
  std::string root;
  std::string relative_parent;
  std::vector<std::string> parent_components;
  if (!ReadString(env, argv[0], &root) || root.empty() ||
      !ReadString(env, argv[1], &relative_parent) ||
      !SplitRelativePath(relative_parent, &parent_components)) {
    return ThrowError(env, "listDirectory requires a safe root and parent.", "EINVAL");
  }
#ifdef _WIN32
  return ThrowError(env, "Anchored directory enumeration is unavailable on this platform.",
                    "ENOTSUP");
#else
  return ListDirectoryPosix(env, root, parent_components);
#endif
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value supports_anchored_writes;
#ifdef _WIN32
  napi_get_boolean(env, false, &supports_anchored_writes);
#else
  napi_get_boolean(env, true, &supports_anchored_writes);
#endif
  napi_set_named_property(env, exports, "supportsAnchoredWrites", supports_anchored_writes);
  napi_value publish;
  napi_create_function(
      env, "publishNoReplace", NAPI_AUTO_LENGTH, PublishNoReplace, nullptr, &publish);
  napi_set_named_property(env, exports, "publishNoReplace", publish);
  napi_value inspect_path;
  napi_create_function(
      env, "inspectPath", NAPI_AUTO_LENGTH, InspectPath, nullptr, &inspect_path);
  napi_set_named_property(env, exports, "inspectPath", inspect_path);
  napi_value write_and_publish;
  napi_create_function(env, "writeAndPublishNoReplace", NAPI_AUTO_LENGTH,
                       WriteAndPublishNoReplace, nullptr, &write_and_publish);
  napi_set_named_property(env, exports, "writeAndPublishNoReplace", write_and_publish);
  napi_value read_file;
  napi_create_function(
      env, "readFile", NAPI_AUTO_LENGTH, ReadAnchoredFile, nullptr, &read_file);
  napi_set_named_property(env, exports, "readFile", read_file);
  napi_value read_file_bounded;
  napi_create_function(env, "readFileBounded", NAPI_AUTO_LENGTH,
                       ReadAnchoredFileBounded, nullptr, &read_file_bounded);
  napi_set_named_property(env, exports, "readFileBounded", read_file_bounded);
  napi_value publish_verified;
  napi_create_function(env, "publishVerifiedNoReplace", NAPI_AUTO_LENGTH,
                       PublishVerifiedNoReplace, nullptr, &publish_verified);
  napi_set_named_property(env, exports, "publishVerifiedNoReplace", publish_verified);
  napi_value verify_file;
  napi_create_function(
      env, "verifyFile", NAPI_AUTO_LENGTH, VerifyAnchoredFile, nullptr, &verify_file);
  napi_set_named_property(env, exports, "verifyFile", verify_file);
  napi_value stat_file;
  napi_create_function(
      env, "statFile", NAPI_AUTO_LENGTH, StatAnchoredFile, nullptr, &stat_file);
  napi_set_named_property(env, exports, "statFile", stat_file);
  napi_value remove_file;
  napi_create_function(
      env, "removeFile", NAPI_AUTO_LENGTH, RemoveAnchoredFile, nullptr, &remove_file);
  napi_set_named_property(env, exports, "removeFile", remove_file);
  napi_value list_directory;
  napi_create_function(
      env, "listDirectory", NAPI_AUTO_LENGTH, ListAnchoredDirectory, nullptr, &list_directory);
  napi_set_named_property(env, exports, "listDirectory", list_directory);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
