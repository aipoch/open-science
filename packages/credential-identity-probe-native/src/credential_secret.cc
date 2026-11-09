// Secret operations are separate from the metadata-only identity probe. Input/output use bounded
// private pipes; no secret, OS error description or account content is written to diagnostics.
#include <array>
#include <cstring>
#include <iostream>
#include <string>
#ifdef __APPLE__
#include <Security/Security.h>
#endif
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wincrypt.h>
#include <fcntl.h>
#include <io.h>
#endif

#include "credential_secret_linux.h"

static void clear(void* memory, size_t size) {
  volatile unsigned char* p = static_cast<volatile unsigned char*>(memory);
  while (size--) *p++ = 0;
}
static bool identity(const std::string& name) {
  return name == "Open-Science" || name == "Open Science" ||
         name == "Open-Science (DEV)" || name == "Open Science (DEV)";
}
// Exit 0 is reserved for a non-empty secret that reached the pipe. Distinct failure codes let the
// caller report which step failed without reading any secret or OS error text.
static int write_secret(const void* data, size_t size) {
  if (size == 0) return 4;
  std::cout.write(static_cast<const char*>(data), static_cast<std::streamsize>(size));
  std::cout.flush();
  return std::cout.good() ? 0 : 5;
}
int main(int argc, char** argv) {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  if (argc < 2) return 2;
  const std::string operation(argv[1]);
  std::array<unsigned char, 65537> input{};
  std::cin.read(reinterpret_cast<char*>(input.data()), input.size());
  const size_t size = static_cast<size_t>(std::cin.gcount());
  if (size > 65536 || std::cin.bad()) return 2;
  int result = 1;
#ifdef __APPLE__
  if (argc == 3 && identity(argv[2]) && (operation == "read-key" || operation == "create-key")) {
    const std::string name(argv[2]);
    const std::string service = name + " Safe Storage";
    std::string account = name + " Key";
    UInt32 length = 0;
    void* password = nullptr;
    auto read = [&]() { return SecKeychainFindGenericPassword(nullptr, service.size(), service.data(), account.size(), account.data(), &length, &password, nullptr); };
    OSStatus status = read();
    if (status == errSecItemNotFound) { account = name; status = read(); }
    if (status == errSecItemNotFound && operation == "create-key" && size > 0 && size <= 1024) {
      account = name + " Key";
      status = SecKeychainAddGenericPassword(nullptr, service.size(), service.data(), account.size(), account.data(), size, input.data(), nullptr);
      // A concurrent first launch may have created the same item. Never replace its secret.
      if (status == errSecSuccess || status == errSecDuplicateItem) status = read();
    }
    if (status == errSecSuccess && password && length > 0 && length <= 1024)
      result = write_secret(password, length);
    if (password) { clear(password, length); SecKeychainItemFreeContent(nullptr, password); }
  }
#elif defined(_WIN32)
  if (argc == 2 && size > 0 && (operation == "protect" || operation == "unprotect")) {
    DATA_BLOB source{static_cast<DWORD>(size), input.data()}, output{};
    BOOL ok = operation == "protect"
      ? CryptProtectData(&source, L"Open-Science", nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output)
      : CryptUnprotectData(&source, nullptr, nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output);
    if (!ok) {
      // Only the numeric Windows error leaves the process, and only with the DPAPI failure code.
      std::cout << GetLastError();
      std::cout.flush();
      result = 3;
    } else if (output.pbData && output.cbData <= 65536) {
      result = write_secret(output.pbData, output.cbData);
    }
    if (output.pbData) { SecureZeroMemory(output.pbData, output.cbData); LocalFree(output.pbData); }
  }
#elif defined(__linux__)
  if (argc >= 4 && identity(argv[2]) && (operation == "read-key" || operation == "create-key")) {
    const std::string backend(argv[3]);
    std::string candidate(reinterpret_cast<char*>(input.data()), size);
    std::string value;
    if (backend == "gnome_libsecret" && argc == 4)
      value = secret_service_key(argv[2], operation == "create-key", candidate);
    else if ((backend == "kwallet" || backend == "kwallet5" || backend == "kwallet6") && argc == 5)
      value = kwallet_key(backend, argv[4], argv[2], operation == "create-key", candidate);
    if (!value.empty() && value.size() <= 1024) result = write_secret(value.data(), value.size());
    clear(value.data(), value.size()); clear(candidate.data(), candidate.size());
  }
#else
  (void)identity;
  (void)write_secret;
  (void)operation;
#endif
  clear(input.data(), input.size());
  return result;
}
