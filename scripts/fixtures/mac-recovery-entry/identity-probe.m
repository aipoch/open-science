#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#include <unistd.h>
#include <sys/wait.h>

int main(int argc, char *argv[]) {
  @autoreleasepool {
#ifdef PROBE_PAYLOAD_EXEC
    char **childArgv = calloc((size_t)argc + 1, sizeof(char *));
    childArgv[0] = PROBE_PAYLOAD_EXEC;
    for (int i = 1; i < argc; i++) childArgv[i] = argv[i];
#ifdef PROBE_CHILD
    pid_t child = fork();
    if (child < 0) return 3;
    if (child == 0) { execv(childArgv[0], childArgv); _exit(4); }
    int status = 0;
    waitpid(child, &status, 0);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 5;
#else
    execv(childArgv[0], childArgv);
    return 4;
#endif
#else
    [NSApplication sharedApplication];
    NSDictionary *proof = @{
      @"bundlePath": NSBundle.mainBundle.bundlePath ?: @"",
      @"runningApplicationBundlePath": NSRunningApplication.currentApplication.bundleURL.path ?: @"",
      @"executablePath": NSRunningApplication.currentApplication.executableURL.path ?: @"",
      @"arguments": NSProcessInfo.processInfo.arguments,
      @"pid": @(getpid()), @"ppid": @(getppid())
    };
    NSData *data = [NSJSONSerialization dataWithJSONObject:proof options:NSJSONWritingPrettyPrinted error:NULL];
    return [data writeToFile:@(PROBE_RECEIPT) options:NSDataWritingAtomic error:NULL] ? 0 : 2;
#endif
  }
}
