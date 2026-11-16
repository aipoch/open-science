from pathlib import Path


def replace(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f"Expected one instrumentation point: {old}")
    return text.replace(old, new)


native_path = Path('packages/process-tree-native/src/windows_owned_process.cc')
native = native_path.read_text(encoding='utf-8')
native = replace(
    native, 'void QueryOccupants(OccupancyQuery& query) {',
    '''void TraceOccupant(const char* stage, DWORD session, DWORD pid, DWORD result,
                   DWORD metadata = 0, const FILETIME* start = nullptr) {
  FILETIME now{};
  GetSystemTimePreciseAsFileTime(&now);
  const auto stamp = (static_cast<unsigned long long>(now.dwHighDateTime) << 32) | now.dwLowDateTime;
  const auto created = start ? (static_cast<unsigned long long>(start->dwHighDateTime) << 32) | start->dwLowDateTime : 0;
  std::fprintf(stderr,
    "NATIVE_TRACE stage=%s time_filetime=%llu thread=%lu test_pid=%lu session=%lu pid=%lu result=%lu metadata=%lu process_start_filetime=%llu\\n",
    stage, stamp, GetCurrentThreadId(), GetCurrentProcessId(), session, pid, result, metadata, created);
}

void QueryOccupants(OccupancyQuery& query) {'''
)
native = replace(
    native, '    query.code = RmGetList(session, &needed, &count, rows.data(), &reasons);',
    '''    query.code = RmGetList(session, &needed, &count, rows.data(), &reasons);
    TraceOccupant("RmGetList", session, 0, query.code, count);'''
)
native = replace(
    native, '''    process.value = OpenProcess(SYNCHRONIZE, FALSE, pid);
    if (!process.value) {
      process.value = INVALID_HANDLE_VALUE;
      if (GetLastError() == ERROR_INVALID_PARAMETER) continue;
    } else if (WaitForSingleObject(process.value, 0) == WAIT_OBJECT_0) {
      continue;
    }''',
    '''    process.value = OpenProcess(SYNCHRONIZE, FALSE, pid);
    const DWORD openError = process.value ? ERROR_SUCCESS : GetLastError();
    const DWORD wait = process.value ? WaitForSingleObject(process.value, 0) : WAIT_FAILED;
    const DWORD waitError = process.value && wait == WAIT_FAILED ? GetLastError() : ERROR_SUCCESS;
    TraceOccupant("RmRow", session, pid, rows[i].AppStatus, 0, &rows[i].Process.ProcessStartTime);
    TraceOccupant("OpenProcess(SYNCHRONIZE)", session, pid, openError, process.value ? 1 : 0);
    if (!process.value) {
      process.value = INVALID_HANDLE_VALUE;
      if (openError == ERROR_INVALID_PARAMETER) continue;
    } else {
      TraceOccupant("WaitForSingleObject", session, pid, wait, waitError);
      if (wait == WAIT_OBJECT_0) continue;
    }'''
)
native_path.write_bytes(native.encode('utf-8'))

test_path = Path('packages/process-tree-native/test/windows-process-identity.cjs')
test = test_path.read_text(encoding='utf-8')
start = test.index("test('does not report terminated processes whose handles are still held'")
end = test.index("\nfor (const namespace", start)
section = test[start:end]
section = replace(section, '''  copyFileSync(process.execPath, executable)
  try {''', '''  const trace = (event, details = {}) => {
    process._rawDebug('TEST_TRACE ' + JSON.stringify({ event, utc: new Date().toISOString(), testPid: process.pid, executable, ...details }))
  }
  copyFileSync(process.execPath, executable)
  trace('copied')
  try {''')
section = replace(section, '''      const worker = Number((await once(host.stdout, 'data'))[0])
      const live''', '''      host.once('exit', (code, signal) => trace('host-exit-event', { round, host: host.pid, code, signal }))
      const worker = Number((await once(host.stdout, 'data'))[0])
      trace('fixture', { round, host: host.pid, worker })
      const live''')
section = replace(section, '''      assert.ok(live.includes(host.pid) && live.includes(worker), JSON.stringify(live))''', '''      trace('live-occupants', { round, live })
      assert.ok(live.includes(host.pid) && live.includes(worker), JSON.stringify(live))
      trace('taskkill-start', { round, host: host.pid, worker })''')
section = replace(section, '''      await once(killer, 'exit')
      assert.deepEqual(native.listWindowsInstallationOccupants([executable]), [], `round ${round}`)
      assert.deepEqual(await native.listWindowsInstallationOccupantsAsync([executable]), [])''', '''      const [taskkillCode, taskkillSignal] = await once(killer, 'exit')
      trace('taskkill-exit-event', { round, host: host.pid, worker, killer: killer.pid, taskkillCode, taskkillSignal })
      const sync = native.listWindowsInstallationOccupants([executable])
      trace('post-kill-sync', { round, occupants: sync })
      if (sync.length > 0) {
        trace('unexpected-processes', { round, rows: native.listWindowsProcesses().filter(row => sync.includes(row.pid)) })
      }
      assert.deepEqual(sync, [], `round ${round}`)
      const asyncOccupants = await native.listWindowsInstallationOccupantsAsync([executable])
      trace('post-kill-async', { round, occupants: asyncOccupants })
      assert.deepEqual(asyncOccupants, [])''')
section = replace(section, '''    rmSync(root, { recursive: true, force: true })''', '''    trace('cleanup-start')
    try {
      rmSync(root, { recursive: true, force: true })
      trace('cleanup-finished')
    } catch (error) {
      trace('cleanup-error', { code: error.code, syscall: error.syscall, path: error.path })
      try {
        trace('cleanup-occupants', { occupants: native.listWindowsInstallationOccupants([executable]) })
      } catch (queryError) {
        trace('cleanup-occupant-error', { error: String(queryError) })
      }
      throw error
    }''')
remaining = test[end:]
remaining = replace(
    remaining, '''      try {
        assert.equal(await native.windowsOwnedProcessExitCodeAsync(child.handle), 259)''',
    '''      const trace = (event, details = {}) => {
        process._rawDebug('TEST_TRACE ' + JSON.stringify({ event, utc: new Date().toISOString(), testPid: process.pid, namespace, child: child.pid, executable, ...details }))
      }
      trace('exit259-fixture')
      try {
        const code = await native.windowsOwnedProcessExitCodeAsync(child.handle)
        trace('exit259-wait-return', { code })
        assert.equal(code, 259)'''
)
remaining = replace(
    remaining, '''        assert.deepEqual(native.listWindowsInstallationOccupants([executable]), [])
        assert.deepEqual(await native.listWindowsInstallationOccupantsAsync([executable]), [])''',
    '''        const sync = native.listWindowsInstallationOccupants([executable])
        trace('exit259-sync', { occupants: sync })
        if (sync.length > 0) {
          trace('unexpected-processes', { rows: native.listWindowsProcesses().filter(row => sync.includes(row.pid)) })
        }
        assert.deepEqual(sync, [])
        const asyncOccupants = await native.listWindowsInstallationOccupantsAsync([executable])
        trace('exit259-async', { occupants: asyncOccupants })
        assert.deepEqual(asyncOccupants, [])'''
)
remaining = replace(
    remaining, '''        rmSync(root, { recursive: true, force: true })''',
    '''        trace('cleanup-start')
        try {
          rmSync(root, { recursive: true, force: true })
          trace('cleanup-finished')
        } catch (error) {
          trace('cleanup-error', { code: error.code, syscall: error.syscall, path: error.path })
          throw error
        }'''
)
test_path.write_bytes((test[:start] + section + remaining).encode('utf-8'))
