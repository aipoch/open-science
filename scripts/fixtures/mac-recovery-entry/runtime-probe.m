#import <AppKit/AppKit.h>
#import <CommonCrypto/CommonDigest.h>
#include <unistd.h>
#include <limits.h>
#if defined(__x86_64__)
#define PROBE_ARCHITECTURE @"x64"
#else
#define PROBE_ARCHITECTURE @"arm64"
#endif

static NSString *hash(NSString *value) {
  NSData *bytes = [value dataUsingEncoding:NSUTF8StringEncoding]; unsigned char result[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bytes.bytes, (CC_LONG)bytes.length, result); NSMutableString *hex = [NSMutableString string];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) [hex appendFormat:@"%02x", result[i]]; return hex;
}
int main(void) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    char resolved[PATH_MAX];
    NSString *bundle = realpath(NSBundle.mainBundle.bundlePath.fileSystemRepresentation, resolved) ? @(resolved) : NSBundle.mainBundle.bundlePath;
    NSDictionary *env = NSProcessInfo.processInfo.environment;
    NSString *state = [env[@"OPEN_SCIENCE_INSTALLATION_STATE_ROOT"] stringByAppendingPathComponent:hash(bundle)];
    NSDictionary *marker = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[state stringByAppendingPathComponent:@"windows-update-in-progress.json"]] ?: NSData.data options:0 error:NULL];
    NSDictionary *request = marker ? [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[marker[@"handoffDirectory"] stringByAppendingPathComponent:@"request.json"]] options:0 error:NULL] : nil;
    NSDictionary *startup = request[@"startupOptions"] ?: @{};
    NSMutableArray *applications = [NSMutableArray array];
    for (NSString *identifier in @[NSBundle.mainBundle.bundleIdentifier, [NSBundle.mainBundle.bundleIdentifier stringByAppendingString:@".launcher"]])
      for (NSRunningApplication *application in [NSRunningApplication runningApplicationsWithBundleIdentifier:identifier]) {
        NSString *applicationPath = realpath(application.bundleURL.path.fileSystemRepresentation, resolved) ? @(resolved) : application.bundleURL.path;
        [applications addObject:@{@"bundlePath": applicationPath ?: @"", @"activationPolicy": @(application.activationPolicy), @"pid": @(application.processIdentifier)}];
      }
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 480, 240) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.title = @"Open-Science recovery entry native fixture"; [window orderFront:nil];
    NSDictionary *proof = @{
      @"version": @(PROBE_VERSION), @"architecture": PROBE_ARCHITECTURE, @"bundlePath": bundle, @"runtimePid": @(getpid()),
      @"ppid": @(getppid()), @"arguments": NSProcessInfo.processInfo.arguments,
      @"activationPolicy": @(NSApp.activationPolicy), @"applications": applications,
      @"launcherBundle": env[@"OPEN_SCIENCE_MAC_LAUNCHER_BUNDLE"] ?: @"",
      @"startupOptions": startup,
      @"data": [NSString stringWithContentsOfFile:[startup[@"dataRoot"] ?: @"" stringByAppendingPathComponent:@"scientific-result.txt"] encoding:NSUTF8StringEncoding error:NULL] ?: @"",
      @"windowVisible": @(window.visible)
    };
    NSData *data = [NSJSONSerialization dataWithJSONObject:proof options:NSJSONWritingPrettyPrinted error:NULL];
    [data writeToFile:env[@"OPEN_SCIENCE_MAC_ENTRY_FIXTURE_RECEIPT"] options:NSDataWritingAtomic error:NULL];
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:0.5];
    while (until.timeIntervalSinceNow > 0) [NSRunLoop.mainRunLoop runMode:NSDefaultRunLoopMode beforeDate:until];
    return 0;
  }
}
