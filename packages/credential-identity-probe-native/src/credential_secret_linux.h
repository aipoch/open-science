#ifdef __linux__
#include <libsecret/secret.h>
#include <dbus/dbus.h>

// KWallet's fixed key is Chromium's public OSCrypt contract. Only the authorization app name
// varies. DBus carries the secret in the private message body, never in process arguments.
static std::string kwallet_key(const std::string& backend, const std::string& wallet,
    const std::string& app, bool create, const std::string& candidate) {
  const std::string daemon = backend == "kwallet" ? "kwalletd" : "kwalletd" + backend.substr(7);
  const std::string service = "org.kde." + daemon, path = "/modules/" + daemon;
  DBusError error; dbus_error_init(&error);
  DBusConnection* bus = dbus_bus_get_private(DBUS_BUS_SESSION, &error);
  if (!bus) { dbus_error_free(&error); return {}; }
  dbus_connection_set_exit_on_disconnect(bus, false);
  auto call = [&](const char* method, auto append) -> DBusMessage* {
    DBusMessage* request = dbus_message_new_method_call(service.c_str(), path.c_str(), "org.kde.KWallet", method);
    if (!request) return nullptr;
    append(request);
    DBusMessage* reply = dbus_connection_send_with_reply_and_block(bus, request, 10000, &error);
    dbus_message_unref(request);
    if (dbus_error_is_set(&error)) dbus_error_free(&error);
    return reply;
  };
  const char *wallet_arg=wallet.c_str(), *app_arg=app.c_str();
  DBusMessage* reply = call("isOpen", [&](DBusMessage* m) { dbus_message_append_args(m, DBUS_TYPE_STRING, &wallet_arg, DBUS_TYPE_INVALID); });
  dbus_bool_t open = false;
  bool ok = reply && dbus_message_get_args(reply, nullptr, DBUS_TYPE_BOOLEAN, &open, DBUS_TYPE_INVALID) && open;
  if (reply) dbus_message_unref(reply);
  dbus_int32_t handle = -1;
  if (ok) {
    dbus_int64_t window = 0;
    reply = call("open", [&](DBusMessage* m) { dbus_message_append_args(m, DBUS_TYPE_STRING, &wallet_arg, DBUS_TYPE_INT64, &window, DBUS_TYPE_STRING, &app_arg, DBUS_TYPE_INVALID); });
    ok = reply && dbus_message_get_args(reply, nullptr, DBUS_TYPE_INT32, &handle, DBUS_TYPE_INVALID) && handle >= 0;
    if (reply) dbus_message_unref(reply);
  }
  std::string value;
  const char *folder="Chromium Keys", *key="Chromium Safe Storage";
  if (ok) {
    reply = call("keyDoesNotExist", [&](DBusMessage* m) { dbus_message_append_args(m, DBUS_TYPE_STRING, &wallet_arg, DBUS_TYPE_STRING, &folder, DBUS_TYPE_STRING, &key, DBUS_TYPE_INVALID); });
    dbus_bool_t absent = false;
    ok = reply && dbus_message_get_args(reply, nullptr, DBUS_TYPE_BOOLEAN, &absent, DBUS_TYPE_INVALID);
    if (reply) dbus_message_unref(reply);
    if (ok && absent && create) {
      // createFolder is idempotent for an already-present folder.
      reply = call("createFolder", [&](DBusMessage* m) { dbus_message_append_args(m, DBUS_TYPE_INT32, &handle, DBUS_TYPE_STRING, &folder, DBUS_TYPE_STRING, &app_arg, DBUS_TYPE_INVALID); });
      dbus_bool_t created = false;
      ok = reply && dbus_message_get_args(reply, nullptr, DBUS_TYPE_BOOLEAN, &created, DBUS_TYPE_INVALID) && created;
      if (reply) dbus_message_unref(reply);
      if (ok) {
        const char* password = candidate.c_str();
        reply = call("writePassword", [&](DBusMessage* m) { dbus_message_append_args(m, DBUS_TYPE_INT32, &handle, DBUS_TYPE_STRING, &folder, DBUS_TYPE_STRING, &key, DBUS_TYPE_STRING, &password, DBUS_TYPE_STRING, &app_arg, DBUS_TYPE_INVALID); });
        dbus_int32_t status = -1;
        ok = reply && dbus_message_get_args(reply, nullptr, DBUS_TYPE_INT32, &status, DBUS_TYPE_INVALID) && status == 0;
        if (reply) dbus_message_unref(reply);
      }
    } else if (absent) ok = false;
    if (ok) {
      reply = call("readPassword", [&](DBusMessage* m) { dbus_message_append_args(m, DBUS_TYPE_INT32, &handle, DBUS_TYPE_STRING, &folder, DBUS_TYPE_STRING, &key, DBUS_TYPE_STRING, &app_arg, DBUS_TYPE_INVALID); });
      const char* password = nullptr;
      if (reply && dbus_message_get_args(reply, nullptr, DBUS_TYPE_STRING, &password, DBUS_TYPE_INVALID) && password) value = password;
      if (reply) dbus_message_unref(reply);
    }
  }
  dbus_connection_close(bus); dbus_connection_unref(bus);
  return value;
}
static std::string secret_service_key(const std::string& app, bool create, const std::string& candidate) {
  const SecretSchema schema = {"chrome_libsecret_os_crypt_password_v2", SECRET_SCHEMA_DONT_MATCH_NAME,
      {{"application", SECRET_SCHEMA_ATTRIBUTE_STRING}, {nullptr, SECRET_SCHEMA_ATTRIBUTE_STRING}}};
  GError* error = nullptr;
  gchar* password = secret_password_lookup_sync(&schema, nullptr, &error, "application", app.c_str(), nullptr);
  if (error) { g_error_free(error); return {}; }
  if (!password && create) {
    const bool stored = secret_password_store_sync(&schema, SECRET_COLLECTION_DEFAULT,
        (app + " Safe Storage").c_str(), candidate.c_str(), nullptr, &error, "application", app.c_str(), nullptr);
    if (error) { g_error_free(error); return {}; }
    if (!stored) return {};
    password = secret_password_lookup_sync(&schema, nullptr, &error, "application", app.c_str(), nullptr);
  }
  std::string value;
  if (!error && password) value = password;
  if (password) secret_password_free(password);
  if (error) g_error_free(error);
  return value;
}
#endif
