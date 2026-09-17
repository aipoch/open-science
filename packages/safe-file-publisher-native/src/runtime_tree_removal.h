// Included inside the binding's anonymous namespace; shares its path validation and error helpers.
#ifdef _WIN32
struct TreeHandle {
  HANDLE value;
  explicit TreeHandle(HANDLE handle) : value(handle) {}
  ~TreeHandle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  TreeHandle(const TreeHandle&) = delete;
  TreeHandle& operator=(const TreeHandle&) = delete;
};

HANDLE OpenTreeChild(HANDLE parent, const std::wstring& name, bool remove) {
  using OpenFunction = NTSTATUS(NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
      PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
  const auto module = GetModuleHandleW(L"ntdll.dll");
  const auto open = reinterpret_cast<OpenFunction>(GetProcAddress(module, "NtCreateFile"));
  const auto convert = reinterpret_cast<RtlNtStatusToDosErrorFunction>(
      GetProcAddress(module, "RtlNtStatusToDosError"));
  if (!open || !convert || name.size() > 32767) {
    SetLastError(ERROR_NOT_SUPPORTED);
    return INVALID_HANDLE_VALUE;
  }
  UNICODE_STRING string{};
  string.Buffer = const_cast<PWSTR>(name.c_str());
  string.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  string.MaximumLength = string.Length;
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes);
  attributes.RootDirectory = parent;
  attributes.ObjectName = &string;
  attributes.Attributes = 0x40;  // OBJ_CASE_INSENSITIVE
  IO_STATUS_BLOCK status{};
  HANDLE handle = INVALID_HANDLE_VALUE;
  constexpr ULONG disposition = 1;  // FILE_OPEN, not a CreateOptions flag.
  // No FILE_DIRECTORY_FILE: this open accepts regular files and directories alike.
  constexpr ULONG options = 0x00200000 | 0x20 | 0x4000;
  // FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_FOR_BACKUP_INTENT.
  const auto result = open(&handle, FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE |
      (remove ? DELETE : 0), &attributes, &status, nullptr, 0,
      FILE_SHARE_READ | FILE_SHARE_WRITE, disposition, options, nullptr, 0);
  if (result < 0) { SetLastError(convert(result)); return INVALID_HANDLE_VALUE; }
  return handle;
}

bool TreeDirectory(HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO info{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info))) return false;
  if (!(info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
      (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) || IsRemoteHandle(handle)) {
    SetLastError(ERROR_ACCESS_DENIED);
    return false;
  }
  return true;
}

bool RemoveTreeHandle(HANDLE handle, unsigned depth) {
  if (depth > 256) { SetLastError(ERROR_DIRECTORY); return false; }
  FILE_ATTRIBUTE_TAG_INFO info{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info))) return false;
  if ((info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) &&
      !(info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
    // Enumerate the held directory, not its pathname. Opens remain relative to the same handle.
    std::vector<char> buffer(65536);
    bool restart = true;
    while (true) {
      if (!GetFileInformationByHandleEx(handle,
          restart ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo,
          buffer.data(), static_cast<DWORD>(buffer.size()))) {
        if (GetLastError() == ERROR_NO_MORE_FILES) break;
        return false;
      }
      restart = false;
      auto entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(buffer.data());
      while (true) {
        const std::wstring name(entry->FileName, entry->FileNameLength / sizeof(wchar_t));
        if (name != L"." && name != L"..") {
          TreeHandle child(OpenTreeChild(handle, name, true));
          if (child.value == INVALID_HANDLE_VALUE || !RemoveTreeHandle(child.value, depth + 1))
            return false;
        }
        if (!entry->NextEntryOffset) break;
        entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(
            reinterpret_cast<char*>(entry) + entry->NextEntryOffset);
      }
    }
  }
  // Ignore READONLY for this unlink only; never change attributes shared by hard-linked files.
  FILE_DISPOSITION_INFO_EX disposition{};
  disposition.Flags = FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS |
      FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE;
  return SetFileInformationByHandle(handle, FileDispositionInfoEx, &disposition, sizeof(disposition));
}
#else
int OpenRemovalDirectory(int parent, const char* name) {
#ifdef __linux__
  // Device IDs alone miss bind mounts on the same filesystem. Fail closed on kernels
  // without openat2 rather than fall back to traversal that can cross a mount.
  struct open_how how{};
  how.flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC;
  how.resolve = RESOLVE_NO_XDEV | RESOLVE_NO_SYMLINKS | RESOLVE_BENEATH;
  return static_cast<int>(syscall(SYS_openat2, parent, name, &how, sizeof(how)));
#else
  return openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
#endif
}

