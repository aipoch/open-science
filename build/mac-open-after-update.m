// This process starts inside the old installation and survives replacement of its executable.
#import <AppKit/AppKit.h>
#include <fcntl.h>
#include <sys/param.h>
#include <sys/stat.h>
#include <unistd.h>

// The watcher starts this process with the original bundle as its working directory.
static int checkTrashedInstall(void) {
    int directory = open(".", O_RDONLY | O_DIRECTORY);
    if (directory < 0) return 1;
    char request, path[MAXPATHLEN];
    struct stat pinned, moved;
    if (read(STDIN_FILENO, &request, 1) != 1 || request != 'T' ||
        fcntl(directory, F_GETPATH, path) == -1 || fstat(directory, &pinned) ||
        lstat(path, &moved) || moved.st_dev != pinned.st_dev || moved.st_ino != pinned.st_ino) return 1;
    NSFileManager *fm = NSFileManager.defaultManager;
    NSString *current = [fm stringWithFileSystemRepresentation:path length:strlen(path)];
    NSURL *url = [NSURL fileURLWithPath:current isDirectory:YES];
    NSURLRelationship relationship;
    return [fm getRelationship:&relationship ofDirectory:NSTrashDirectory inDomain:0
                    toItemAtURL:url error:NULL] && relationship == NSURLRelationshipContains ? 0 : 1;
}

int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "--check-trashed-install") == 0) return checkTrashedInstall();
        NSData *input = [NSFileHandle.fileHandleWithStandardInput readDataToEndOfFile];
        if (!input.length) return 0;
        NSDictionary *request = [NSJSONSerialization JSONObjectWithData:input options:0 error:NULL];
        if (![request isKindOfClass:NSDictionary.class]) return 1;
        NSURL *app = [NSURL fileURLWithPath:request[@"bundle"] isDirectory:YES];
        NSMutableArray<NSURL *> *urls = [NSMutableArray array];
        for (NSString *value in request[@"urls"]) {
            NSURL *url = [NSURL URLWithString:value];
            if ((url.isFileURL && [url.pathExtension.lowercaseString isEqual:@"science"]) ||
                [url.scheme.lowercaseString isEqual:@"open-science"]) [urls addObject:url];
            else return 1;
        }
        NSWorkspaceOpenConfiguration *config = [NSWorkspaceOpenConfiguration configuration];
        config.arguments = request[@"args"];
        NSMutableDictionary *environment = [NSProcessInfo.processInfo.environment mutableCopy];
        if ([request[@"openInterrupted"] boolValue]) environment[@"OPEN_SCIENCE_UPDATE_OPEN_INTERRUPTED"] = @"1";
        else [environment removeObjectForKey:@"OPEN_SCIENCE_UPDATE_OPEN_INTERRUPTED"];
        config.environment = environment;
        config.allowsRunningApplicationSubstitution = NO;
        config.promptsUserIfNeeded = NO;
        config.addsToRecentItems = NO;
        void (^done)(NSRunningApplication *, NSError *) = ^(NSRunningApplication *running, NSError *error) {
            exit(running && !error ? 0 : 1);
        };
        if (urls.count) {
            [NSWorkspace.sharedWorkspace openURLs:urls withApplicationAtURL:app configuration:config completionHandler:done];
        } else {
            [NSWorkspace.sharedWorkspace openApplicationAtURL:app configuration:config completionHandler:done];
        }
        [NSRunLoop.currentRunLoop run];
        return 1;
    }
}
