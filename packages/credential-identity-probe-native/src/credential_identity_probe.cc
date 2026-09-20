#include <iostream>
#include <string>
#include <vector>

#ifdef __APPLE__
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#endif

namespace credential_identity {

struct ProbeResult {
  std::string status;
  std::string reason;
  std::string account;
  int os_status = 0;
};

bool IsAllowedIdentity(const std::string& identity) {
  return identity == "Open Science" || identity == "Open Science (DEV)" ||
         identity == "Open-Science" || identity == "Open-Science (DEV)";
}

std::string SerializeResult(const std::string& platform, const std::string& identity,
                            const ProbeResult& result) {
  // All serialized strings come from this executable's fixed allowlist or internal reason codes.
  std::string output = "{\"schemaVersion\":1,\"platform\":\"" + platform +
      "\",\"identity\":\"" + (IsAllowedIdentity(identity) ? identity : "") +
      "\",\"status\":\"" + result.status + "\",\"reason\":\"" + result.reason +
      "\",\"osStatus\":" + std::to_string(result.os_status);
  if (result.status == "exists") output += ",\"account\":\"" + result.account + "\"";
  return output + "}";
}

#ifdef __APPLE__

// Injection keeps all operating-system access at one boundary for the no-system-probe fixtures.
struct SecurityApi {
  OSStatus (*get_interaction)(Boolean*);
  OSStatus (*set_interaction)(Boolean);
  OSStatus (*copy_search_list)(CFArrayRef*);
  OSStatus (*get_status)(SecKeychainRef, SecKeychainStatus*);
  OSStatus (*get_path)(SecKeychainRef, UInt32*, char*);
  OSStatus (*copy_matching)(CFDictionaryRef, CFTypeRef*);
  CFTypeID (*item_type_id)();
  OSStatus (*copy_item_keychain)(SecKeychainItemRef, SecKeychainRef*);
};

struct ScopedCF {
  CFTypeRef value = nullptr;
  ~ScopedCF() { if (value) CFRelease(value); }
  ScopedCF() = default;
  ScopedCF(const ScopedCF&) = delete;
  ScopedCF& operator=(const ScopedCF&) = delete;
};

ProbeResult Failure(const char* reason, OSStatus status = errSecSuccess) {
  const bool access_blocked = status == errSecInteractionNotAllowed ||
      status == errSecInteractionRequired || status == errSecAuthFailed ||
      status == errSecUserCanceled;
  return {access_blocked ? "access-blocked" : "error", reason, "", status};
}

class InteractionGuard {
 public:
  explicit InteractionGuard(const SecurityApi& api) : api_(api) {}
  ~InteractionGuard() { if (restore_needed_) api_.set_interaction(previous_); }

  ProbeResult Disable() {
    OSStatus status = api_.get_interaction(&previous_);
    if (status != errSecSuccess) return Failure("interaction-state-unavailable", status);
    // Even an unsuccessful setting call is followed by restoration of the saved state.
    restore_needed_ = true;
    status = api_.set_interaction(false);
    if (status != errSecSuccess) return Failure("interaction-disable-failed", status);
    Boolean current = true;
    status = api_.get_interaction(&current);
    if (status != errSecSuccess || current) return Failure("interaction-disable-unverified", status);
    return {"ready", "", ""};
  }

  bool Restore() {
    if (!restore_needed_) return true;
    const OSStatus status = api_.set_interaction(previous_);
    Boolean current = !previous_;
    const bool restored = status == errSecSuccess &&
        api_.get_interaction(&current) == errSecSuccess && current == previous_;
    if (restored) restore_needed_ = false;
    return restored;
  }

