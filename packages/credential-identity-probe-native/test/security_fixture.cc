#define CREDENTIAL_IDENTITY_PROBE_NO_MAIN
#include "../src/credential_identity_probe.cc"

#include <cstdlib>
#include <cstring>
#include <vector>

using credential_identity::ProbeIdentity;
using credential_identity::ProbeResult;
using credential_identity::SecurityApi;

namespace {

void Expect(bool condition, const char* message) {
  if (!condition) {
    std::cerr << message << '\n';
    std::exit(1);
  }
}

struct Fixture {
  std::string identity = "Open Science (DEV)";
  bool interaction = true;
  bool fail_get = false;
  bool fail_disable = false;
  bool ignore_disable = false;
  bool fail_restore = false;
  bool locked = false;
  bool unrelated_locked = false;
  bool admin_keychain = false;
  bool first_keychain_admin = false;
  bool second_keychain = false;
  bool owner_second = false;
  bool missing_reference = false;
  bool wrong_reference_type = false;
  bool owner_outside = false;
  bool list_changes_after_query = false;
  bool list_changes_after_owner = false;
  bool owner_called = false;
  OSStatus owner_status = errSecSuccess;
  bool locks_after_query = false;
  bool unreadable = false;
  bool empty_search_list = false;
  bool malformed_result = false;
  bool dictionary_result = false;
  bool result_has_secret = false;
  std::string attribute_variant;
  OSStatus search_status = errSecSuccess;
  OSStatus keychain_status = errSecSuccess;
  OSStatus primary_status = errSecItemNotFound;
  OSStatus legacy_status = errSecItemNotFound;
  int matches = 1;
  int queries = 0;
  int restorations = 0;
  std::vector<std::string> accounts;
};

Fixture fixture;

OSStatus GetInteraction(Boolean* allowed) {
  if (fixture.fail_get) return errSecNotAvailable;
  *allowed = fixture.interaction;
  return errSecSuccess;
}

OSStatus SetInteraction(Boolean allowed) {
  if (!allowed && fixture.fail_disable) return errSecNotAvailable;
  if (allowed) {
    fixture.restorations++;
    if (fixture.fail_restore) return errSecNotAvailable;
  }
  if (!allowed && fixture.ignore_disable) return errSecSuccess;
  fixture.interaction = allowed;
  return errSecSuccess;
}

OSStatus CopySearchList(CFArrayRef* result) {
  Expect(!fixture.interaction, "search list accessed while interaction was enabled");
  if (fixture.search_status != errSecSuccess) return fixture.search_status;
  const void* values[] = {CFSTR("fake-keychain"), CFSTR("unrelated-keychain")};
  if ((fixture.list_changes_after_query && fixture.queries) ||
      (fixture.list_changes_after_owner && fixture.owner_called)) {
    values[0] = CFSTR("replaced-keychain");
  }
  *result = CFArrayCreate(nullptr, values, fixture.empty_search_list ? 0 : ((fixture.unrelated_locked || fixture.second_keychain) ? 2 : 1),
                         &kCFTypeArrayCallBacks);
  return errSecSuccess;
}

OSStatus GetStatus(SecKeychainRef keychain, SecKeychainStatus* status) {
  Expect(!fixture.interaction, "keychain status accessed while interaction was enabled");
  if (fixture.keychain_status != errSecSuccess) return fixture.keychain_status;
  *status = (fixture.unreadable ? 0 : kSecReadPermStatus) |
            (((fixture.locked && CFEqual(keychain, CFSTR("fake-keychain"))) || (fixture.unrelated_locked && CFEqual(keychain, CFSTR("unrelated-keychain"))) || (fixture.locks_after_query && fixture.queries))
                 ? 0 : kSecUnlockStateStatus);
  return errSecSuccess;
}

OSStatus GetPath(SecKeychainRef keychain, UInt32* length, char* path) {
  const char* source = "/Users/example/Library/Keychains/login.keychain-db";
  if (fixture.first_keychain_admin && CFEqual(keychain, CFSTR("fake-keychain")))
    source = "/Library/Keychains/System.keychain";
  if (fixture.admin_keychain && CFEqual(keychain, CFSTR("unrelated-keychain")))
    source = "/Library/Keychains/System.keychain";
  const auto size = static_cast<UInt32>(std::strlen(source));
  Expect(*length >= size, "path buffer smaller than the fixture path");
  std::memcpy(path, source, size);
  *length = size;
  return errSecSuccess;
}

std::string StringValue(CFTypeRef value) {
  char buffer[256];
  Expect(value && CFGetTypeID(value) == CFStringGetTypeID(), "expected string attribute");
  Expect(CFStringGetCString(static_cast<CFStringRef>(value), buffer, sizeof(buffer),
                           kCFStringEncodingUTF8), "string conversion failed");
  return buffer;
}

OSStatus CopyMatching(CFDictionaryRef query, CFTypeRef* result) {
  // These assertions protect the actual Security API boundary: a wrong query would read secrets.
  Expect(!fixture.interaction, "metadata query allowed authentication UI");
  Expect(CFEqual(CFDictionaryGetValue(query, kSecClass), kSecClassGenericPassword),
         "query was not restricted to generic passwords");
  Expect(CFDictionaryGetValue(query, kSecReturnData) == kCFBooleanFalse,
         "query requested password data");
  Expect(CFDictionaryGetValue(query, kSecReturnRef) == kCFBooleanTrue,
         "query did not return the temporary ownership reference");
  Expect(CFDictionaryGetValue(query, kSecReturnPersistentRef) == kCFBooleanFalse,
         "query returned persistent credential references");
  Expect(CFDictionaryGetValue(query, kSecReturnAttributes) == kCFBooleanTrue,
         "query did not request metadata");
  Expect(CFEqual(CFDictionaryGetValue(query, kSecUseAuthenticationUI),
                 kSecUseAuthenticationUIFail), "query omitted the secondary UI guard");
  Expect(CFDictionaryGetValue(query, kSecUseDataProtectionKeychain) == kCFBooleanFalse,
         "query changed the Electron file-keychain backend");
  int match_limit = 0;
  Expect(CFNumberGetValue(static_cast<CFNumberRef>(CFDictionaryGetValue(query, kSecMatchLimit)),
                         kCFNumberIntType, &match_limit) && match_limit == 2,
         "query cannot detect duplicate accounts within its bounded result");
  auto search_list = static_cast<CFArrayRef>(CFDictionaryGetValue(query, kSecMatchSearchList));
  Expect(search_list && CFArrayGetCount(search_list) == ((fixture.unrelated_locked || fixture.second_keychain) ? 2 : 1), "query lost its search list");
  Expect(StringValue(CFDictionaryGetValue(query, kSecAttrService)) ==
             fixture.identity + " Safe Storage", "wrong service");
  const auto account = StringValue(CFDictionaryGetValue(query, kSecAttrAccount));
  fixture.accounts.push_back(account);
  fixture.queries++;
  const OSStatus status = account == fixture.identity + " Key" ? fixture.primary_status
                                                            : fixture.legacy_status;
  if (status != errSecSuccess) return status;
  if (fixture.malformed_result) {
    *result = CFRetain(CFSTR("malformed"));
    return errSecSuccess;
  }
  CFMutableArrayRef items = CFArrayCreateMutable(nullptr, 0, &kCFTypeArrayCallBacks);
  for (int i = 0; i < fixture.matches; i++) {
    CFMutableDictionaryRef attributes = CFDictionaryCreateMutable(
        nullptr, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFDictionarySetValue(attributes, kSecAttrService, CFDictionaryGetValue(query, kSecAttrService));
    CFDictionarySetValue(attributes, kSecAttrAccount, CFDictionaryGetValue(query, kSecAttrAccount));
    if (fixture.attribute_variant == "missing-service") CFDictionaryRemoveValue(attributes, kSecAttrService);
    if (fixture.attribute_variant == "missing-account") CFDictionaryRemoveValue(attributes, kSecAttrAccount);
    if (fixture.attribute_variant == "non-string-service") CFDictionarySetValue(attributes, kSecAttrService, kCFBooleanTrue);
    if (fixture.attribute_variant == "non-string-account") CFDictionarySetValue(attributes, kSecAttrAccount, kCFBooleanTrue);
    if (fixture.attribute_variant == "different-service") CFDictionarySetValue(attributes, kSecAttrService, CFSTR("Different Safe Storage"));
    if (fixture.attribute_variant == "different-account") CFDictionarySetValue(attributes, kSecAttrAccount, CFSTR("Different Key"));
    if (!fixture.missing_reference) CFDictionarySetValue(attributes, kSecValueRef,
        fixture.wrong_reference_type ? static_cast<CFTypeRef>(kCFBooleanTrue) : CFSTR("item-reference"));
    if (fixture.result_has_secret) CFDictionarySetValue(attributes, kSecValueData, CFSTR("never-output"));
    if (fixture.dictionary_result) {
      *result = attributes;
      CFRelease(items);
      return errSecSuccess;
    }
    CFArrayAppendValue(items, attributes);
    CFRelease(attributes);
  }
  *result = items;
  return errSecSuccess;
}

OSStatus CopyItemKeychain(SecKeychainItemRef reference, SecKeychainRef* keychain) {
  Expect(!fixture.interaction, "owner query allowed authentication UI");
  Expect(CFEqual(reference, CFSTR("item-reference")), "invalid reference reached owner lookup");
  fixture.owner_called = true;
  if (fixture.owner_status != errSecSuccess) return fixture.owner_status;
  *keychain = reinterpret_cast<SecKeychainRef>(const_cast<void*>(CFRetain(
      fixture.owner_outside ? CFSTR("outside-keychain") :
      fixture.owner_second ? CFSTR("unrelated-keychain") : CFSTR("fake-keychain"))));
  return errSecSuccess;
}

const SecurityApi api{GetInteraction, SetInteraction, CopySearchList, GetStatus, GetPath,
                      CopyMatching, CFStringGetTypeID, CopyItemKeychain};
int scenarios = 0;

ProbeResult Run(const char* expected_status, const char* expected_reason = nullptr) {
  ++scenarios;
  ProbeResult result = ProbeIdentity(fixture.identity, api);
  if (result.status != expected_status) std::cerr << "scenario " << scenarios << ": " << result.status << "/" << result.reason << '\n';
  Expect(result.status == expected_status, "wrong probe result status");
  if (expected_reason) Expect(result.reason == expected_reason, "wrong probe result reason");
  return result;
}

}  // namespace

int main() {
  // Every scenario starts with an independent fake Keychain; no system Security call is reachable.
  fixture = {};
  fixture.primary_status = errSecSuccess;
  auto result = Run("exists");
  Expect(result.account == fixture.identity + " Key", "wrong primary account");
  Expect(fixture.queries == 1 && fixture.restorations == 1 && fixture.interaction,
         "primary lookup did not stop and restore interaction");

  fixture = {};
  fixture.primary_status = errSecSuccess;
  fixture.unrelated_locked = true;
  fixture.identity = "Open-Science (DEV)";
  Run("exists");
  Expect(fixture.queries == 1, "unrelated lock prevented a positive primary lookup");

  fixture = {};
  fixture.legacy_status = errSecSuccess;
  result = Run("exists");
  Expect(result.account == "Open Science (DEV)", "wrong legacy account");
  Expect(fixture.accounts == std::vector<std::string>{"Open Science (DEV) Key", "Open Science (DEV)"},
         "legacy lookup did not follow a definite primary absence");

  fixture = {};
  Run("not-found");
  Expect(fixture.queries == 2 && fixture.interaction, "absence was not checked across both accounts");

  fixture = {};
  fixture.primary_status = errSecInteractionNotAllowed;
  Run("access-blocked");
  Expect(fixture.queries == 1, "blocked primary incorrectly fell back to legacy");

  fixture = {};
  fixture.primary_status = errSecNotAvailable;
  Run("error");
  Expect(fixture.queries == 1, "primary error incorrectly fell back to legacy");

  fixture = {};
  fixture.locked = true;
  Run("access-blocked", "keychain-locked");
  Expect(fixture.queries == 1, "incomplete search permitted account fallback");

  fixture = {};
  fixture.unreadable = true;
  Run("access-blocked", "keychain-unreadable");
  Expect(fixture.queries == 0, "unreadable keychain was queried");

  fixture = {};
  fixture.locks_after_query = true;
  Run("access-blocked", "keychain-state-changed");
  Expect(fixture.queries == 1, "lock transition permitted a fallback");

  fixture = {};
  fixture.fail_get = true;
  Run("error", "interaction-state-unavailable");
  Expect(fixture.queries == 0, "probe continued without a saved interaction state");

  fixture = {};
  fixture.fail_disable = true;
  Run("error", "interaction-disable-failed");
  Expect(fixture.queries == 0, "probe continued after interaction disable failed");

  fixture = {};
  fixture.ignore_disable = true;
  Run("error", "interaction-disable-unverified");
  Expect(fixture.queries == 0, "probe trusted a failed interaction readback");

  fixture = {};
  fixture.fail_restore = true;
  Run("error", "interaction-restore-failed");

  fixture = {};
  fixture.empty_search_list = true;
  Run("error", "keychain-search-list-empty");
  Expect(fixture.queries == 0, "empty search list was treated as an absent credential");

  fixture = {};
  fixture.search_status = errSecNotAvailable;
  Run("error");
  Expect(fixture.queries == 0 && fixture.interaction, "search failure did not fail closed");

  fixture = {};
  fixture.primary_status = errSecSuccess;
  fixture.matches = 2;
  Run("error", "ambiguous-account");
  Expect(fixture.queries == 1, "ambiguous primary incorrectly fell back");

  fixture = {};
  fixture.primary_status = errSecSuccess;
  fixture.malformed_result = true;
  Run("error", "invalid-metadata-result");

  fixture = {};
  fixture.primary_status = errSecSuccess;
  fixture.result_has_secret = true;
  result = Run("error", "unexpected-secret-result");
  Expect(credential_identity::SerializeResult("darwin", "Open Science (DEV)", result)
             .find("never-output") == std::string::npos, "secret escaped through result serialization");

  fixture = {};
  fixture.interaction = false;
  Run("not-found");
  Expect(!fixture.interaction, "probe enabled an originally disabled interaction setting");

  fixture = {};
  result = ProbeIdentity("unrecognized-app", api);
  Expect(result.status == "error" && fixture.queries == 0 && fixture.restorations == 0,
         "an unrecognized identity reached the Security API");

  fixture = {};
  fixture.keychain_status = errSecNotAvailable;
  Run("error", "keychain-status-unavailable");
  Expect(fixture.queries == 0 && fixture.interaction, "a keychain status error became absence");

  fixture = {};
  fixture.primary_status = errSecSuccess;
  fixture.dictionary_result = true;
  Run("error", "invalid-metadata-result");
  Expect(fixture.queries == 1, "unexpected single-result shape permitted a fallback");

  fixture = {};
  fixture.primary_status = errSecSuccess;
  fixture.matches = 0;
  Run("error", "invalid-metadata-result");
  Expect(fixture.queries == 1, "empty success result was treated as definite absence");

  for (const char* variant : {"missing-service", "missing-account", "non-string-service",
                              "non-string-account", "different-service", "different-account"}) {
    fixture = {};
    fixture.primary_status = errSecSuccess;
    fixture.attribute_variant = variant;
    Run("error", "invalid-metadata-result");
    Expect(fixture.queries == 1 && fixture.interaction,
           "invalid attributes were accepted or permitted a fallback");
  }

  // A positive first-owner match is authoritative even if a later database is locked.
  // The later database is still searched: any observed duplicate must remain a failure.
  fixture = {};
  fixture.primary_status = errSecSuccess;
  fixture.unrelated_locked = true;
  fixture.matches = 2;
  Run("error", "ambiguous-account");

  // The admin-managed System keychain is locked in every user session: the stock-macOS search
  // list (unlocked login + locked System) must still reach definite absence on both accounts.
  fixture = {};
  fixture.second_keychain = true;
  fixture.unrelated_locked = true;
  fixture.admin_keychain = true;
  Run("not-found");
  Expect(fixture.accounts.size() == 2, "admin keychain lock suppressed the bare account fallback");

  // The path classification is position-independent: a locked admin database is never a hiding
  // place for an application identity.
  fixture = {};
  fixture.locked = true;
  fixture.first_keychain_admin = true;
  Run("not-found");
  Expect(fixture.accounts.size() == 2, "admin keychain lock suppressed the bare account fallback");

  // A locked USER database can hide a historical default-keychain account, so absence there
  // stays uncertain and must not fall through to a replacement identity.
  fixture = {};
  fixture.unrelated_locked = true;
  fixture.legacy_status = errSecSuccess;
  Run("access-blocked", "keychain-locked");
  Expect(fixture.accounts.size() == 1, "uncertain absence fell back to bare account");

  fixture = {};
  fixture.unrelated_locked = true;
  Run("access-blocked", "keychain-locked");
  Expect(fixture.accounts.size() == 1, "uncertain absence fell back to bare account");

  fixture = {};
  fixture.primary_status = errSecSuccess;
  fixture.second_keychain = true;
  fixture.owner_second = true;
  Run("exists"); // All unlocked retains existing search-list support.

  fixture = {};
  fixture.primary_status = errSecSuccess;
  fixture.second_keychain = true;
  fixture.owner_second = true;
  fixture.locked = true;
  Run("access-blocked", "keychain-search-incomplete");

  fixture = {};
  fixture.primary_status = errSecSuccess;
  fixture.locked = true;
  Run("access-blocked", "keychain-search-incomplete");

  for (bool after_owner : {false, true}) {
    fixture = {};
    fixture.primary_status = errSecSuccess;
    fixture.list_changes_after_query = !after_owner;
    fixture.list_changes_after_owner = after_owner;
    Run("access-blocked", "keychain-search-list-changed");
  }

  fixture = {};
  fixture.primary_status = errSecSuccess;
  fixture.locks_after_query = true;
  Run("access-blocked", "keychain-state-changed");

  for (bool wrong_type : {false, true}) {
    fixture = {};
    fixture.primary_status = errSecSuccess;
    fixture.missing_reference = !wrong_type;
    fixture.wrong_reference_type = wrong_type;
    Run("error", "invalid-item-reference");
    Expect(!fixture.owner_called, "invalid reference reached native ownership lookup");
  }

  fixture = {};
  fixture.primary_status = errSecSuccess;
  fixture.owner_outside = true;
  Run("error", "item-keychain-outside-search-list");

  fixture = {};
  fixture.primary_status = errSecSuccess;
  fixture.owner_status = errSecAuthFailed;
  Run("access-blocked", "item-keychain-unavailable");
  Expect(fixture.queries == 1, "ownership error permitted fallback");

  std::cout << "passed " << scenarios << " fixture scenarios\n";
  return 0;
}
