#define CREDENTIAL_KEY_VALIDATOR_NO_MAIN
#include "../src/credential_key_validator.cc"

#include <cstdlib>
#include <sstream>
#include <vector>

using credential_key::CryptoApi;
using credential_key::DataBlob;
using credential_key::ReadAndValidate;

namespace {

void Expect(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << '\n';
    std::exit(1);
  }
}

struct Fixture {
  bool succeed = true;
  bool allocate_on_failure = false;
  bool missing_output = false;
  std::uint32_t error = 0;
  std::size_t output_size = 32;
  int calls = 0;
  int zeros = 0;
  int frees = 0;
  std::vector<unsigned char> input;
};

Fixture fixture;

bool Unprotect(const DataBlob& input, std::uint32_t flags, DataBlob* output,
               std::uint32_t* error) {
  Expect(flags == 1, "validation enabled DPAPI user interaction");
  fixture.calls++;
  fixture.input.assign(input.data, input.data + input.size);
  *error = fixture.error;
  if ((fixture.succeed || fixture.allocate_on_failure) && !fixture.missing_output) {
    output->size = static_cast<std::uint32_t>(fixture.output_size);
    output->data = static_cast<unsigned char*>(std::malloc(fixture.output_size));
    for (std::size_t i = 0; i < fixture.output_size; i++) output->data[i] = 0xa7;
  }
  return fixture.succeed;
}

void Zero(void* data, std::size_t size) {
  Expect(size == fixture.output_size, "validator did not clear the full returned buffer");
  auto bytes = static_cast<unsigned char*>(data);
  for (std::size_t i = 0; i < size; i++) bytes[i] = 0;
  fixture.zeros++;
}

void Free(void* data) {
  Expect(fixture.zeros == 1, "validator freed plaintext before zeroization");
  const auto bytes = static_cast<unsigned char*>(data);
  for (std::size_t i = 0; i < fixture.output_size; i++) {
    Expect(bytes[i] == 0, "plaintext survived until LocalFree");
  }
  fixture.frees++;
  std::free(data);
}

const CryptoApi api{Unprotect, Zero, Free};

void Run(const std::string& input, const char* expected_status) {
  std::istringstream stream(input);
  const auto result = ReadAndValidate(stream, api);
  Expect(result.status == expected_status, "wrong validation result status");
  const auto serialized = credential_key::SerializeResult("win32", result);
  Expect(serialized.find("keyBytes") == std::string::npos &&
         serialized.find(std::string(32, static_cast<char>(0xa7))) == std::string::npos,
         "validator disclosed decrypted key bytes");
}

}  // namespace

int main() {
  fixture = {};
  const std::string binary_input("\0\r\n\x1a\xff", 5);
  Run(binary_input, "valid");
  Expect(fixture.input == std::vector<unsigned char>{0, 13, 10, 26, 255}, "stdin bytes changed");
  Expect(fixture.zeros == 1 && fixture.frees == 1, "success did not destroy the plaintext key");

  fixture = {};
  fixture.output_size = 31;
  Run("encrypted", "error");
  Expect(fixture.zeros == 1 && fixture.frees == 1, "short key was not cleared and freed");

  fixture = {};
  fixture.output_size = 33;
  Run("encrypted", "error");
  Expect(fixture.zeros == 1 && fixture.frees == 1, "long key was not cleared and freed");

  fixture = {};
  fixture.succeed = false;
  fixture.error = 13;
  Run("invalid-dpapi", "error");
  Expect(fixture.zeros == 0 && fixture.frees == 0, "validator freed absent failure output");

  fixture = {};
  fixture.succeed = false;
  fixture.error = 1325;
  Run("requires-ui", "access-blocked");

  fixture = {};
  fixture.succeed = false;
  fixture.allocate_on_failure = true;
  fixture.error = 5;
  Run("denied", "access-blocked");
  Expect(fixture.zeros == 1 && fixture.frees == 1, "failure output was not cleared and freed");

  fixture = {};
  Run(std::string(65537, 'x'), "error");
  Expect(fixture.calls == 0, "oversized ciphertext reached CryptoAPI");

  fixture = {};
  Run("", "error");
  Expect(fixture.calls == 0, "empty ciphertext reached CryptoAPI");

  fixture = {};
  Run(std::string(65536, 'x'), "valid");
  Expect(fixture.input.size() == 65536 && fixture.zeros == 1 && fixture.frees == 1,
         "maximum-sized ciphertext did not complete safely");

  fixture = {};
  fixture.missing_output = true;
  Run("encrypted", "error");
  Expect(fixture.zeros == 0 && fixture.frees == 0, "missing success output was not rejected safely");

  std::cout << "passed 10 CryptoAPI fixture scenarios\n";
  return 0;
}
