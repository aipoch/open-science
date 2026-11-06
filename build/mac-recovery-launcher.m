// Stable ordinary .app entry. The replaceable, independently signed Electron application
// lives outside this bundle. No application JavaScript is required to repair a missing runtime.
#import <AppKit/AppKit.h>
#import <Security/Security.h>
#import <CommonCrypto/CommonDigest.h>
#include <sqlite3.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <signal.h>
#include <limits.h>
#include <errno.h>
#include <unistd.h>

static NSFileManager *files;
static NSString *runtimePath, *stateDirectory, *wrapperPath;
static NSDictionary *configuration;
static NSDate *deadline;
static NSString *operationSnapshot, *targetSnapshot;

static void fail(NSString *stage) { @throw [NSException exceptionWithName:@"MacRecoveryEntry" reason:stage userInfo:nil]; }
static void require(BOOL condition, NSString *stage) { if (!condition) fail(stage); }
static NSString *diagnosticStage(NSException *exception) {
  NSString *value = exception.reason;
  NSRegularExpression *allowed = [NSRegularExpression regularExpressionWithPattern:@"^[a-z][a-z0-9:-]{0,120}$" options:0 error:NULL];
  return [exception.name isEqual:@"MacRecoveryEntry"] && [allowed firstMatchInString:value ?: @"" options:0 range:NSMakeRange(0, value.length)] ? value : @"recovery-unexpected-failure";
}
static NSString *canonical(NSString *path) {
  if (!path) return nil;
  NSString *cursor = path.stringByStandardizingPath; NSMutableArray<NSString *> *suffix = [NSMutableArray array];
  char resolved[PATH_MAX];
  while (!realpath(cursor.fileSystemRepresentation, resolved)) {
    require(errno == ENOENT && ![cursor.stringByDeletingLastPathComponent isEqual:cursor], @"entry-canonical-path-unavailable");
    [suffix insertObject:cursor.lastPathComponent atIndex:0]; cursor = cursor.stringByDeletingLastPathComponent;
  }
  NSString *result = @(resolved); for (NSString *part in suffix) result = [result stringByAppendingPathComponent:part]; return result;
}
static NSString *hexDigest(NSData *data) {
  unsigned char hash[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(data.bytes, (CC_LONG)data.length, hash);
  NSMutableString *value = [NSMutableString string];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) [value appendFormat:@"%02x", hash[i]];
  return value;
}
static NSDictionary *jsonFile(NSString *path) {
  NSData *bytes = [NSData dataWithContentsOfFile:path];
  require(bytes != nil, @"recovery-record-unreadable");
  id object = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:NULL];
  require([object isKindOfClass:NSDictionary.class], @"recovery-record-invalid");
  return object;
}
static void checkDeadline(void) { require(deadline.timeIntervalSinceNow > 0, @"recovery-timeout"); }
static void event(NSString *phase, NSString *operation) {
  if (!stateDirectory) return;
  NSDictionary *entry = @{ @"phase": phase, @"operationId": operation ?: @"", @"pid": @(getpid()),
    @"time": @((long long)(NSDate.date.timeIntervalSince1970 * 1000)) };
  NSMutableData *bytes = [[NSJSONSerialization dataWithJSONObject:entry options:0 error:NULL] mutableCopy];
  [bytes appendBytes:"\n" length:1];
  NSString *path = [stateDirectory stringByAppendingPathComponent:@"mac-entry-events.ndjson"];
  int fd = open(path.fileSystemRepresentation, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (fd >= 0) { write(fd, bytes.bytes, bytes.length); fsync(fd); close(fd); }
#ifdef OPEN_SCIENCE_MAC_ENTRY_FAULT_INJECTION
  NSDictionary *env = NSProcessInfo.processInfo.environment;
  if ([env[@"OPEN_SCIENCE_MAC_ENTRY_PAUSE_AT"] isEqual:phase]) {
    NSMutableDictionary *paused = [entry mutableCopy]; paused[@"phase"] = @"native-fault-paused"; paused[@"atStage"] = phase;
    NSMutableData *pausedBytes = [[NSJSONSerialization dataWithJSONObject:paused options:0 error:NULL] mutableCopy]; [pausedBytes appendBytes:"\n" length:1];
    fd = open(path.fileSystemRepresentation, O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (fd >= 0) { write(fd, pausedBytes.bytes, pausedBytes.length); fsync(fd); close(fd); }
    NSString *release = env[@"OPEN_SCIENCE_MAC_ENTRY_RELEASE_FILE"];
    while (release && ![files fileExistsAtPath:release]) { checkDeadline(); usleep(10000); }
  }
#endif
}
static void run(NSString *executable, NSArray<NSString *> *arguments) {
  checkDeadline();
  NSTask *task = [NSTask new]; task.executableURL = [NSURL fileURLWithPath:executable]; task.arguments = arguments;
  NSString *logPath = [stateDirectory stringByAppendingPathComponent:@"mac-entry-control.log"];
  if (![files fileExistsAtPath:logPath]) [files createFileAtPath:logPath contents:nil attributes:@{NSFilePosixPermissions:@0600}];
  NSFileHandle *output = [NSFileHandle fileHandleForWritingAtPath:logPath]; [output seekToEndOfFile];
  task.standardOutput = output; task.standardError = output;
  require([task launchAndReturnError:NULL], @"recovery-command-launch-failed");
  while (task.running) {
    if (deadline.timeIntervalSinceNow <= 0) { [task terminate]; usleep(100000); if (task.running) kill(task.processIdentifier, SIGKILL); [task waitUntilExit]; fail(@"recovery-command-timeout"); }
    usleep(10000);
  }
  [output closeFile];
  require(task.terminationStatus == 0, [NSString stringWithFormat:@"recovery-command-failed:%@:%d", executable.lastPathComponent, task.terminationStatus]);
}
static BOOL validSignature(NSString *bundle) {
  SecStaticCodeRef code = NULL; SecRequirementRef requirement = NULL;
  NSString *expression = configuration[@"runtimeRequirement"];
  if (![expression isKindOfClass:NSString.class]) return NO;
  OSStatus status = SecRequirementCreateWithString((__bridge CFStringRef)expression, kSecCSDefaultFlags, &requirement);
  if (status == errSecSuccess) status = SecStaticCodeCreateWithPath((__bridge CFURLRef)[NSURL fileURLWithPath:bundle], kSecCSDefaultFlags, &code);
  if (status == errSecSuccess) status = SecStaticCodeCheckValidity(code,
    kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode, requirement);
  if (code) CFRelease(code); if (requirement) CFRelease(requirement);
  return status == errSecSuccess;
}
static BOOL correctVersion(NSString *bundle, NSString *version) {
  NSDictionary *info = [NSDictionary dictionaryWithContentsOfFile:[bundle stringByAppendingPathComponent:@"Contents/Info.plist"]];
  return [info[@"CFBundleIdentifier"] isEqual:configuration[@"runtimeBundleIdentifier"]] &&
    (!version || [info[@"CFBundleShortVersionString"] isEqual:version]);
}
static BOOL validRuntime(NSString *bundle, NSString *version) {
  checkDeadline();
  return correctVersion(bundle, version) && validSignature(bundle);
}
static BOOL validArchive(NSString *archive, NSString *expected) {
  FILE *file = fopen(archive.fileSystemRepresentation, "rb"); if (!file) return NO;
  CC_SHA512_CTX context; CC_SHA512_Init(&context); unsigned char buffer[131072]; size_t count;
  while ((count = fread(buffer, 1, sizeof(buffer), file)) > 0) { CC_SHA512_Update(&context, buffer, (CC_LONG)count); if (deadline.timeIntervalSinceNow <= 0) { fclose(file); fail(@"recovery-checksum-timeout"); } }
  BOOL ok = !ferror(file); fclose(file); unsigned char hash[CC_SHA512_DIGEST_LENGTH]; CC_SHA512_Final(hash, &context);
  return ok && [[[NSData dataWithBytes:hash length:sizeof(hash)] base64EncodedStringWithOptions:0] isEqual:expected];
}
static sqlite3 *claimOwner(void) {
  sqlite3 *database = NULL;
  NSString *path = [stateDirectory stringByAppendingPathComponent:@"native-update-owner.sqlite"];
  require(sqlite3_open(path.fileSystemRepresentation, &database) == SQLITE_OK, @"recovery-owner-open-failed");
  sqlite3_busy_timeout(database, 100);
  for (;;) {
    int status = sqlite3_exec(database, "PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE", NULL, NULL, NULL);
    if (status == SQLITE_OK) return database;
    if (status != SQLITE_BUSY && status != SQLITE_LOCKED) { sqlite3_close(database); fail(@"recovery-owner-query-failed"); }
    if (deadline.timeIntervalSinceNow <= 0) { sqlite3_close(database); fail(@"recovery-owner-still-active"); }
    usleep(10000);
  }
}
static NSString *runLaunchctl(NSArray<NSString *> *arguments, int *status) {
  NSTask *task = [NSTask new]; task.executableURL = [NSURL fileURLWithPath:@"/bin/launchctl"]; task.arguments = arguments;
  NSString *output = [stateDirectory stringByAppendingFormat:@"/query-%@.tmp", NSUUID.UUID.UUIDString];
  require([files createFileAtPath:output contents:nil attributes:@{NSFilePosixPermissions:@0600}], @"recovery-query-output-unavailable");
  NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:output]; task.standardOutput = handle; task.standardError = NSFileHandle.fileHandleWithNullDevice;
  @try {
    require([task launchAndReturnError:NULL], @"recovery-writer-query-launch-failed");
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:MIN(5, deadline.timeIntervalSinceNow)];
    while (task.running) {
      if (until.timeIntervalSinceNow <= 0) { [task terminate]; usleep(100000); if (task.running) kill(task.processIdentifier, SIGKILL); [task waitUntilExit]; fail(@"recovery-writer-query-timeout"); }
      usleep(10000);
    }
    *status = task.terminationStatus; [handle closeFile];
    NSData *bytes = [NSData dataWithContentsOfFile:output]; require(bytes.length <= 65536, @"recovery-writer-query-oversized");
    return [[NSString alloc] initWithData:bytes encoding:NSUTF8StringEncoding] ?: @"";
  } @finally { [handle closeFile]; [files removeItemAtPath:output error:NULL]; }
}
static NSString *field(NSString *output, NSString *name) {
  NSRegularExpression *expression = [NSRegularExpression regularExpressionWithPattern:[NSString stringWithFormat:@"(?m)^\\s*%@ = (.+)$", name] options:0 error:NULL];
  NSTextCheckingResult *match = [expression firstMatchInString:output options:0 range:NSMakeRange(0, output.length)];
  return match ? [output substringWithRange:[match rangeAtIndex:1]] : nil;
}
static void quiesceNativeWriter(NSString *operation) {
  // SQLite coordinates application owners. Squirrel itself is a launchd writer, so a recovery
  // takeover must also remove its narrowly bound job and observe its process exit first.
  NSString *label = [configuration[@"runtimeBundleIdentifier"] stringByAppendingString:@".ShipIt"];
  NSString *target = [NSString stringWithFormat:@"gui/%u/%@", getuid(), label];
  int status = 0; NSString *description = runLaunchctl(@[@"print", target], &status);
  if (status == 113) return; // launchctl's explicit "service not found" result.
  require(status == 0, @"recovery-writer-query-failed");
  NSString *program = field(description, @"program");
  NSString *expected = [runtimePath stringByAppendingPathComponent:@"Contents/Frameworks/Squirrel.framework/Resources/ShipIt"];
  require([program isEqual:expected] || [program isEqual:[runtimePath stringByAppendingPathComponent:@"Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt"]], @"recovery-writer-belongs-to-another-installation");
  pid_t writer = (pid_t)[field(description, @"pid") intValue];
  (void)runLaunchctl(@[@"bootout", target], &status);
  int query = 0; (void)runLaunchctl(@[@"print", target], &query);
  require(query == 113, @"recovery-native-writer-not-unloaded");
  while (writer > 0 && kill(writer, 0) == 0) { checkDeadline(); usleep(10000); }
  event(@"native-recovery-writer-quiesced", operation);
}
static NSDictionary *readPendingRequest(void) {
  NSString *markerPath = [stateDirectory stringByAppendingPathComponent:@"windows-update-in-progress.json"];
  if (![files fileExistsAtPath:markerPath]) return nil;
  NSDictionary *marker = jsonFile(markerPath);
  require([marker[@"schema"] isEqual:@1] && [marker[@"channel"] isEqual:@"mac-electron-updater"] &&
    [marker[@"installationRoot"] isEqual:runtimePath], @"recovery-installation-identity-mismatch");
  NSString *directory = marker[@"handoffDirectory"];
  require([directory isKindOfClass:NSString.class] && directory.isAbsolutePath && [canonical(directory) isEqual:directory], @"recovery-handoff-path-invalid");
  NSData *bytes = [NSData dataWithContentsOfFile:[directory stringByAppendingPathComponent:@"request.json"]];
  require(bytes && [hexDigest(bytes) isEqual:marker[@"requestSha256"]], @"recovery-request-binding-mismatch");
  NSDictionary *request = jsonFile([directory stringByAppendingPathComponent:@"request.json"]);
  require([request[@"schema"] isEqual:@1] && [request[@"channel"] isEqual:@"mac-electron-updater"] &&
    [request[@"operationId"] isEqual:marker[@"operationId"]] && [request[@"applicationPath"] isEqual:runtimePath] &&
    [request[@"targetVersion"] isEqual:marker[@"targetVersion"]] &&
    [request[@"installerSha512"] isEqual:marker[@"installerSha512"]] &&
    [request[@"installerPath"] isEqual:[directory stringByAppendingPathComponent:@"update.zip"]] &&
    [request[@"targetManifest"][@"version"] isEqual:marker[@"targetVersion"]], @"recovery-original-target-mismatch");
  NSDictionary *startup = request[@"startupOptions"];
  require([startup isKindOfClass:NSDictionary.class] && [startup[@"profilePath"] isEqual:request[@"profilePath"]], @"recovery-original-profile-mismatch");
  for (NSString *key in @[@"configRoot", @"dataRoot", @"profilePath"]) {
    NSString *protected = startup[key];
    require([protected isKindOfClass:NSString.class] && protected.isAbsolutePath &&
      ![canonical(protected) isEqual:runtimePath] && ![canonical(protected) hasPrefix:[runtimePath stringByAppendingString:@"/"]], @"recovery-protected-data-inside-runtime");
  }
  operationSnapshot = [request[@"operationId"] copy]; targetSnapshot = [request[@"targetVersion"] copy];
  return request;
}
static NSDictionary *pendingRequest(void) {
  sqlite3 *coordinator = NULL;
  require(sqlite3_open([stateDirectory stringByAppendingPathComponent:@"coordinator.sqlite"].fileSystemRepresentation, &coordinator) == SQLITE_OK, @"recovery-record-coordinator-unavailable");
  sqlite3_busy_timeout(coordinator, 1500);
  @try {
    require(sqlite3_exec(coordinator, "PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE", NULL, NULL, NULL) == SQLITE_OK, @"recovery-record-coordinator-busy");
    return readPendingRequest();
  } @finally { sqlite3_close(coordinator); }
}
static void acquireArchive(NSDictionary *request) {
  NSString *archive = request[@"installerPath"], *expected = request[@"installerSha512"];
  if (validArchive(archive, expected)) { event(@"native-recovery-cache-reused", request[@"operationId"]); return; }
  NSURL *url = [NSURL URLWithString:request[@"installerUrl"]];
  require(([@[@"https", @"http"] containsObject:url.scheme]) && !url.user && !url.password, @"recovery-original-url-invalid");
  NSString *temporary = [archive stringByAppendingFormat:@".%@.download", NSUUID.UUID.UUIDString];
  @try {
    for (int attempt = 0; attempt < 3; attempt++) {
      checkDeadline();
      NSTimeInterval remaining = MAX(1, MIN(30, deadline.timeIntervalSinceNow));
      // curl is a system HTTPS transport; the original package digest and publisher are checked
      // independently. No shell interpolation, saved credentials, mutable latest feed or fallback seed.
      NSTask *task = [NSTask new]; task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/curl"];
      task.arguments = @[@"--fail", @"--location", @"--silent", @"--show-error", @"--proto", @"=https,http", @"--max-time", [NSString stringWithFormat:@"%.0f", remaining], @"--output", temporary, url.absoluteString];
      task.standardOutput = NSFileHandle.fileHandleWithNullDevice; task.standardError = NSFileHandle.fileHandleWithNullDevice;
      require([task launchAndReturnError:NULL], @"recovery-download-launch-failed"); [task waitUntilExit];
      if (task.terminationStatus == 0 && validArchive(temporary, expected)) {
        require(rename(temporary.fileSystemRepresentation, archive.fileSystemRepresentation) == 0, @"recovery-cache-publish-failed");
        event(@"native-recovery-cache-downloaded", request[@"operationId"]); return;
      }
      [files removeItemAtPath:temporary error:NULL];
    }
    fail(@"recovery-original-package-unavailable");
  } @finally { [files removeItemAtPath:temporary error:NULL]; }
}
static void prepareProcesses(NSString *stagedRuntime, NSString *operation) {
  // Keep the fixed reviewed controller outside signature-covered target resources. Its ordinary
  // Node resolver is rooted beside a package shim whose ONLY native binary comes from the same
  // verified target as Node, including Rosetta x64-source -> arm64-target recovery.
  NSString *staging = stagedRuntime.stringByDeletingLastPathComponent;
  NSString *control = [staging stringByAppendingPathComponent:@"mac-recovery-control.cjs"];
  require([files copyItemAtPath:[NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"mac-recovery-control.cjs"] toPath:control error:NULL], @"recovery-control-stage-failed");
  NSString *package = [staging stringByAppendingPathComponent:@"node_modules/@aipoch/process-tree-native"];
  require([files createDirectoryAtPath:[package stringByAppendingPathComponent:@"build/Release"] withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL], @"recovery-native-stage-create-failed");
  for (NSString *file in @[@"package.json", @"index.cjs"]) {
    NSString *source = [[NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"node_modules/@aipoch/process-tree-native"] stringByAppendingPathComponent:file];
    require([files copyItemAtPath:source toPath:[package stringByAppendingPathComponent:file] error:NULL], @"recovery-native-shim-stage-failed");
  }
  NSString *targetAddon = [stagedRuntime stringByAppendingPathComponent:@"Contents/Resources/app.asar.unpacked/node_modules/@aipoch/process-tree-native/build/Release/process_tree_native.node"];
  require([files copyItemAtPath:targetAddon toPath:[package stringByAppendingPathComponent:@"build/Release/process_tree_native.node"] error:NULL], @"recovery-target-native-addon-unavailable");
  NSString *recordPath = [stateDirectory stringByAppendingPathComponent:@"windows-update-in-progress.json"];
  sqlite3 *coordinator = NULL;
  require(sqlite3_open([stateDirectory stringByAppendingPathComponent:@"coordinator.sqlite"].fileSystemRepresentation, &coordinator) == SQLITE_OK, @"recovery-coordinator-open-failed");
  sqlite3_busy_timeout(coordinator, 1500);
  long long closeDeadline = (long long)(NSDate.date.timeIntervalSince1970 * 1000) + 20000;
  @try {
    require(sqlite3_exec(coordinator, "PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE", NULL, NULL, NULL) == SQLITE_OK, @"recovery-coordinator-busy");
    NSMutableDictionary *record = [jsonFile(recordPath) mutableCopy];
    require([record[@"operationId"] isEqual:operation] && [record[@"installationRoot"] isEqual:runtimePath], @"recovery-close-operation-changed");
    record[@"phase"] = @"preparing"; record[@"shutdownDeadlineAt"] = @(closeDeadline);
    NSData *bytes = [NSJSONSerialization dataWithJSONObject:record options:0 error:NULL];
    require([bytes writeToFile:recordPath options:NSDataWritingAtomic error:NULL], @"recovery-close-publication-failed");
    int fd = open(recordPath.fileSystemRepresentation, O_RDONLY); require(fd >= 0 && fsync(fd) == 0, @"recovery-close-publication-sync-failed"); close(fd);
  } @finally { sqlite3_close(coordinator); }
  NSString *node = [stagedRuntime stringByAppendingPathComponent:@"Contents/Resources/node-runtime/node"];
  event(@"native-recovery-stopping", operation);
  run(node, @[control, runtimePath, [NSString stringWithFormat:@"%lld", closeDeadline], [NSString stringWithFormat:@"%d", getpid()]]);
  event(@"native-recovery-occupancy-released", operation);
}
static NSString *ownedJournalPath(void) { return [stateDirectory stringByAppendingPathComponent:@"mac-entry-owned.json"]; }
static void cleanupOwned(NSString *operation, NSString *version) {
  if (![files fileExistsAtPath:ownedJournalPath()]) return;
  NSDictionary *journal = jsonFile(ownedJournalPath());
  require([journal[@"schema"] isEqual:@1] && [journal[@"operationId"] isEqual:operation ?: @"seed"] &&
    [journal[@"runtimePath"] isEqual:runtimePath] && [journal[@"targetVersion"] isEqual:version] &&
    validRuntime(runtimePath, version), @"recovery-owned-cleanup-identity-mismatch");
  NSString *parent = runtimePath.stringByDeletingLastPathComponent;
  for (NSString *key in @[@"staging", @"discard"]) {
    NSString *path = journal[key]; if (!path || [path isEqual:@""]) continue;
    NSString *prefix = [key isEqual:@"staging"] ? @".recovery-" : @".interrupted-";
    require([path.stringByDeletingLastPathComponent isEqual:parent] && [path.lastPathComponent hasPrefix:prefix] &&
      [canonical(path) isEqual:path], @"recovery-owned-cleanup-path-invalid");
    NSError *error = nil; BOOL removed = [files removeItemAtPath:path error:&error];
    require(removed || error.code == NSFileNoSuchFileError, @"recovery-owned-cleanup-failed");
  }
  require([files removeItemAtPath:ownedJournalPath() error:NULL], @"recovery-owned-journal-cleanup-failed");
  event(@"native-recovery-owned-cleaned", operation);
}
static void installArchive(NSString *archive, NSString *version, NSString *operation) {
  NSString *parent = runtimePath.stringByDeletingLastPathComponent;
  NSString *staging = [parent stringByAppendingFormat:@"/.recovery-%@", NSUUID.UUID.UUIDString];
  NSString *discard = [parent stringByAppendingFormat:@"/.interrupted-%@.app", NSUUID.UUID.UUIDString];
  if ([files fileExistsAtPath:ownedJournalPath()]) {
    NSDictionary *previous = jsonFile(ownedJournalPath());
    require([previous[@"schema"] isEqual:@1] && [previous[@"operationId"] isEqual:operation ?: @"seed"] &&
      [previous[@"runtimePath"] isEqual:runtimePath] && [previous[@"targetVersion"] isEqual:version], @"recovery-owned-journal-changed");
    staging = previous[@"staging"]; discard = previous[@"discard"];
    require([staging.stringByDeletingLastPathComponent isEqual:parent] && [staging.lastPathComponent hasPrefix:@".recovery-"] && [canonical(staging) isEqual:staging] &&
      [discard.stringByDeletingLastPathComponent isEqual:parent] && [discard.lastPathComponent hasPrefix:@".interrupted-"] && [canonical(discard) isEqual:discard], @"recovery-owned-journal-path-invalid");
    [files removeItemAtPath:staging error:NULL];
  }
  NSDictionary *journal = @{ @"schema": @1, @"operationId": operation ?: @"seed", @"runtimePath": runtimePath,
    @"targetVersion": version, @"staging": staging, @"discard": discard };
  require([[NSJSONSerialization dataWithJSONObject:journal options:0 error:NULL] writeToFile:ownedJournalPath() options:NSDataWritingAtomic error:NULL], @"recovery-owned-journal-write-failed");
  require([files createDirectoryAtPath:staging withIntermediateDirectories:NO attributes:@{NSFilePosixPermissions:@0700} error:NULL], @"recovery-staging-create-failed");
  @try {
    run(@"/usr/bin/ditto", @[@"-x", @"-k", archive, staging]);
    NSMutableArray<NSString *> *apps = [NSMutableArray array];
    for (NSString *name in [files contentsOfDirectoryAtPath:staging error:NULL]) if ([name hasSuffix:@".app"]) [apps addObject:[staging stringByAppendingPathComponent:name]];
    require(apps.count == 1 && validRuntime(apps.firstObject, version), @"recovery-target-signature-or-version-invalid");
    event(@"native-recovery-staged", operation);
    NSString *replacement = apps.firstObject;
    if (operation) prepareProcesses(replacement, operation);
    event(@"native-recovery-before-publish", operation);
    // The stable ordinary launcher is outside this transaction. A kill after moving aside the
    // damaged runtime still leaves that same ordinary entry able to repeat recovery.
    if ([files fileExistsAtPath:runtimePath]) {
      if ([files fileExistsAtPath:discard]) require([files removeItemAtPath:discard error:NULL], @"recovery-prior-owned-discard-cleanup-failed");
      require(rename(runtimePath.fileSystemRepresentation, discard.fileSystemRepresentation) == 0, @"recovery-damaged-runtime-move-failed");
    }
    event(@"native-recovery-runtime-absent", operation);
    require(rename(replacement.fileSystemRepresentation, runtimePath.fileSystemRepresentation) == 0, @"recovery-target-publish-failed");
    require(validRuntime(runtimePath, version), @"recovery-published-target-invalid");
    event(@"native-recovery-installed", operation);
    cleanupOwned(operation, version);
  } @finally { [files removeItemAtPath:staging error:NULL]; }
}
static void configure(void) {
  files = NSFileManager.defaultManager; deadline = [NSDate dateWithTimeIntervalSinceNow:120];
  wrapperPath = canonical(NSBundle.mainBundle.bundlePath);
  SecStaticCodeRef ownCode = NULL; SecRequirementRef ownRequirement = NULL;
  require(SecStaticCodeCreateWithPath((__bridge CFURLRef)[NSURL fileURLWithPath:wrapperPath], kSecCSDefaultFlags, &ownCode) == errSecSuccess, @"entry-signature-unreadable");
#if !defined(OPEN_SCIENCE_MAC_ENTRY_TESTING) && !defined(OPEN_SCIENCE_MAC_ENTRY_ADHOC)
  require(SecRequirementCreateWithString(CFSTR("identifier \"com.aipoch.open-science.launcher\" and anchor apple generic and certificate leaf[subject.OU] = \"87G9WFU9H3\""), kSecCSDefaultFlags, &ownRequirement) == errSecSuccess, @"entry-signature-requirement-invalid");
#endif
  OSStatus ownStatus = SecStaticCodeCheckValidity(ownCode, kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode, ownRequirement);
  CFRelease(ownCode); if (ownRequirement) CFRelease(ownRequirement);
  require(ownStatus == errSecSuccess, @"entry-signature-invalid");
  configuration = jsonFile([NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"mac-recovery-entry.json"]);
  require([configuration[@"schema"] isEqual:@1], @"entry-configuration-invalid");
  NSString *key = hexDigest([wrapperPath dataUsingEncoding:NSUTF8StringEncoding]);
  NSDictionary *env = NSProcessInfo.processInfo.environment;
  NSString *storage = env[@"OPEN_SCIENCE_MAC_RUNTIME_ROOT"] ?: [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/Open-Science/RuntimeInstallations"];
  NSString *directory = [canonical(storage) stringByAppendingPathComponent:key];
  require([files createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL], @"entry-runtime-directory-unavailable");
  runtimePath = [directory stringByAppendingPathComponent:@"Open-Science.app"];
  NSString *stateRoot = env[@"OPEN_SCIENCE_INSTALLATION_STATE_ROOT"] ?: (env[@"OPEN_SCIENCE_E2E_STORAGE_ROOT"] ? [env[@"OPEN_SCIENCE_E2E_STORAGE_ROOT"] stringByAppendingPathComponent:@"installations"] : [NSHomeDirectory() stringByAppendingPathComponent:@".open-science/installations"]);
  stateDirectory = [canonical(stateRoot) stringByAppendingPathComponent:hexDigest([runtimePath dataUsingEncoding:NSUTF8StringEncoding])];
  require([files createDirectoryAtPath:stateDirectory withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL], @"entry-state-directory-unavailable");
  NSDictionary *association = @{ @"schema": @1, @"wrapperPath": wrapperPath, @"runtimePath": runtimePath,
    @"runtimeRoot": canonical(storage), @"stateRoot": canonical(stateRoot) };
  NSData *associationBytes = [NSJSONSerialization dataWithJSONObject:association options:0 error:NULL];
  require([associationBytes writeToFile:[directory stringByAppendingPathComponent:@"ordinary-entry.json"] options:NSDataWritingAtomic error:NULL], @"entry-association-write-failed");
}
static void ensureRuntime(void) {
  sqlite3 *owner = NULL;
  @try {
    NSDictionary *request = pendingRequest();
    if (validRuntime(runtimePath, request[@"targetVersion"]) && ![files fileExistsAtPath:ownedJournalPath()]) return;
    owner = claimOwner(); request = pendingRequest();
    if (validRuntime(runtimePath, request[@"targetVersion"])) {
      cleanupOwned(request[@"operationId"], request[@"targetVersion"] ?: configuration[@"seedVersion"]); return;
    }
    if (request) {
      event(@"native-recovery-claimed", request[@"operationId"]);
      quiesceNativeWriter(request[@"operationId"]);
      acquireArchive(request);
      installArchive(request[@"installerPath"], request[@"targetVersion"], request[@"operationId"]);
    } else {
      // Only a genuinely first installation can use its immutable seed. A missing/damaged
      // existing runtime without a bound pending target is not silently downgraded.
      NSString *initialized = [runtimePath.stringByDeletingLastPathComponent stringByAppendingPathComponent:@"initialized"];
      require(![files fileExistsAtPath:initialized], @"entry-installed-runtime-damaged-without-update-context");
      NSString *seed = [NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"runtime-seed.zip"];
      require(validArchive(seed, configuration[@"seedSha512"]), @"entry-seed-checksum-invalid");
      installArchive(seed, configuration[@"seedVersion"], nil);
      require([@"1" writeToFile:initialized atomically:YES encoding:NSUTF8StringEncoding error:NULL], @"entry-initialization-receipt-failed");
    }
  } @finally { if (owner) sqlite3_close(owner); }
}
static NSString *failureCategory(NSString *stage) {
  for (NSString *part in @[@"signature", @"identity", @"binding", @"mismatch", @"invalid", @"incompatible"])
    if ([stage containsString:part]) return @"identity";
  if ([stage containsString:@"package"] || [stage containsString:@"checksum"] || [stage containsString:@"download"])
    return @"package";
  for (NSString *part in @[@"owner", @"coordinator", @"writer", @"occupancy", @"close", @"control", @"command-failed:node"])
    if ([stage containsString:part]) return @"coordination";
  for (NSString *part in @[@"staging", @"publish", @"publication", @"directory", @"write", @"cleanup", @"stage-failed"])
    if ([stage containsString:part]) return @"storage";
  return @"startup";
}
static NSString *failureDescription(NSString *stage) {
  NSString *category = failureCategory(stage);
  if ([category isEqual:@"package"]) return NSLocalizedString(@"The original update package could not be obtained or checked. Check the network connection, then retry. If the problem continues, copy diagnostics for support.", nil);
  if ([category isEqual:@"storage"]) return NSLocalizedString(@"The application files could not be prepared. Check free disk space and whether this account can write to the application folder, then retry.", nil);
  if ([category isEqual:@"coordination"]) return NSLocalizedString(@"The application could not safely prepare the update. Quit other copies normally, then retry, or copy diagnostics for support.", nil);
  if ([category isEqual:@"identity"]) return NSLocalizedString(@"The original update or application identity could not be verified. The update remains protected. Copy diagnostics for support.", nil);
  return NSLocalizedString(@"The application could not be opened. Retry. If it still cannot start, copy diagnostics for support.", nil);
}
static NSString *failureDiagnostics(NSString *stage) {
  return [NSString stringWithFormat:@"Open-Science Mac recovery\nlauncherVersion=%@\ntargetVersion=%@\noperationId=%@\nstage=%@\n", configuration[@"seedVersion"] ?: @"unknown", targetSnapshot ?: @"unknown", operationSnapshot ?: @"unknown", stage];
}
static BOOL retryFailure(NSString *stage) {
  fprintf(stderr, "Open-Science recovery: %s\n", stage.UTF8String);
#ifdef OPEN_SCIENCE_MAC_ENTRY_TESTING
  if ([NSProcessInfo.processInfo.environment[@"OPEN_SCIENCE_MAC_ENTRY_FIXTURE_NO_DIALOG"] isEqual:@"1"]) return NO;
#endif
  for (;;) {
    NSAlert *alert = [NSAlert new]; alert.messageText = NSLocalizedString(@"The update could not be completed.", nil);
    alert.informativeText = failureDescription(stage);
    [alert addButtonWithTitle:NSLocalizedString(@"Retry", nil)];
    [alert addButtonWithTitle:NSLocalizedString(@"Copy diagnostics", nil)];
    [alert addButtonWithTitle:NSLocalizedString(@"Quit", nil)];
    NSModalResponse answer = [alert runModal];
    if (answer == NSAlertFirstButtonReturn) return YES;
    if (answer != NSAlertSecondButtonReturn) return NO;
    [NSPasteboard.generalPasteboard clearContents];
    [NSPasteboard.generalPasteboard setString:failureDiagnostics(stage) forType:NSPasteboardTypeString];
  }
}

@interface EntryDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) NSTimer *watcher;
@property(nonatomic) BOOL updating;
@property(nonatomic) NSUInteger pendingLaunches;
@property(nonatomic, strong) NSDate *updateDeadline;
@property(nonatomic) BOOL internalExit;
@end
@implementation EntryDelegate
- (void)launchRuntimeForceNew:(BOOL)forceNew {
  while (true) @try {
    operationSnapshot = nil; targetSnapshot = nil;
    deadline = [NSDate dateWithTimeIntervalSinceNow:120]; ensureRuntime();
    if (!forceNew) for (NSRunningApplication *application in [NSRunningApplication runningApplicationsWithBundleIdentifier:configuration[@"runtimeBundleIdentifier"]])
      if ([canonical(application.bundleURL.path) isEqual:runtimePath]) { [application activateWithOptions:NSApplicationActivateAllWindows]; return; }
    NSDictionary *info = [NSDictionary dictionaryWithContentsOfFile:[runtimePath stringByAppendingPathComponent:@"Contents/Info.plist"]];
    NSString *name = info[@"CFBundleExecutable"];
    require([name isKindOfClass:NSString.class] && [name.lastPathComponent isEqual:name], @"entry-runtime-executable-invalid");
    NSWorkspaceOpenConfiguration *options = NSWorkspaceOpenConfiguration.configuration;
    options.createsNewApplicationInstance = forceNew; options.activates = YES;
    options.arguments = [NSProcessInfo.processInfo.arguments subarrayWithRange:NSMakeRange(1, NSProcessInfo.processInfo.arguments.count - 1)];
    NSMutableDictionary *environment = [NSProcessInfo.processInfo.environment mutableCopy];
    environment[@"OPEN_SCIENCE_MAC_LAUNCHER_BUNDLE"] = wrapperPath; options.environment = environment;
    NSString *operation = pendingRequest()[@"operationId"];
    self.pendingLaunches++;
    [NSWorkspace.sharedWorkspace openApplicationAtURL:[NSURL fileURLWithPath:runtimePath] configuration:options completionHandler:^(NSRunningApplication *opened, NSError *error) {
      (void)opened;
      dispatch_async(dispatch_get_main_queue(), ^{
        if (self.pendingLaunches) self.pendingLaunches--;
        if (error) {
          event(@"entry-runtime-launch-failed", nil);
          if (retryFailure(@"entry-runtime-launch-failed")) [self launchRuntimeForceNew:forceNew];
          else { self.internalExit = YES; [NSApp terminate:nil]; }
        } else event(@"native-launch-submitted", operation);
      });
    }];
    return;
  } @catch (NSException *exception) {
    NSString *stage = diagnosticStage(exception); event(stage, nil);
    if (retryFailure(stage)) continue;
    self.internalExit = YES; [NSApp terminate:nil]; return;
  }
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  NSMenu *menu = [NSMenu new]; NSMenuItem *applicationItem = [NSMenuItem new]; [menu addItem:applicationItem];
  NSMenu *applicationMenu = [NSMenu new];
  [applicationMenu addItemWithTitle:NSLocalizedString(@"Quit Open-Science", nil) action:@selector(terminate:) keyEquivalent:@"q"];
  applicationItem.submenu = applicationMenu; NSApp.mainMenu = menu;
  [self launchRuntimeForceNew:YES];
  self.watcher = [NSTimer scheduledTimerWithTimeInterval:0.25 target:self selector:@selector(inspectRuntime:) userInfo:nil repeats:YES];
}
- (void)inspectRuntime:(NSTimer *)timer {
  (void)timer;
  BOOL active = NO;
  for (NSRunningApplication *application in [NSRunningApplication runningApplicationsWithBundleIdentifier:configuration[@"runtimeBundleIdentifier"]]) {
    if ([canonical(application.bundleURL.path) isEqual:runtimePath]) { active = YES; break; }
  }
  if (active || self.pendingLaunches) { self.updating = NO; return; }
  if ([files fileExistsAtPath:[stateDirectory stringByAppendingPathComponent:@"windows-update-in-progress.json"]]) {
    // Native Squirrel owns normal replacement/target launch. Keep the stable Dock entry alive
    // during its transition; a user reopen can enter the same bounded recovery handler.
    if (!self.updating) { self.updating = YES; self.updateDeadline = [NSDate dateWithTimeIntervalSinceNow:120]; }
    if (self.updateDeadline.timeIntervalSinceNow > 0) return;
  }
  [NSApp terminate:nil];
}
- (BOOL)applicationShouldHandleReopen:(NSApplication *)application hasVisibleWindows:(BOOL)visible {
  (void)application; (void)visible; [self launchRuntimeForceNew:NO]; return YES;
}
- (void)forwardURLs:(NSArray<NSURL *> *)urls replyToOpen:(BOOL)reply {
  for (;;) {
    @try { operationSnapshot = nil; targetSnapshot = nil; deadline = [NSDate dateWithTimeIntervalSinceNow:120]; ensureRuntime(); break; }
    @catch (NSException *exception) {
      NSString *stage = diagnosticStage(exception); event(stage, nil);
      if (retryFailure(stage)) continue;
      if (reply) [NSApp replyToOpenOrPrint:NSApplicationDelegateReplyFailure]; return;
    }
  }
  NSWorkspaceOpenConfiguration *options = NSWorkspaceOpenConfiguration.configuration; options.activates = YES;
  NSMutableDictionary *environment = [NSProcessInfo.processInfo.environment mutableCopy];
  environment[@"OPEN_SCIENCE_MAC_LAUNCHER_BUNDLE"] = wrapperPath; options.environment = environment;
  self.pendingLaunches++;
  [NSWorkspace.sharedWorkspace openURLs:urls withApplicationAtURL:[NSURL fileURLWithPath:runtimePath] configuration:options completionHandler:^(NSRunningApplication *opened, NSError *error) {
    (void)opened;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (self.pendingLaunches) self.pendingLaunches--;
      if (error) {
        event(@"entry-url-forward-failed", nil);
        if (retryFailure(@"entry-url-forward-failed")) [self forwardURLs:urls replyToOpen:reply];
        else if (reply) [NSApp replyToOpenOrPrint:NSApplicationDelegateReplyFailure];
      } else if (reply) [NSApp replyToOpenOrPrint:NSApplicationDelegateReplySuccess];
    });
  }];
}
- (void)application:(NSApplication *)application openURLs:(NSArray<NSURL *> *)urls {
  (void)application; [self forwardURLs:urls replyToOpen:NO];
}
- (void)application:(NSApplication *)application openFiles:(NSArray<NSString *> *)paths {
  NSMutableArray<NSURL *> *urls = [NSMutableArray array]; for (NSString *path in paths) [urls addObject:[NSURL fileURLWithPath:path]];
  (void)application; [self forwardURLs:urls replyToOpen:YES];
}
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
  (void)sender;
  if (self.internalExit) return NSTerminateNow;
  BOOL active = NO;
  for (NSRunningApplication *application in [NSRunningApplication runningApplicationsWithBundleIdentifier:configuration[@"runtimeBundleIdentifier"]])
    if ([canonical(application.bundleURL.path) isEqual:runtimePath]) { active = YES; [application terminate]; }
  // Electron can cancel its normal Quit to preserve work. Keep the ordinary Dock entry alive;
  // the watcher exits it only after the actual runtime processes have accepted Quit and exited.
  if (active || self.pendingLaunches) return NSTerminateCancel;
  return NSTerminateNow;
}
@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
#ifdef OPEN_SCIENCE_MAC_ENTRY_TESTING
    if (argc == 3 && strcmp(argv[1], "--explain-stage") == 0) {
      NSString *stage = @(argv[2]);
      NSDictionary *result = @{ @"category": failureCategory(stage), @"description": failureDescription(stage), @"diagnostics": failureDiagnostics(stage) };
      NSData *bytes = [NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
      fwrite(bytes.bytes, 1, bytes.length, stdout); return 0;
    }
#else
    (void)argc; (void)argv;
#endif
    for (;;) {
      @try { configure(); break; }
      @catch (NSException *exception) { if (!retryFailure(diagnosticStage(exception))) return 1; }
    }
    NSApplication *application = NSApplication.sharedApplication;
    [application setActivationPolicy:NSApplicationActivationPolicyRegular];
    EntryDelegate *delegate = [EntryDelegate new]; application.delegate = delegate;
    [application run]; return 0;
  }
}
