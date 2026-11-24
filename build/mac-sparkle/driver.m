#import <Cocoa/Cocoa.h>
#import <Sparkle/Sparkle.h>
#import <node_api.h>

// Deliver the one-shot Sparkle result on Node's event loop, including when the host is quitting.
static napi_threadsafe_function completion;
static BOOL shouldRelaunch, abandoned;
static void (^installReply)(SPUUserUpdateChoice);
static void (^cancelDownload)(void);

static void resolvePreparation(napi_env env, napi_value unused, void *context, void *data) {
    char *message = data;
    if (env != NULL) {
        napi_value value;
        if (message != NULL) {
            napi_value error;
            napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &value);
            napi_create_error(env, NULL, value, &error);
            napi_reject_deferred(env, context, error);
        } else {
            napi_get_undefined(env, &value);
            napi_resolve_deferred(env, context, value);
        }
    }
    free(message);
}

static void finish(NSString *error) {
    if (!completion) return;
    char *message = error ? strdup(error.UTF8String) : NULL;
    if (napi_call_threadsafe_function(completion, message, napi_tsfn_nonblocking) != napi_ok)
        free(message);
    napi_release_threadsafe_function(completion, napi_tsfn_release);
    completion = NULL;
}

@interface Driver : NSObject <SPUUserDriver, SPUUpdaterDelegate>
@property(copy) NSString *url;
@end
@implementation Driver
- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater { return self.url; }
- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancel { cancelDownload = [cancel copy]; }
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)item state:(SPUUserUpdateState *)state reply:(void (^)(SPUUserUpdateChoice))reply {
    reply(abandoned ? SPUUserUpdateChoiceSkip : SPUUserUpdateChoiceInstall);
}
- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancel { cancelDownload = [cancel copy]; }
- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)size {}
- (void)showDownloadDidReceiveDataOfLength:(uint64_t)size {}
- (void)showDownloadDidStartExtractingUpdate { cancelDownload = nil; }
- (void)showExtractionReceivedProgress:(double)p {}
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply {
    if (abandoned) {
        reply(SPUUserUpdateChoiceSkip);
        return;
    }
    installReply = [reply copy];
    finish(nil);
}
- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)t retryTerminatingApplication:(void (^)(void))retry {}
- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunch acknowledgement:(void (^)(void))ack { ack(); }
- (void)showUpdateNotFoundWithError:(NSError *)error acknowledgement:(void (^)(void))ack { finish(error.localizedDescription); ack(); }
- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))ack { finish(error.localizedDescription); ack(); }
- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request reply:(void (^)(SUUpdatePermissionResponse *))reply {
    finish(@"Unexpected update permission request");
    reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:NO sendSystemProfile:NO]);
}
- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)data {}
- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)error {}
- (void)dismissUpdateInstallation {}
@end

static SPUUpdater *updater;
static Driver *driver;
static napi_value begin(napi_env env, napi_callback_info info) {
    size_t count = 2, length = 0;
    napi_value arguments[2], promise, name;
    napi_deferred deferred;
    bool relaunch = false;
    char url[256] = {0};
    napi_get_cb_info(env, info, &count, arguments, NULL, NULL);
    if (updater || count != 2 || napi_get_value_bool(env, arguments[1], &relaunch) != napi_ok ||
        napi_get_value_string_utf8(env, arguments[0], url, sizeof(url), &length) != napi_ok ||
        !length || length >= sizeof(url)-1) {
        napi_throw_error(env, NULL, "Invalid Sparkle handoff");
        return NULL;
    }
    napi_create_promise(env, &deferred, &promise);
    napi_create_string_utf8(env, "Sparkle preparation", NAPI_AUTO_LENGTH, &name);
    if (napi_create_threadsafe_function(env, NULL, NULL, name, 1, 1, NULL, NULL, deferred,
                                        resolvePreparation, &completion) != napi_ok) {
        napi_throw_error(env, NULL, "Could not register the Sparkle callback");
        return NULL;
    }
    shouldRelaunch = relaunch;
    NSBundle *bundle = NSBundle.mainBundle;
    driver = [Driver new];
    driver.url = [NSString stringWithUTF8String:url];
    updater = [[SPUUpdater alloc] initWithHostBundle:bundle applicationBundle:bundle userDriver:driver delegate:driver];
    NSError *error = nil;
    if ([updater startUpdater:&error]) [updater checkForUpdates];
    else finish(error.localizedDescription ?: @"Could not start Sparkle");
    return promise;
}

static napi_value commit(napi_env env, napi_callback_info info) {
    if (!installReply || abandoned) {
        napi_throw_error(env, NULL, "Sparkle update is no longer ready");
        return NULL;
    }
    installReply(shouldRelaunch ? SPUUserUpdateChoiceInstall : SPUUserUpdateChoiceDismiss);
    installReply = nil;
    return NULL;
}

static napi_value abandon(napi_env env, napi_callback_info info) {
    abandoned = YES;
    if (installReply) installReply(SPUUserUpdateChoiceSkip);
    else if (cancelDownload) cancelDownload();
    installReply = nil;
    cancelDownload = nil;
    finish(@"Sparkle preparation abandoned");
    return NULL;
}

static napi_value init(napi_env env, napi_value exports) {
    napi_property_descriptor methods[] = {
        {"begin", NULL, begin, NULL, NULL, NULL, napi_default, NULL},
        {"commit", NULL, commit, NULL, NULL, NULL, napi_default, NULL},
        {"abandon", NULL, abandon, NULL, NULL, NULL, napi_default, NULL}
    };
    napi_define_properties(env, exports, 3, methods);
    return exports;
}
NAPI_MODULE(mac_sparkle, init)