int RemoveTreeAt(int parent, const char* name, unsigned depth, dev_t device,
                 const struct stat* expected = nullptr) {
  if (depth > 256) { errno = ELOOP; return -1; }
  RemovalFd directory(OpenRemovalDirectory(parent, name));
  if (directory.value < 0) {
    if (errno == ENOENT) return 0;
    if (expected) return -1;
    if (errno != ENOTDIR && errno != ELOOP) return -1;
    // unlinkat never follows the final link, and refuses directories without AT_REMOVEDIR.
    return unlinkat(parent, name, 0);
  }
  struct stat info{};
  if (fstat(directory.value, &info) != 0) return -1;
  if (expected && (info.st_dev != expected->st_dev || info.st_ino != expected->st_ino)) {
    errno = ESTALE; return -1;
  }
  if (info.st_dev != device || info.st_uid != geteuid()) { errno = EPERM; return -1; }
  if (fchmod(directory.value, (info.st_mode & 0777) | S_IRWXU) != 0) return -1;
  const int scan_fd = dup(directory.value);
  if (scan_fd < 0) return -1;
  DIR* scan = fdopendir(scan_fd);
  if (!scan) { const int error = errno; close(scan_fd); errno = error; return -1; }
  int error = 0;
  while (true) {
    errno = 0;
    const auto entry = readdir(scan);
    if (!entry) { error = errno; break; }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (RemoveTreeAt(directory.value, entry->d_name, depth + 1, device) != 0) {
      error = errno;
      break;
    }
  }
  closedir(scan);
  if (error) { errno = error; return -1; }
  // Detect replacements already visible here. POSIX has no inode-conditioned unlink:
  // a replacement after this check can still lose an empty directory entry, but
  // AT_REMOVEDIR neither follows a replacement symlink nor removes a nonempty directory.
  // This is no-follow traversal, not isolation from arbitrary same-UID namespace writers.
  // The execution owner must confirm process-tree reaping before invoking cleanup.
  struct stat current{};
  if (fstatat(parent, name, &current, AT_SYMLINK_NOFOLLOW) != 0) return -1;
  if (current.st_dev != info.st_dev || current.st_ino != info.st_ino) { errno = ESTALE; return -1; }
  return unlinkat(parent, name, AT_REMOVEDIR);
}
#endif