 private:
  const SecurityApi& api_;
  Boolean previous_ = true;
  bool restore_needed_ = false;
};

// Lock state affects absence and lookup precedence, not whether metadata can be queried.
ProbeResult ReadSearchState(CFArrayRef search_list, const SecurityApi& api,
                            std::vector<SecKeychainStatus>& states) {
  const CFIndex count = CFArrayGetCount(search_list);
  if (count == 0) return Failure("keychain-search-list-empty");
  if (count > 64) return Failure("keychain-search-list-too-large");
  for (CFIndex i = 0; i < count; i++) {
    auto keychain = reinterpret_cast<SecKeychainRef>(
        const_cast<void*>(CFArrayGetValueAtIndex(search_list, i)));
    for (CFIndex j = 0; j < i; j++) {
      if (CFEqual(keychain, CFArrayGetValueAtIndex(search_list, j)))
        return Failure("invalid-keychain-search-list");
    }
    SecKeychainStatus keychain_status = 0;
    const OSStatus status = api.get_status(keychain, &keychain_status);
    if (status != errSecSuccess) return Failure("keychain-status-unavailable", status);
    if (!(keychain_status & kSecReadPermStatus)) return {"access-blocked", "keychain-unreadable", ""};
    states.push_back(keychain_status);
  }
  return {"ready", "", ""};
}

ProbeResult CheckStableSearch(CFArrayRef original, const std::vector<SecKeychainStatus>& states,
                              const SecurityApi& api) {
  CFArrayRef current = nullptr;
  const OSStatus status = api.copy_search_list(&current);
  ScopedCF owner;
  owner.value = current;
  if (status != errSecSuccess) return Failure("keychain-search-list-unavailable", status);
  if (!current || CFGetTypeID(current) != CFArrayGetTypeID())
    return Failure("invalid-keychain-search-list");
  if (!CFEqual(original, current)) return {"access-blocked", "keychain-search-list-changed", ""};
  std::vector<SecKeychainStatus> current_states;
  auto result = ReadSearchState(current, api, current_states);
  if (result.status != "ready") return result;
  if (states != current_states) return {"access-blocked", "keychain-state-changed", ""};
  return {"ready", "", ""};
}

bool HasLockedKeychain(const std::vector<SecKeychainStatus>& states) {
  for (auto state : states) if (!(state & kSecUnlockStateStatus)) return true;
  return false;
}

// Application identities are created and read through the user's default keychain. The
// admin-managed System keychain requires per-item authorization for every write and never holds
// one, yet macOS keeps it in every search list and locked in every user session. Only a locked
// USER database can hide a historical account; an unreadable path fails closed as a user database.
bool HidesAccountsWhenLocked(SecKeychainRef keychain, const SecurityApi& api) {
  char path[512] = {0};
  UInt32 length = sizeof(path);
  if (api.get_path(keychain, &length, path) != errSecSuccess) return true;
  return std::string(path, length) != "/Library/Keychains/System.keychain";
}

bool AnyLockedUserDatabase(CFArrayRef search_list, const std::vector<SecKeychainStatus>& states,
                           const SecurityApi& api) {
  for (CFIndex i = 0; i < CFArrayGetCount(search_list); i++) {
    if (!(states[i] & kSecUnlockStateStatus) &&
        HidesAccountsWhenLocked(reinterpret_cast<SecKeychainRef>(
                                    const_cast<void*>(CFArrayGetValueAtIndex(search_list, i))),
                                api))
      return true;
  }
  return false;
}

ProbeResult QueryAccount(const std::string& service, const std::string& account,
                         CFArrayRef search_list, const std::vector<SecKeychainStatus>& states,
                         const SecurityApi& api) {
  ScopedCF service_value;
  service_value.value = CFStringCreateWithCString(nullptr, service.c_str(), kCFStringEncodingUTF8);
  ScopedCF account_value;
  account_value.value = CFStringCreateWithCString(nullptr, account.c_str(), kCFStringEncodingUTF8);
  // Apple's macOS SecItem.cpp accepts numeric limits, and maxMatches > 1 always returns an array.
  // Security revision db15acbe6a7f257a859ad9a3bb86097bfe0679d9, lines 3132-3142 and 3843-3874.
  const int two_matches = 2;
  ScopedCF match_limit;
  match_limit.value = CFNumberCreate(nullptr, kCFNumberIntType, &two_matches);
  if (!service_value.value || !account_value.value || !match_limit.value) return Failure("query-allocation-failed");
  const void* keys[] = {kSecClass, kSecAttrService, kSecAttrAccount, kSecMatchSearchList,
      kSecMatchLimit, kSecReturnAttributes, kSecReturnData, kSecReturnRef,
      kSecReturnPersistentRef, kSecUseAuthenticationUI, kSecUseDataProtectionKeychain};
  const void* values[] = {kSecClassGenericPassword, service_value.value, account_value.value,
      search_list, match_limit.value, kCFBooleanTrue, kCFBooleanFalse, kCFBooleanTrue,
      kCFBooleanFalse, kSecUseAuthenticationUIFail, kCFBooleanFalse};
  ScopedCF query;
  query.value = CFDictionaryCreate(nullptr, keys, values, sizeof(keys) / sizeof(keys[0]),
                                   &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  if (!query.value) return Failure("query-allocation-failed");
  ScopedCF metadata;
  const OSStatus status = api.copy_matching(static_cast<CFDictionaryRef>(query.value), &metadata.value);
  // Detect changes across the lookup, including search order and account fallback.
  auto availability = CheckStableSearch(search_list, states, api);
  if (availability.status != "ready") return availability;
  if (status == errSecItemNotFound) {
    // SecItem's file-keychain cursor can skip inaccessible databases, so a locked user database
    // keeps absence uncertain. Counting the admin-managed System keychain — locked in every user
    // session — made definite absence unreachable on every stock Mac and blocked fresh installs;
    // a locked first database still fails closed, as that is where Electron's lookups and writes
    // land.
    if (AnyLockedUserDatabase(search_list, states, api))
      return {"access-blocked", "keychain-locked", ""};
    return {"not-found", "account-not-found", "", status};
  }
  if (status != errSecSuccess) return Failure("metadata-query-failed", status);
  if (!metadata.value || CFGetTypeID(metadata.value) != CFArrayGetTypeID()) return Failure("invalid-metadata-result");
  auto items = static_cast<CFArrayRef>(metadata.value);
  const CFIndex count = CFArrayGetCount(items);
  if (count > 1) return Failure("ambiguous-account");
  if (count != 1) return Failure("invalid-metadata-result");
  auto item = CFArrayGetValueAtIndex(items, 0);
  if (!item || CFGetTypeID(item) != CFDictionaryGetTypeID()) return Failure("invalid-metadata-result");
  auto attributes = static_cast<CFDictionaryRef>(item);
  // Reject an unexpected payload instead of forwarding any returned metadata or secret to stdout.
  if (CFDictionaryContainsKey(attributes, kSecValueData)) return Failure("unexpected-secret-result");
  const auto returned_service = CFDictionaryGetValue(attributes, kSecAttrService);
  const auto returned_account = CFDictionaryGetValue(attributes, kSecAttrAccount);
  if (!returned_service || !returned_account ||
      CFGetTypeID(returned_service) != CFStringGetTypeID() ||
      CFGetTypeID(returned_account) != CFStringGetTypeID() ||
      !CFEqual(returned_service, service_value.value) ||
      !CFEqual(returned_account, account_value.value)) return Failure("invalid-metadata-result");
  // A nonpersistent reference is metadata only. It establishes which database Electron's
  // default-search-list lookup would reach; neither the reference nor its owner is serialized.
  auto reference = CFDictionaryGetValue(attributes, kSecValueRef);
  if (!reference || CFGetTypeID(reference) != api.item_type_id())
    return Failure("invalid-item-reference");
  SecKeychainRef keychain = nullptr;
  const OSStatus owner_status = api.copy_item_keychain(
      reinterpret_cast<SecKeychainItemRef>(const_cast<void*>(reference)), &keychain);
  ScopedCF keychain_owner;
  keychain_owner.value = keychain;
  if (owner_status != errSecSuccess || !keychain)
    return Failure("item-keychain-unavailable", owner_status);
  CFIndex owner_index = -1;
  for (CFIndex i = 0; i < CFArrayGetCount(search_list); i++) {
    if (CFEqual(keychain, CFArrayGetValueAtIndex(search_list, i))) owner_index = i;
  }
  if (owner_index < 0) return Failure("item-keychain-outside-search-list");
  if (HasLockedKeychain(states) &&
      (owner_index != 0 || !(states[0] & kSecUnlockStateStatus))) {
    // A skipped earlier database could change MatchLimitOne's owner. Only a positive match
    // in the unlocked first database is authoritative when any database is locked. Still
    // reject all observed duplicates above; unseen later entries cannot precede this owner.
    return {"access-blocked", "keychain-search-incomplete", ""};
  }
  availability = CheckStableSearch(search_list, states, api);
  if (availability.status != "ready") return availability;
  return {"exists", "account-metadata-found", account};
}

ProbeResult ProbeIdentity(const std::string& identity, const SecurityApi& api) {
  if (!IsAllowedIdentity(identity)) return Failure("invalid-identity");
  // Run only in the standalone helper. This flag is process-wide; toggling it in Electron would
  // race Chromium's own Keychain access. kSecUseAuthenticationUIFail alone does not protect the
  // file-based Keychain (Chromium 142 crypto/apple/keychain.cc, FB16959400).
  InteractionGuard interaction(api);
  ProbeResult result = interaction.Disable();
  if (result.status == "ready") {
    CFArrayRef search_list = nullptr;
    const OSStatus status = api.copy_search_list(&search_list);
    ScopedCF search_list_owner;
    search_list_owner.value = search_list;
    if (status != errSecSuccess) {
      result = Failure("keychain-search-list-unavailable", status);
    } else if (!search_list || CFGetTypeID(search_list) != CFArrayGetTypeID()) {
      result = Failure("invalid-keychain-search-list");
    } else {
      std::vector<SecKeychainStatus> states;
      result = ReadSearchState(search_list, api, states);
      if (result.status == "ready") {
        const std::string service = identity + " Safe Storage";
        // Match Electron 39's non-MAS account precedence. Only definite absence permits fallback.
        result = QueryAccount(service, identity + " Key", search_list, states, api);
        if (result.status == "not-found") result = QueryAccount(service, identity, search_list, states, api);
      }
    }
  }
  if (!interaction.Restore()) return Failure("interaction-restore-failed");
  return result;
}

#endif  // __APPLE__

}  // namespace credential_identity

#ifndef CREDENTIAL_IDENTITY_PROBE_NO_MAIN
int main(int argc, char* argv[]) {
  const std::string identity = argc == 2 ? argv[1] : "";
  credential_identity::ProbeResult result;
#ifdef __APPLE__
  const std::string platform = "darwin";
  const credential_identity::SecurityApi api{SecKeychainGetUserInteractionAllowed,
      SecKeychainSetUserInteractionAllowed, SecKeychainCopySearchList, SecKeychainGetStatus,
      SecKeychainGetPath, SecItemCopyMatching, SecKeychainItemGetTypeID,
      SecKeychainItemCopyKeychain};
  result = credential_identity::ProbeIdentity(identity, api);
#else
#ifdef _WIN32
  const std::string platform = "win32";
#else
  const std::string platform = "linux";
#endif
  result = {"unsupported", "platform-backend-unsupported", ""};
#endif
  std::cout << credential_identity::SerializeResult(platform, identity, result) << '\n';
  return 0;
}
#endif
