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
@property NSTextField *heading;
@property NSTextField *version;
@property NSImageView *icon;
@property NSButton *closeButton;
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
  self.spinner.hidden = YES;
  [self layoutContent];
}
- (void)closeWindow:(id)sender { [NSApp terminate:nil]; }
- (BOOL)windowShouldClose:(NSWindow *)sender { [NSApp terminate:nil]; return YES; }
// Keep the native type, colors and controls so contrast, focus and appearance follow macOS.
- (void)layoutContent {
  const CGFloat width = 440, inset = 24, textX = 96, textWidth = width - textX - inset;
  CGFloat titleHeight = ceil([self.heading.cell cellSizeForBounds:NSMakeRect(0, 0, textWidth, CGFLOAT_MAX)].height);
  CGFloat detailHeight = ceil([self.label.cell cellSizeForBounds:NSMakeRect(0, 0, textWidth, CGFLOAT_MAX)].height);
  CGFloat progressHeight = self.spinner.hidden ? 12 : 18 + 6 + 12;
  CGFloat height = inset + titleHeight + 5 + 18 + progressHeight + detailHeight + 16 + 24 + 20;
  [self.window setContentSize:NSMakeSize(width, height)];
  CGFloat y = height - inset;
  self.icon.frame = NSMakeRect(inset, y - 56, 56, 56);
  self.heading.frame = NSMakeRect(textX, y - titleHeight, textWidth, titleHeight);
  y -= titleHeight + 5 + 18;
  self.version.frame = NSMakeRect(textX, y, textWidth, 18);
  if (!self.spinner.hidden) {
    y -= 18 + 6;
    self.spinner.frame = NSMakeRect(textX, y, textWidth, 6);
  }
  y -= 12 + detailHeight;
  self.label.frame = NSMakeRect(textX, y, textWidth, detailHeight);
  [self.closeButton sizeToFit];
  NSSize buttonSize = self.closeButton.frame.size;
  self.closeButton.frame = NSMakeRect(width - inset - buttonSize.width, 16, buttonSize.width, buttonSize.height);
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 440, 200)
      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
      backing:NSBackingStoreBuffered defer:NO];
  self.window.title = @"Open-Science";
  self.window.titleVisibility = NSWindowTitleHidden;
  self.window.titlebarAppearsTransparent = YES;
  self.window.delegate = self;
  self.window.releasedWhenClosed = NO;
  // It stays available during handoff without covering unrelated applications.
  self.window.level = NSNormalWindowLevel;
  NSString *bundle = [[self.config[@"applicationPath"] stringByDeletingLastPathComponent]
      stringByDeletingLastPathComponent];
  bundle = [bundle stringByDeletingLastPathComponent];
  NSImage *source = [[NSWorkspace sharedWorkspace] iconForFile:bundle];
  // Materialize before the old application bundle is replaced.
  NSImage *image = [[NSImage alloc] initWithData:source.TIFFRepresentation];
  self.icon = [[NSImageView alloc] initWithFrame:NSZeroRect];
  self.icon.image = image;
  self.icon.imageScaling = NSImageScaleProportionallyUpOrDown;
  self.icon.accessibilityElement = NO;
  self.heading = [NSTextField wrappingLabelWithString:self.config[@"installing"]];
  self.heading.font = [NSFont systemFontOfSize:17 weight:NSFontWeightSemibold];
  self.heading.textColor = NSColor.labelColor;
  self.version = [NSTextField labelWithString:self.config[@"version"]];
  self.version.font = [NSFont systemFontOfSize:12];
  self.version.textColor = NSColor.secondaryLabelColor;
  self.version.lineBreakMode = NSLineBreakByTruncatingTail;
  self.version.toolTip = self.config[@"version"];
  self.spinner = [[NSProgressIndicator alloc] initWithFrame:NSZeroRect];
  self.spinner.style = NSProgressIndicatorStyleBar;
  self.spinner.indeterminate = YES;
  self.spinner.controlSize = NSControlSizeSmall;
  self.spinner.accessibilityLabel = self.config[@"installing"];
  [self.spinner startAnimation:nil];
  self.label = [NSTextField wrappingLabelWithString:self.config[@"reopening"]];
  self.label.font = [NSFont systemFontOfSize:13];
  self.label.textColor = NSColor.secondaryLabelColor;
  self.closeButton = [NSButton buttonWithTitle:self.config[@"close"] target:self action:@selector(closeWindow:)];
  self.closeButton.bezelStyle = NSBezelStyleRounded;
  self.closeButton.controlSize = NSControlSizeSmall;
  self.closeButton.font = [NSFont systemFontOfSize:12];
  self.closeButton.toolTip = self.config[@"closeHelp"];
  self.closeButton.accessibilityHelp = self.config[@"closeHelp"];
  self.closeButton.keyEquivalent = @"\e";
  for (NSView *view in @[self.icon, self.heading, self.version, self.spinner, self.label, self.closeButton])
    [self.window.contentView addSubview:view];
  [self layoutContent];
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
    for (NSString *key in @[@"installing", @"unconfirmed", @"close", @"closeHelp", @"reopening", @"version", @"applicationPath"]) {
      id value = config[key];
      if (![value isKindOfClass:NSString.class] || [value length] < 1 || [value length] > 4096) return 1;
    }
    if (![config[@"applicationPath"] isAbsolutePath]) return 1;
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