// No Node-API calls on the worker thread. Only native values cross this boundary.
const char* RemoveRuntimeTree(const std::string& root,
    const std::vector<std::string>& components, uint64_t dev, uint64_t ino) {
#ifdef _WIN32
  TreeHandle anchor(CreateFileW(Utf8ToWide(root).c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (anchor.value == INVALID_HANDLE_VALUE || !TreeDirectory(anchor.value))
    return WindowsErrorCode(GetLastError());
  std::vector<HANDLE> parents;
  HANDLE parent = anchor.value;
  DWORD error = ERROR_SUCCESS;
  for (size_t i = 0; i + 1 < components.size(); ++i) {
    HANDLE next = OpenTreeChild(parent, Utf8ToWide(components[i]), false);
    if (next == INVALID_HANDLE_VALUE) { error = GetLastError(); break; }
    parents.push_back(next);
    if (!TreeDirectory(next)) { error = GetLastError(); break; }
    parent = next;
  }
  if (!error) {
    TreeHandle target(OpenTreeChild(parent, Utf8ToWide(components.back()), true));
    BY_HANDLE_FILE_INFORMATION identity{};
    if (target.value == INVALID_HANDLE_VALUE) error = GetLastError();
    else if (!GetFileInformationByHandle(target.value, &identity)) error = GetLastError();
    else if (!TreeDirectory(target.value) || identity.dwVolumeSerialNumber != dev ||
        ((static_cast<uint64_t>(identity.nFileIndexHigh) << 32) | identity.nFileIndexLow) != ino)
      error = ERROR_ACCESS_DENIED;
    else if (!RemoveTreeHandle(target.value, 0)) error = GetLastError();
  }
  for (auto handle : parents) CloseHandle(handle);
  if (error && error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND)
    return WindowsErrorCode(error);
#else
  RemovalFd anchor(open(root.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  if (anchor.value < 0) return PosixErrorCode(errno);
  std::vector<int> parents;
  int parent = anchor.value;
  int error = 0;
  for (size_t i = 0; i + 1 < components.size(); ++i) {
    const int next = OpenRemovalDirectory(parent, components[i].c_str());
    if (next < 0) { error = errno; break; }
    parents.push_back(next);
    parent = next;
  }
  if (!error) {
    struct stat identity{};
    if (fstatat(parent, components.back().c_str(), &identity, AT_SYMLINK_NOFOLLOW) != 0) error = errno;
    else if (!S_ISDIR(identity.st_mode) || static_cast<uint64_t>(identity.st_dev) != dev ||
        static_cast<uint64_t>(identity.st_ino) != ino) error = ESTALE;
    else if (RemoveTreeAt(parent, components.back().c_str(), 0, identity.st_dev, &identity) != 0) error = errno;
  }
  for (int fd : parents) close(fd);
  if (error && error != ENOENT)
    return PosixErrorCode(error);
#endif
  return nullptr;
}

struct TreeRemovalWork {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  std::string root;
  std::vector<std::string> components;
  uint64_t dev;
  uint64_t ino;
  const char* error = nullptr;
};

void ExecuteTreeRemoval(napi_env, void* data) {
  auto* job = static_cast<TreeRemovalWork*>(data);
  job->error = RemoveRuntimeTree(job->root, job->components, job->dev, job->ino);
}

void CompleteTreeRemoval(napi_env env, napi_status status, void* data) {
  auto* job = static_cast<TreeRemovalWork*>(data);
  napi_value result;
  if (status != napi_ok || job->error) {
    napi_value message, code;
    napi_create_string_utf8(env, "Could not safely remove runtime tree.", NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, nullptr, message, &result);
    napi_create_string_utf8(env, job->error ? job->error : "ECANCELED", NAPI_AUTO_LENGTH, &code);
    napi_set_named_property(env, result, "code", code);
    napi_reject_deferred(env, job->deferred, result);
  } else {
    napi_get_undefined(env, &result);
    napi_resolve_deferred(env, job->deferred, result);
  }
  napi_delete_async_work(env, job->work);
  delete job;
}

napi_value RemoveAnchoredTree(napi_env env, napi_callback_info callback) {
  size_t argc = 4;
  napi_value argv[4];
  std::string root, relative;
  std::vector<std::string> components;
  uint64_t dev = 0, ino = 0;
  bool dev_ok = false, ino_ok = false;
  if (napi_get_cb_info(env, callback, &argc, argv, nullptr, nullptr) != napi_ok || argc != 4 ||
      !ReadString(env, argv[0], &root) || !ReadString(env, argv[1], &relative) || root.empty() ||
      root.find('\0') != std::string::npos || relative.find('\0') != std::string::npos ||
      !SplitRelativePath(relative, &components) || components.empty() ||
      napi_get_value_bigint_uint64(env, argv[2], &dev, &dev_ok) != napi_ok ||
      napi_get_value_bigint_uint64(env, argv[3], &ino, &ino_ok) != napi_ok || !dev_ok || !ino_ok) {
    return ThrowError(env, "Invalid runtime tree removal arguments.", "EINVAL");
  }
  auto* job = new TreeRemovalWork();
  job->root = std::move(root);
  job->components = std::move(components);
  job->dev = dev;
  job->ino = ino;
  napi_value promise, name;
  if (napi_create_promise(env, &job->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "removeAnchoredTree", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_async_work(env, nullptr, name, ExecuteTreeRemoval, CompleteTreeRemoval,
          job, &job->work) != napi_ok) {
    delete job;
    return ThrowError(env, "Could not schedule runtime removal.", "EIO");
  }
  if (napi_queue_async_work(env, job->work) != napi_ok) {
    CompleteTreeRemoval(env, napi_generic_failure, job);
  }
  return promise;
}
