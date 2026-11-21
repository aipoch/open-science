// This process starts inside the old installation and survives replacement of its executable.
#import <AppKit/AppKit.h>

int main(void) {
    @autoreleasepool {
        NSData *input = [NSFileHandle.fileHandleWithStandardInput readDataToEndOfFile];
        if (!input.length) return 0;
        NSDictionary *request = [NSJSONSerialization JSONObjectWithData:input options:0 error:nil];
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
        config.environment = NSProcessInfo.processInfo.environment;
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
