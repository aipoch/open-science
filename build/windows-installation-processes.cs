using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// A short-lived Win32 inspection/close adapter. No shell, WMI, child processes, or installer writes.
internal static class InstallationProcesses {
  [StructLayout(LayoutKind.Sequential)] struct UniqueProcess { public uint Pid; public System.Runtime.InteropServices.ComTypes.FILETIME Started; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct ProcessInfo {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceName;
    public uint ApplicationType, Status, SessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern uint RmStartSession(out uint session, uint flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern uint RmRegisterResources(uint session, uint count, string[] files, uint apps, IntPtr processes, uint services, IntPtr names);
  [DllImport("rstrtmgr.dll")] static extern uint RmGetList(uint session, out uint needed, ref uint count, [In, Out] ProcessInfo[] processes, out uint reasons);
  [DllImport("rstrtmgr.dll")] static extern uint RmEndSession(uint session);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder image, ref uint size);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandle(IntPtr file, StringBuilder path, uint size, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenMutex(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReleaseMutex(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetPrivateProfileString(string section, string key, string fallback, StringBuilder value, uint size, string path);
  delegate bool EnumWindow(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll", SetLastError = true)] static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", SetLastError = true)] static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);

  sealed class Owned : IDisposable {
    public uint Pid; public IntPtr Handle; public string Image;
    public void Dispose() { if (Handle != IntPtr.Zero) { CloseHandle(Handle); Handle = IntPtr.Zero; } }
    public bool Alive() {
      uint status = WaitForSingleObject(Handle, 0);
      if (status == 0) return false;
      if (status == 258) return true;
      throw new Win32Exception(Marshal.GetLastWin32Error(), "process-wait");
    }
  }
  static string Canonical(string path) {
    IntPtr file = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    if (file == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "path-identity");
    try {
      StringBuilder result = new StringBuilder(32768);
      uint size = GetFinalPathNameByHandle(file, result, (uint)result.Capacity, 0);
      if (size == 0 || size >= result.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error(), "path-identity");
      string value = result.ToString();
      if (value.StartsWith(@"\\?\UNC\")) value = @"\\" + value.Substring(8);
      else if (value.StartsWith(@"\\?\")) value = value.Substring(4);
      return value.TrimEnd('\\', '/');
    } finally { CloseHandle(file); }
  }
  static bool Belongs(string image, string root) {
    return image.Equals(root, StringComparison.OrdinalIgnoreCase) || image.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase);
  }
  static List<Owned> Processes(string root, bool close, HashSet<uint> excluded) {
    var result = new List<Owned>();
    try {
      foreach (Process candidate in Process.GetProcesses()) {
        uint pid;
        using (candidate) { pid = (uint)candidate.Id; }
        if (pid == 0 || excluded.Contains(pid)) continue;
        // Read first without terminate rights. Protected unrelated processes cannot authorize a
        // close, and Restart Manager separately accounts for actual installation file users.
        IntPtr handle = OpenProcess(0x1000 | 0x100000, false, pid);
        if (handle == IntPtr.Zero) continue;
        var owner = new Owned { Pid = pid, Handle = handle };
        try {
          StringBuilder image = new StringBuilder(32768); uint size = (uint)image.Capacity;
          if (!QueryFullProcessImageName(handle, 0, image, ref size)) {
            int code = Marshal.GetLastWin32Error();
            if (!owner.Alive()) continue;
            // Some process images have no Win32 path mapping (ERROR_GEN_FAILURE). Query the
            // same retained object in the native namespace; never compare an NT path to a DOS
            // root directly or treat this error as proof that the process is unrelated.
            if (code == 31) {
              image.Clear(); size = (uint)image.Capacity;
              if (!QueryFullProcessImageName(handle, 1, image, ref size)) {
                int nativeCode = Marshal.GetLastWin32Error();
                if (!owner.Alive()) continue;
                throw new Win32Exception(nativeCode, "process-image-native");
              }
              // Windows can return a non-file label such as Registry. That is not an
              // executable path and cannot grant close authority. It also does not prove
              // absence of file use: the independent mandatory Restart Manager scan still
              // reports this object if it holds installation resources. Do not generalize
              // this to failed queries, empty values, or unresolved path-shaped results.
              string nativeImage = image.ToString();
              if (!string.IsNullOrWhiteSpace(nativeImage) &&
                  nativeImage.IndexOfAny(new char[] { '\\', '/', ':' }) < 0 &&
                  !nativeImage.Any(char.IsControl)) continue;
              if (!image.ToString().StartsWith("\\Device\\", StringComparison.OrdinalIgnoreCase))
                throw new IOException("process-image-native-path");
              // Native names can still contain 8.3 aliases. Normalize the image before any
              // outside-installation decision; unknown file identity must remain blocking.
              string normalized;
              try { normalized = Canonical("\\\\?\\GLOBALROOT" + image.ToString()); }
              catch { if (!owner.Alive()) continue; throw; }
              image.Clear(); image.Append(normalized);
            } else {
              // Protected system processes may grant SYNCHRONIZE but deny image queries. As with
              // OpenProcess denial, the mandatory Restart Manager resource scan still preserves
              // any actual installation file users; this optional executable supplement cannot
              // turn an unrelated protected process into a permanent installation-wide failure.
              if (code == 5 || code == 87 || code == 1168) continue;
              throw new Win32Exception(code, "process-image");
            }
          }
          if (!Belongs(image.ToString(), root)) continue;
          owner.Image = Canonical(image.ToString());
          if (!Belongs(owner.Image, root)) continue;
          if (close) {
            // Keep the original handle alive while opening the terminate-capable handle. Windows
            // cannot recycle this process object/PID until both references have been released.
            IntPtr writable = OpenProcess(0x1000 | 0x100000 | 1, false, pid);
            if (writable == IntPtr.Zero) {
              if (!owner.Alive()) continue;
              throw new Win32Exception(Marshal.GetLastWin32Error(), "process-terminate-access");
            }
            CloseHandle(owner.Handle); owner.Handle = writable;
          }
          result.Add(owner); owner = null;
        } finally { if (owner != null) owner.Dispose(); }
      }
      return result;
    } catch { foreach (Owned owner in result) owner.Dispose(); throw; }
  }
  static IEnumerable<string> Files(string root) {
    if (File.Exists(root)) { yield return root; yield break; }
    foreach (string file in Directory.EnumerateFiles(root)) {
      if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException("resource-reparse-point");
      yield return file;
    }
    foreach (string directory in Directory.EnumerateDirectories(root)) {
      if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new IOException("resource-reparse-point");
      foreach (string file in Files(directory)) yield return file;
    }
  }
  static void Check(uint code, string stage) { if (code != 0) throw new Win32Exception((int)code, stage); }
  static uint[] Resources(string root) {
    uint session; Check(RmStartSession(out session, 0, new StringBuilder(33)), "resource-start");
    try {
      var batch = new List<string>();
      foreach (string file in Files(root)) {
        batch.Add(file);
        if (batch.Count == 256) { Check(RmRegisterResources(session, (uint)batch.Count, batch.ToArray(), 0, IntPtr.Zero, 0, IntPtr.Zero), "resource-register"); batch.Clear(); }
      }
      if (batch.Count > 0) Check(RmRegisterResources(session, (uint)batch.Count, batch.ToArray(), 0, IntPtr.Zero, 0, IntPtr.Zero), "resource-register");
      uint count = 0, needed, reasons;
      for (int attempt = 0; attempt < 3; attempt++) {
        ProcessInfo[] rows = count == 0 ? null : new ProcessInfo[count];
        uint code = RmGetList(session, out needed, ref count, rows, out reasons);
        if (code == 234) { count = needed; continue; }
        Check(code, "resource-list");
        return rows == null ? new uint[0] : rows.Take((int)count).Select(row => row.Process.Pid).Distinct().ToArray();
      }
      throw new IOException("resource-list-changing");
    } finally { Check(RmEndSession(session), "resource-end"); }
  }
  static string Quote(string value) { return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }
  static int Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    try {
      if (args.Length < 2) throw new ArgumentException("arguments");
      if (args[0] == "recovery-request") {
        if (args.Length != 3 || new FileInfo(args[1]).Length > 1048576) throw new ArgumentException("recovery-request");
        Func<string, string> ini = key => { var value = new StringBuilder(32768); if (GetPrivateProfileString("update", key, "", value, (uint)value.Capacity, args[2]) >= value.Capacity - 1) throw new IOException("recovery-value"); return value.ToString(); };
        byte[] bytes = File.ReadAllBytes(args[1]);
        using (var hash = SHA256.Create()) if (!BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").Equals(ini("requestSha256"), StringComparison.OrdinalIgnoreCase)) throw new IOException("recovery-binding");
        var request = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(bytes));
        foreach (string key in new [] { "operationId", "applicationPath", "installerPath", "installerUrl", "installerSha256" }) {
          object value;
          if (!request.TryGetValue(key, out value) || !(value is string) || (string)value != ini(key)) throw new IOException("recovery-binding");
        }
        Uri url;
        if (!Uri.TryCreate(ini("installerUrl"), UriKind.Absolute, out url) || (url.Scheme != "http" && url.Scheme != "https") || url.UserInfo.Length != 0 || !System.Text.RegularExpressions.Regex.IsMatch(ini("installerSha256"), "^[a-fA-F0-9]{64}$")) throw new IOException("recovery-download");
        return 0;
      }
      if (args[0] == "successor-active" || args[0] == "successor-ready") {
        if (args.Length != 3) throw new ArgumentException("arguments");
        string operation = Path.GetFileName(args[1].TrimEnd('\\', '/'));
        Guid id;
        if (!Guid.TryParseExact(operation, "D", out id)) throw new ArgumentException("successor-operation");
        string receipt = Path.Combine(args[1], "installed.receipt");
        if (!File.Exists(receipt)) { Console.Write("{\"active\":false}"); return 0; }
        if (new FileInfo(receipt).Length > 256 || File.ReadAllText(receipt) != operation + "\r\ninstalled\r\n") throw new IOException("successor-receipt");
        if (!File.Exists(args[2])) { Console.Write("{\"active\":false}"); return 0; }
        if (args[0] == "successor-ready") {
          string ready = Path.Combine(args[1], "ready.receipt");
          bool complete = File.Exists(ready) && new FileInfo(ready).Length <= 256 && File.ReadAllText(ready) == operation + "\r\nready\r\n";
          Console.Write(complete ? "{\"active\":true}" : "{\"active\":false}"); return 0;
        }
        string application = Canonical(args[2]);
        List<Owned> processes = Processes(Canonical(Path.GetDirectoryName(application)), false, new HashSet<uint>());
        try { Console.Write(processes.Any(p => p.Image.Equals(application, StringComparison.OrdinalIgnoreCase) && p.Alive()) ? "{\"active\":true}" : "{\"active\":false}"); }
        finally { foreach (Owned process in processes) process.Dispose(); }
        return 0;
      }
      if (args[0] == "recovery-directory" || args[0] == "recovery-location") {
        if (args.Length != 3) throw new ArgumentException("arguments");
        string installation = Canonical(args[1]), appData = Canonical(args[2]);
        string key;
        // Canonical supplies filesystem casing; match Node's ASCII-only fold, not runtime-specific Unicode casing.
        string identity = new string(installation.Select(c => c >= 'A' && c <= 'Z' ? (char)(c + 32) : c).ToArray());
        using (var hash = SHA256.Create()) key = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(identity))).Replace("-", "").ToLowerInvariant();
        int rootIndex = 0;
        foreach (string parent in new [] { Path.Combine(appData, "Open-Science", "UpdateHandoffs"), Path.Combine(appData, "Open-Science-UpdateHandoffs") }) {
          // Existing parents may be junctions. An unavailable/moved parent is never silently
          // treated as external; canonicalize every existing path prefix before selecting it.
          string ancestor = parent, suffix = "";
          while (!Directory.Exists(ancestor)) { suffix = Path.Combine(Path.GetFileName(ancestor), suffix); ancestor = Path.GetDirectoryName(ancestor); if (ancestor == null) throw new IOException("recovery-root"); }
          string resolved = Path.Combine(Canonical(ancestor), suffix).TrimEnd('\\');
          if (Belongs(resolved, installation)) { rootIndex++; continue; }
          Console.Write(args[0] == "recovery-location" ? rootIndex + "|" + key : Path.Combine(parent, "Installations", key)); return 0;
        }
        throw new IOException("recovery-root-inside-installation");
      }
      if (args[0] == "writer-active") {
        Guid identity;
        if (args.Length != 2 || !Guid.TryParse(args[1], out identity)) throw new ArgumentException("writer-identity");
        IntPtr writer = OpenMutex(0x100001, false, args[1]);
        if (writer == IntPtr.Zero) {
          int code = Marshal.GetLastWin32Error();
          if (code != 2) throw new Win32Exception(code, "writer-open");
          Console.WriteLine("{\"active\":false}"); return 0;
        }
        try {
          uint state = WaitForSingleObject(writer, 0);
          if (state == 258) { Console.WriteLine("{\"active\":true}"); return 0; }
          if (state != 0 && state != 128) throw new Win32Exception(Marshal.GetLastWin32Error(), "writer-wait");
          if (!ReleaseMutex(writer)) throw new Win32Exception(Marshal.GetLastWin32Error(), "writer-release");
          Console.WriteLine("{\"active\":false}"); return 0;
        } finally { CloseHandle(writer); }
      }
      string root = Canonical(args[1]);
      if (args[0] == "query" || args[0] == "check") {
        uint self = (uint)Process.GetCurrentProcess().Id;
        uint[] resources = Resources(root).Where(pid => pid != self).ToArray();
        List<Owned> processes = Processes(root, false, new HashSet<uint> { self });
        try {
          if (args[0] == "check") {
            Console.WriteLine("occupants=" + resources.Union(processes.Select(p => p.Pid)).Count());
            return resources.Length == 0 && processes.Count == 0 ? 0 : 3;
          }
          Console.WriteLine("{\"resourcePids\":[" + string.Join(",", resources) + "],\"processes\":[" + string.Join(",", processes.Select(p => "{\"ProcessId\":" + p.Pid + ",\"ExecutablePath\":" + Quote(p.Image) + "}")) + "]}");
        }
        finally { foreach (Owned owner in processes) owner.Dispose(); }
        return 0;
      }
      if (args[0] != "close" || (args.Length != 4 && args.Length != 5)) throw new ArgumentException("arguments");
      uint budget = uint.Parse(args[3]); if (budget > 30000) throw new ArgumentException("close-budget");
      long remaining = args.Length == 5 ? long.Parse(args[4]) - (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds : budget + 1000;
      if (remaining <= 0) throw new IOException("close-deadline");
      var excluded = new HashSet<uint>(args[2].Split(',').Where(v => v.Length > 0).Select(uint.Parse));
      excluded.Add((uint)Process.GetCurrentProcess().Id);
      var graceful = new List<uint>(); var forced = new List<uint>();
      var clock = Stopwatch.StartNew();
      long gracefulUntil = Math.Min(budget, Math.Max(0, remaining - 1000));
      List<Owned> owners = Processes(root, true, excluded);
      try {
        var byPid = owners.ToDictionary(p => p.Pid);
        EnumWindows(delegate(IntPtr window, IntPtr unused) {
          uint pid; GetWindowThreadProcessId(window, out pid);
          Owned owner;
          if (clock.ElapsedMilliseconds >= gracefulUntil) return false;
          if (byPid.TryGetValue(pid, out owner) && owner.Alive()) PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
          return true;
        }, IntPtr.Zero);
        while (clock.ElapsedMilliseconds < gracefulUntil && owners.Any(p => p.Alive())) Thread.Sleep((int)Math.Max(0, Math.Min(20, gracefulUntil - clock.ElapsedMilliseconds)));
        foreach (Owned owner in owners) {
          if (!owner.Alive()) { graceful.Add(owner.Pid); continue; }
          if (clock.ElapsedMilliseconds >= remaining) throw new IOException("close-deadline");
          if (!TerminateProcess(owner.Handle, 1) && owner.Alive()) throw new Win32Exception(Marshal.GetLastWin32Error(), "process-terminate");
          forced.Add(owner.Pid);
        }
        while (clock.ElapsedMilliseconds < remaining && owners.Any(p => p.Alive())) Thread.Sleep((int)Math.Max(0, Math.Min(20, remaining - clock.ElapsedMilliseconds)));
        if (owners.Any(p => p.Alive())) throw new IOException("process-stop-unsettled");
        Console.WriteLine("{\"graceful\":[" + string.Join(",", graceful) + "],\"forced\":[" + string.Join(",", forced) + "]}");
      } finally { foreach (Owned owner in owners) owner.Dispose(); }
      return 0;
    } catch (Exception error) {
      // Stage and OS code are useful diagnostics; no command lines, environment or user paths.
      var system = error as Win32Exception;
      string stage = error.Message;
      if (!System.Text.RegularExpressions.Regex.IsMatch(stage, "^[a-z-]+$")) stage = "inspection";
      Console.Error.WriteLine("stage=" + stage + ";type=" + error.GetType().Name + ";code=" + (system == null ? error.HResult : system.NativeErrorCode));
      return 2;
    }
  }
}
