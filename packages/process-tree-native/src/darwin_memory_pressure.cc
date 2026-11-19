#include <node_api.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <utility>

#ifdef __APPLE__
#include <cerrno>
#include <dispatch/dispatch.h>
#include <sys/sysctl.h>
#endif

namespace {
std::atomic<uint64_t> event_sequence{0};
std::atomic<uint32_t> last_event_level{0};
std::atomic<uint64_t> pressure_event_sequence{0};
std::mutex event_mutex;
const napi_type_tag subscription_tag = {0xa49eeef42c5a4891ULL, 0x84937ced7a857042ULL};

napi_value Object(napi_env env) {
  napi_value result;
  napi_create_object(env, &result);
  return result;
}
void Number(napi_env env, napi_value object, const char* key, double input) {
  napi_value value;
  napi_create_double(env, input, &value);
  napi_set_named_property(env, object, key, value);
}
void Boolean(napi_env env, napi_value object, const char* key, bool input) {
  napi_value value;
  napi_get_boolean(env, input, &value);
  napi_set_named_property(env, object, key, value);
}
napi_value Undefined(napi_env env) {
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

struct Query {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  uint32_t level = 0;
  int error = 0;
  uint64_t sequence = 0;
  uint64_t pressure_sequence = 0;
  bool supported = false;
  bool complete = false;
};

void Execute(napi_env, void* data) {
  auto* query = static_cast<Query*>(data);
  const auto before = event_sequence.load();
#ifdef __APPLE__
  query->supported = true;
  size_t size = sizeof(query->level);
  if (sysctlbyname("kern.memorystatus_vm_pressure_level", &query->level, &size, nullptr, 0) != 0) {
    query->error = errno;
  } else if (size != sizeof(query->level) ||
             (query->level != DISPATCH_MEMORYPRESSURE_NORMAL &&
              query->level != DISPATCH_MEMORYPRESSURE_WARN &&
              query->level != DISPATCH_MEMORYPRESSURE_CRITICAL)) {
    query->error = EINVAL;
  } else {
    query->complete = true;
  }
#endif
  query->sequence = event_sequence.load();
  query->pressure_sequence = pressure_event_sequence.load();
  query->complete = query->complete && before == query->sequence;
}

void Complete(napi_env env, napi_status status, void* data) {
  std::unique_ptr<Query> query(static_cast<Query*>(data));
  napi_value result = Object(env);
  Boolean(env, result, "supported", query->supported);
  Boolean(env, result, "complete", query->complete && status == napi_ok);
  Number(env, result, "eventSequence", static_cast<double>(query->sequence));
  Number(env, result, "pressureEventSequence", static_cast<double>(query->pressure_sequence));
  if (query->complete) Number(env, result, "pressureLevel", query->level);
  if (query->error) Number(env, result, "error", query->error);
  napi_resolve_deferred(env, query->deferred, result);
  napi_delete_async_work(env, query->work);
}

napi_value Sample(napi_env env, napi_callback_info) {
  auto query = std::make_unique<Query>();
  napi_value promise, name;
  napi_create_promise(env, &query->deferred, &promise);
  napi_create_string_utf8(env, "darwin-memory-pressure", NAPI_AUTO_LENGTH, &name);
  if (napi_create_async_work(env, nullptr, name, Execute, Complete, query.get(), &query->work) != napi_ok ||
      napi_queue_async_work(env, query->work) != napi_ok) {
    if (query->work) napi_delete_async_work(env, query->work);
    napi_value result = Object(env);
    Boolean(env, result, "supported", false);
    Boolean(env, result, "complete", false);
    Number(env, result, "eventSequence", static_cast<double>(event_sequence.load()));
    Number(env, result, "pressureEventSequence", static_cast<double>(pressure_event_sequence.load()));
    napi_resolve_deferred(env, query->deferred, result);
  } else {
    query.release();
  }
  return promise;
}

#ifdef __APPLE__
struct Subscription {
  napi_env env = nullptr;
  napi_threadsafe_function callback = nullptr;
  dispatch_source_t source = nullptr;
  std::atomic<bool> closed{false};
  bool cleanup_registered = false;
  dispatch_semaphore_t cancelled = dispatch_semaphore_create(0);
  ~Subscription() { dispatch_release(cancelled); }
};
using SubscriptionRef = std::shared_ptr<Subscription>;

void Close(napi_env env, Subscription* subscription);
void Cleanup(void* data) {
  auto* subscription = static_cast<Subscription*>(data);
  subscription->cleanup_registered = false;
  Close(nullptr, subscription);
}
void Close(napi_env env, Subscription* subscription) {
  if (subscription->closed.exchange(true)) return;
  if (env && subscription->cleanup_registered) {
    napi_remove_env_cleanup_hook(env, Cleanup, subscription);
    subscription->cleanup_registered = false;
  }
  // The serial Dispatch queue drains its event handler before the cancel handler releases
  // the TSFN. A stopped subscription can never call back into a disposed JS owner.
  if (subscription->source) {
    dispatch_source_cancel(subscription->source);
    // No event handler waits for JS (TSFN admission is nonblocking). Drain native callbacks
    // before an environment cleanup hook can let Node destroy the TSFN environment.
    dispatch_semaphore_wait(subscription->cancelled, DISPATCH_TIME_FOREVER);
  }
}
void FinalizeCallback(napi_env, void* data, void*) {
  delete static_cast<SubscriptionRef*>(data);
}
void CallJavascript(napi_env env, napi_value callback, void* context, void*) {
  auto* subscription = static_cast<Subscription*>(context);
  if (!env || !callback || subscription->closed.load()) return;
  napi_value event = Object(env);
  Number(env, event, "eventSequence", static_cast<double>(event_sequence.load()));
  Number(env, event, "pressureLevel", last_event_level.load());
  napi_value ignored;
  napi_call_function(env, Undefined(env), callback, 1, &event, &ignored);
}
void Event(void* data) {
  auto* reference = static_cast<SubscriptionRef*>(data);
  const auto& subscription = *reference;
  if (subscription->closed.load()) return;
  const auto level = static_cast<uint32_t>(dispatch_source_get_data(subscription->source));
  {
    std::lock_guard<std::mutex> lock(event_mutex);
    last_event_level.store(level);
    const auto sequence = event_sequence.load() + 1;
    if (level & (DISPATCH_MEMORYPRESSURE_WARN | DISPATCH_MEMORYPRESSURE_CRITICAL)) {
      pressure_event_sequence.store(sequence);
    }
    // Publish the invalidation sequence after its pressure history, including when multiple
    // Node environments have subscribed through separate Dispatch sources.
    event_sequence.store(sequence);
  }
  // At most one JS notification is queued; it reads the latest sequence/level. A full queue
  // therefore coalesces events without losing invalidation or growing memory under pressure.
  napi_call_threadsafe_function(subscription->callback, nullptr, napi_tsfn_nonblocking);
}
void Cancelled(void* data) {
  auto* reference = static_cast<SubscriptionRef*>(data);
  const auto subscription = *reference;
  dispatch_release(subscription->source);
  subscription->source = nullptr;
  napi_release_threadsafe_function(subscription->callback, napi_tsfn_abort);
  dispatch_semaphore_signal(subscription->cancelled);
  delete reference;
}
void FinalizeExternal(napi_env env, void* data, void*) {
  auto* reference = static_cast<SubscriptionRef*>(data);
  Close(env, reference->get());
  delete reference;
}
#endif

napi_value Subscribe(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value callback;
  napi_valuetype type;
  if (napi_get_cb_info(env, info, &argc, &callback, nullptr, nullptr) != napi_ok || argc != 1 ||
      napi_typeof(env, callback, &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, nullptr, "Expected a memory pressure callback");
    return nullptr;
  }
#ifdef __APPLE__
  auto subscription = std::make_shared<Subscription>();
  subscription->env = env;
  auto* callback_reference = new SubscriptionRef(subscription);
  napi_value name;
  napi_create_string_utf8(env, "darwin-memory-pressure-events", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, callback, nullptr, name, 1, 1,
                                    callback_reference, FinalizeCallback, subscription.get(),
                                    CallJavascript, &subscription->callback) != napi_ok) {
    delete callback_reference;
    napi_value result;
    napi_get_null(env, &result);
    return result;
  }
  napi_unref_threadsafe_function(env, subscription->callback);
  auto queue = dispatch_queue_create("open-science-memory-pressure", DISPATCH_QUEUE_SERIAL);
  subscription->source = dispatch_source_create(DISPATCH_SOURCE_TYPE_MEMORYPRESSURE, 0,
      DISPATCH_MEMORYPRESSURE_NORMAL | DISPATCH_MEMORYPRESSURE_WARN | DISPATCH_MEMORYPRESSURE_CRITICAL,
      queue);
  dispatch_release(queue);
  if (!subscription->source) {
    napi_release_threadsafe_function(subscription->callback, napi_tsfn_abort);
    napi_value result;
    napi_get_null(env, &result);
    return result;
  }
  auto* source_reference = new SubscriptionRef(subscription);
  dispatch_set_context(subscription->source, source_reference);
  dispatch_source_set_event_handler_f(subscription->source, Event);
  dispatch_source_set_cancel_handler_f(subscription->source, Cancelled);
  napi_add_env_cleanup_hook(env, Cleanup, subscription.get());
  subscription->cleanup_registered = true;
  napi_value result;
  napi_create_external(env, new SubscriptionRef(subscription), FinalizeExternal, nullptr, &result);
  napi_type_tag_object(env, result, &subscription_tag);
  dispatch_resume(subscription->source);
  return result;
#else
  napi_value result;
  napi_get_null(env, &result);
  return result;
#endif
}

napi_value Stop(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value handle;
  void* data = nullptr;
  bool tagged = false;
  if (napi_get_cb_info(env, info, &argc, &handle, nullptr, nullptr) != napi_ok || argc != 1 ||
      napi_get_value_external(env, handle, &data) != napi_ok || !data ||
      napi_check_object_type_tag(env, handle, &subscription_tag, &tagged) != napi_ok || !tagged) {
    napi_throw_type_error(env, nullptr, "Expected a memory pressure subscription");
    return nullptr;
  }
#ifdef __APPLE__
  Close(env, static_cast<SubscriptionRef*>(data)->get());
#endif
  return Undefined(env);
}

napi_value Sequence(napi_env env, napi_callback_info) {
  napi_value result;
  napi_create_double(env, static_cast<double>(event_sequence.load()), &result);
  return result;
}
}

void RegisterDarwinMemoryPressure(napi_env env, napi_value exports) {
  for (const auto& entry : {
           std::pair<const char*, napi_callback>{"sampleDarwinMemoryPressure", Sample},
           {"subscribeDarwinMemoryPressure", Subscribe},
           {"stopDarwinMemoryPressureSubscription", Stop},
           {"darwinMemoryPressureEventSequence", Sequence}}) {
    napi_value function;
    napi_create_function(env, entry.first, NAPI_AUTO_LENGTH, entry.second, nullptr, &function);
    napi_set_named_property(env, exports, entry.first, function);
  }
}
