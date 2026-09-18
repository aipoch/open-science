#include <array>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <string>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wincrypt.h>
#include <dpapi.h>
#include <fcntl.h>
#include <io.h>
#endif

namespace credential_key {

constexpr std::size_t kMaximumCiphertextBytes = 64 * 1024;
constexpr std::uint32_t kForbidUserInterface = 1;

struct DataBlob {
  std::uint32_t size = 0;
  unsigned char* data = nullptr;
};

struct ValidationResult {
  std::string status;
  std::string reason;
  std::uint32_t error_code = 0;
};

struct CryptoApi {
  bool (*unprotect)(const DataBlob&, std::uint32_t, DataBlob*, std::uint32_t*);
  void (*secure_zero)(void*, std::size_t);
  void (*local_free)(void*);
};

struct ScopedPlaintext {
  const CryptoApi& api;
  DataBlob value;
  ~ScopedPlaintext() {
    // DPAPI owns this allocation. Clear every returned byte before releasing it on every path.
    if (value.data) {
      api.secure_zero(value.data, value.size);
      api.local_free(value.data);
    }
  }
};

ValidationResult ReadAndValidate(std::istream& input, const CryptoApi& api) {
  // Read one byte beyond the limit so oversize input is rejected without unbounded allocation.
  std::array<unsigned char, kMaximumCiphertextBytes + 1> ciphertext{};
  input.read(reinterpret_cast<char*>(ciphertext.data()), ciphertext.size());
  const auto size = input.gcount();
  if (input.bad() || (!input.eof() && input.fail())) return {"error", "input-read-failed"};
  if (size <= 0 || static_cast<std::size_t>(size) > kMaximumCiphertextBytes) {
    return {"error", "invalid-ciphertext-size"};
  }

  const DataBlob encrypted{static_cast<std::uint32_t>(size), ciphertext.data()};
  ScopedPlaintext plaintext{api, {}};
  std::uint32_t error = 0;
  if (!api.unprotect(encrypted, kForbidUserInterface, &plaintext.value, &error)) {
    // Windows access/session/UI errors are distinct from malformed or unavailable ciphertext.
    const bool access_blocked = error == 5 || error == 1312 || error == 1325 || error == 1326;
    return {access_blocked ? "access-blocked" : "error", "dpapi-unprotect-failed", error};
  }
  if (!plaintext.value.data || plaintext.value.size != 32) {
    return {"error", "invalid-key-size"};
  }
  return {"valid", "existing-key-validated"};
}

std::string SerializeResult(const std::string& platform, const ValidationResult& result) {
  // Only fixed classification strings and an error number leave the validator process.
  return "{\"schemaVersion\":1,\"platform\":\"" + platform + "\",\"status\":\"" +
      result.status + "\",\"reason\":\"" + result.reason + "\",\"errorCode\":" +
      std::to_string(result.error_code) + "}";
}

#ifdef _WIN32
static_assert(kForbidUserInterface == CRYPTPROTECT_UI_FORBIDDEN);

bool UnprotectWindowsKey(const DataBlob& input, std::uint32_t flags, DataBlob* output,
                         std::uint32_t* error) {
  DATA_BLOB encrypted{input.size, input.data};
  DATA_BLOB plaintext{};
  // No description, optional entropy, prompt, re-protection, or persistence operation is requested.
  const BOOL succeeded = CryptUnprotectData(&encrypted, nullptr, nullptr, nullptr, nullptr,
                                            flags, &plaintext);
  *error = succeeded ? ERROR_SUCCESS : GetLastError();
  output->size = plaintext.cbData;
  output->data = plaintext.pbData;
  return succeeded != FALSE;
}

void ClearWindowsKey(void* data, std::size_t size) {
  SecureZeroMemory(data, size);
}

void FreeWindowsKey(void* data) {
  LocalFree(data);
}
#endif

}  // namespace credential_key

#ifndef CREDENTIAL_KEY_VALIDATOR_NO_MAIN
int main() {
  credential_key::ValidationResult result;
#ifdef _WIN32
  const std::string platform = "win32";
  // Windows text-mode stdin rewrites CRLF and treats 0x1a as EOF; DPAPI needs exact binary bytes.
  if (_setmode(_fileno(stdin), _O_BINARY) == -1) {
    result = {"error", "binary-input-mode-unavailable"};
  } else {
    const credential_key::CryptoApi api{credential_key::UnprotectWindowsKey,
        credential_key::ClearWindowsKey, credential_key::FreeWindowsKey};
    result = credential_key::ReadAndValidate(std::cin, api);
  }
#else
#ifdef __APPLE__
  const std::string platform = "darwin";
#else
  const std::string platform = "linux";
#endif
  result = {"unsupported", "platform-backend-unsupported"};
#endif
  std::cout << credential_key::SerializeResult(platform, result) << '\n';
  return 0;
}
#endif
