#import <Cocoa/Cocoa.h>
#import <dispatch/dispatch.h>
#import <sys/stat.h>
#import <fcntl.h>
#import <unistd.h>
#import <signal.h>

// A presentation-only process: it never launches, terminates or modifies the installer/application.
static NSDictionary *ReadJSON(NSString *path) {
  int fd = open(path.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return nil;
  struct stat st;
  if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_uid != getuid() ||
      (st.st_mode & 0022) || st.st_size < 1 || st.st_size > 65536) { close(fd); return nil; }
  NSMutableData *bytes = [NSMutableData dataWithLength:(NSUInteger)st.st_size];
  NSUInteger offset = 0;
  while (offset < bytes.length) {
    ssize_t count = read(fd, (char *)bytes.mutableBytes + offset, bytes.length - offset);
    if (count <= 0) { close(fd); return nil; }
    offset += (NSUInteger)count;
  }
  close(fd);
  id json = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
  return [json isKindOfClass:NSDictionary.class] ? json : nil;
}

@interface Progress : NSObject <NSApplicationDelegate, NSWindowDelegate>
@property NSDictionary *config;
@property NSString *directory;
@property NSWindow *window;
@property NSTextField *label;
@property NSProgressIndicator *spinner;
@property dispatch_source_t changes;
@property dispatch_source_t parentExit;
@property BOOL parentGone;
@end

@implementation Progress
- (void)readState {
  NSDictionary *state = ReadJSON([self.directory stringByAppendingPathComponent:@"state.json"]);
  if (![state[@"operationId"] isEqual:self.config[@"operationId"]]) { [NSApp terminate:nil]; return; }
  NSString *phase = state[@"phase"];
  if ([phase isEqual:@"ready"] || [phase isEqual:@"cancelled"] ||
      (self.parentGone && [phase isEqual:@"prepared"])) { [NSApp terminate:nil]; return; }
  if ([phase isEqual:@"unconfirmed"]) [self showUnconfirmed];
}
- (void)showUnconfirmed {
  self.label.stringValue = self.config[@"unconfirmed"];
  [self.spinner stopAnimation:nil];
}
- (void)closeWindow:(id)sender { [NSApp terminate:nil]; }
- (BOOL)windowShouldClose:(NSWindow *)sender { [NSApp terminate:nil]; return YES; }
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 460, 180)
      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
      backing:NSBackingStoreBuffered defer:NO];
  self.window.title = @"Open-Science";
  self.window.delegate = self;
  self.window.releasedWhenClosed = NO;
  self.window.level = NSFloatingWindowLevel;
  self.spinner = [[NSProgressIndicator alloc] initWithFrame:NSMakeRect(24, 102, 24, 24)];
  self.spinner.style = NSProgressIndicatorStyleSpinning;
  self.spinner.indeterminate = YES;
  [self.spinner startAnimation:nil];
  [self.window.contentView addSubview:self.spinner];
  self.label = [NSTextField wrappingLabelWithString:self.config[@"installing"]];
  self.label.frame = NSMakeRect(64, 66, 370, 70);
  self.label.font = [NSFont systemFontOfSize:14];
  [self.window.contentView addSubview:self.label];
  NSButton *closeButton = [NSButton buttonWithTitle:self.config[@"close"] target:self action:@selector(closeWindow:)];
  [closeButton sizeToFit];
  closeButton.frame = NSMakeRect(MAX(24, 436 - closeButton.frame.size.width), 20, closeButton.frame.size.width, closeButton.frame.size.height);
  [self.window.contentView addSubview:closeButton];
  [self.window center];
  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];

  int fd = open(self.directory.fileSystemRepresentation, O_EVTONLY | O_NOFOLLOW);
  if (fd < 0) { [NSApp terminate:nil]; return; }
  self.changes = dispatch_source_create(DISPATCH_SOURCE_TYPE_VNODE, fd,
      DISPATCH_VNODE_WRITE | DISPATCH_VNODE_DELETE | DISPATCH_VNODE_RENAME, dispatch_get_main_queue());
  dispatch_source_set_event_handler(self.changes, ^{ [self readState]; });
  dispatch_source_set_cancel_handler(self.changes, ^{ close(fd); });
  dispatch_resume(self.changes);
  self.parentExit = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC,
      [self.config[@"parentPid"] intValue], DISPATCH_PROC_EXIT, dispatch_get_main_queue());
  dispatch_source_set_event_handler(self.parentExit, ^{ self.parentGone = YES; [self readState]; });
  dispatch_resume(self.parentExit);
  [self readState];
  NSDictionary *ready = @{ @"operationId": self.config[@"operationId"], @"pid": @(getpid()), @"visible": @(self.window.visible) };
  NSData *json = [NSJSONSerialization dataWithJSONObject:ready options:0 error:nil];
  fwrite(json.bytes, 1, json.length, stdout); fputc('\n', stdout); fflush(stdout);
  // These bound presentation only. A timeout never declares installation failure or stops ShipIt.
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ [self showUnconfirmed]; });
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 600 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ [NSApp terminate:nil]; });
}
- (void)applicationWillTerminate:(NSNotification *)notification {
  if (self.changes) dispatch_source_cancel(self.changes);
  if (self.parentExit) dispatch_source_cancel(self.parentExit);
  for (NSString *name in @[@"config.json", @"request.json", @"state.json", @"state.tmp", @"progress"])
    unlink([self.directory stringByAppendingPathComponent:name].fileSystemRepresentation);
  rmdir(self.directory.fileSystemRepresentation);
}
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    signal(SIGPIPE, SIG_IGN);
    if (argc != 2) return 1;
    NSString *path = [NSString stringWithUTF8String:argv[1]];
    NSDictionary *config = ReadJSON(path);
    if (!config || ![config[@"operationId"] isKindOfClass:NSString.class] ||
        ![config[@"parentPid"] isKindOfClass:NSNumber.class] || [config[@"parentPid"] intValue] != getppid() ||
        ![[NSUUID alloc] initWithUUIDString:config[@"operationId"]]) return 1;
    for (NSString *key in @[@"installing", @"unconfirmed", @"close"]) {
      id value = config[key];
      if (![value isKindOfClass:NSString.class] || [value length] < 1 || [value length] > 4096) return 1;
    }
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    Progress *delegate = [Progress new];
    delegate.config = config;
    delegate.directory = path.stringByDeletingLastPathComponent;
    NSApp.delegate = delegate;
    [NSApp run];
  }
  return 0;
}
