using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.IO;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
public sealed class ObservedProcess : IDisposable {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public IntPtr Handle { get; private set; }
  public DateTime StartTime { get; private set; }
  public static ObservedProcess GetProcessById(int pid) {
    // Identity, process times and wait status require only limited query + synchronize.
    // Process.Handle on .NET Framework requests broader access denied by sandboxed children.
    var handle = OpenProcess(0x1000 | 0x100000, false, pid);
    if(handle==IntPtr.Zero) {
      int code=Marshal.GetLastWin32Error();
      if(code==87) throw new ArgumentException("Recorded process no longer exists: " + pid);
      throw new System.ComponentModel.Win32Exception(code,"Cannot open read-only process identity: " + pid);
    }
    long created,exited,kernel,user;
    if(!GetProcessTimes(handle,out created,out exited,out kernel,out user)) {
      int code=Marshal.GetLastWin32Error(); CloseHandle(handle); throw new System.ComponentModel.Win32Exception(code);
    }
    return new ObservedProcess { Handle=handle,StartTime=DateTime.FromFileTimeUtc(created) };
  }
  public bool HasExited {
    get {
      uint status=WaitForSingleObject(Handle,0);
      if(status==0) return true;
      if(status==258) return false;
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
  }
  public void WaitForExit() {
    uint status=WaitForSingleObject(Handle,10000);
    if(status==258) throw new TimeoutException("Observed fixture did not exit within ten seconds");
    if(status!=0) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  }
  public void Dispose() { if(Handle!=IntPtr.Zero) { CloseHandle(Handle); Handle=IntPtr.Zero; } }
}
public class HandoffIdentity {
  public int pid, parent;
  public int imageError;
  public int imageQueryFailures, lastImageError;
  public string path, started, role;
  public ObservedProcess process;
}
public class HandoffWindow { public int pid; public string title, handle, role; }
public class HandoffSample {
  public string at = DateTime.UtcNow.ToString("o");
  public bool oldExited;
  public int successorPid;
  public List<HandoffWindow> windows = new List<HandoffWindow>();
  public List<object> identities = new List<object>();
  public int unresolvedImages;
}
public class HandoffObserver : IDisposable {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Entry {
    public uint size, usage, pid; public IntPtr heap; public uint module, threads, parent; public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string name;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr handle, int flags, StringBuilder name, ref int length);
  delegate bool EnumWindow(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll", SetLastError=true)] static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out int pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr window, StringBuilder text, int length);
  readonly Dictionary<int,HandoffIdentity> known = new Dictionary<int,HandoffIdentity>();
  readonly int root;
  readonly string app, installer, helperDigest, operationRoot;
  readonly DateTime boundary;
  int installerPid;
  public HandoffObserver(int pid, string started, string application, string installerPath, string helper, string parentExecutable, string handoffAppData) {
    // .NET Framework treats drive-relative C:dir and root-relative \dir as rooted.
    if(String.IsNullOrWhiteSpace(handoffAppData) || Path.GetPathRoot(handoffAppData).Length < 3) throw new ArgumentException("An absolute handoff app-data directory is required", "handoffAppData");
    operationRoot = Path.Combine(Path.GetFullPath(handoffAppData),"Open-Science","UpdateHandoffs");
    root = pid; app = Path.GetFullPath(application); installer = Path.GetFullPath(installerPath);
    // Native-only upgrades have no helper resource. Explicit legacy resources remain mandatory to read and verify.
    helperDigest = String.IsNullOrWhiteSpace(helper) ? null : Digest(helper);
    var original = Capture(pid, 0);
    if (original.started != started || !Same(original.path, parentExecutable)) { original.process.Dispose(); throw new Exception("Old application identity mismatch"); }
    boundary = original.process.StartTime.ToUniversalTime();
    original.role = "old"; known.Add(pid, original);
  }
  static bool Same(string a, string b) { return String.Equals(a,b,StringComparison.OrdinalIgnoreCase); }
  static DateTime? ReadExitTime(ObservedProcess process) {
    long created, exited, kernel, user;
    // Read the retained handle afresh so a previously live observation cannot cache zero.
    if(!GetProcessTimes(process.Handle,out created,out exited,out kernel,out user)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    return exited==0 ? (DateTime?)null : DateTime.FromFileTimeUtc(exited);
  }
  static string Digest(string path) { using(var hash=SHA256.Create()) using(var file=File.OpenRead(path)) return BitConverter.ToString(hash.ComputeHash(file)); }
  public static bool MatchesOperation(string json, string helperPath, string operationRoot, int parentPid, int helperPid, string application, string installerPath) {
    var request = new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(json);
    Guid id;
    object operation, parent, helper, requestedApp, requestedInstaller, schema;
    if(!request.TryGetValue("schema",out schema) || Convert.ToInt32(schema)!=1 ||
       !request.TryGetValue("operationId",out operation) || !Guid.TryParseExact(operation as string,"D",out id) ||
       !request.TryGetValue("parentPid",out parent) || Convert.ToInt32(parent)!=parentPid ||
       !request.TryGetValue("helperPid",out helper) || Convert.ToInt32(helper)!=helperPid ||
       !request.TryGetValue("applicationPath",out requestedApp) || !Same(requestedApp as string,application) ||
       !request.TryGetValue("installerPath",out requestedInstaller) || !Same(requestedInstaller as string,installerPath)) return false;
    return Same(Path.GetFullPath(helperPath),Path.Combine(operationRoot,operation as string,"helper.exe"));
  }
  bool IsOperationHelper(HandoffIdentity child) {
    if(helperDigest==null || child.parent!=root || !Same(Path.GetFileName(child.path),"helper.exe")) return false;
    string directory=Path.GetDirectoryName(child.path);
    if(!Same(Path.GetDirectoryName(directory),operationRoot)) return false;
    string requestPath=Path.Combine(directory,"request.json");
    if(!File.Exists(requestPath)) return false;
    if(!MatchesOperation(File.ReadAllText(requestPath),child.path,operationRoot,root,child.pid,app,installer)) return false;
    if(Digest(child.path)!=helperDigest) throw new Exception("Progress executable hash differs from packaged resource");
    return true;
  }
  static HandoffIdentity Capture(int pid, int parent) {
    var identity = CaptureDescendant(pid,parent);
    if(identity==null) return null;
    try { RequireResolvedImage(identity); return identity; }
    catch { identity.process.Dispose(); throw; }
  }
  static HandoffIdentity CaptureDescendant(int pid, int parent) {
    var process = ObservedProcess.GetProcessById(pid);
    var identity = new HandoffIdentity { pid=pid, parent=parent, process=process, started=process.StartTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.ffffff'Z'"), role="descendant" };
    try { RefreshImage(identity); return identity; }
    catch { process.Dispose(); throw; }
  }
  public static void RequireResolvedImage(HandoffIdentity identity) {
    if(identity.imageError!=0 && !identity.process.HasExited)
      throw new System.ComponentModel.Win32Exception(identity.imageError,"Cannot query retained process image: pid="+identity.pid+", parent="+identity.parent+", started="+identity.started+", exited=False");
  }
  public static void RefreshImage(HandoffIdentity identity) {
    var process=identity.process;
    if(identity.path!=null || process.HasExited) return;
    try {
      var buffer = new StringBuilder(32768); int size = buffer.Capacity;
      if (!QueryFullProcessImageNameW(process.Handle, 0, buffer, ref size)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      identity.path=buffer.ToString();
      identity.imageError=0;
    } catch(System.ComponentModel.Win32Exception error) {
      if(error.NativeErrorCode!=31 && error.NativeErrorCode!=87 && error.NativeErrorCode!=5) throw;
      // Preserve this exact handle and the error. The next normal sample may
      // resolve the image or prove exit; an unresolved live identity blocks PASS.
      // No blocking wait, PID reopen, path guess, or visible-window claim.
      identity.imageError=error.NativeErrorCode;
      identity.lastImageError=error.NativeErrorCode;
      identity.imageQueryFailures++;
    }
  }
  bool DescendsFrom(int pid, int ancestor) {
    var visited = new HashSet<int>();
    while (known.ContainsKey(pid) && visited.Add(pid)) { if(pid==ancestor) return true; pid=known[pid].parent; }
    return false;
  }
  public HandoffSample Sample() {
    var sample = new HandoffSample();
    var snapshot = CreateToolhelp32Snapshot(2,0);
    if (snapshot == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    var entries = new List<Entry>();
    try {
      var entry = new Entry(); entry.size=(uint)Marshal.SizeOf(entry);
      if(!Process32FirstW(snapshot,ref entry)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      do { entries.Add(entry); } while(Process32NextW(snapshot,ref entry));
      if(Marshal.GetLastWin32Error()!=18) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { CloseHandle(snapshot); }
    bool added;
    do {
      added=false;
      foreach(var row in entries) {
        int pid=(int)row.pid, parent=(int)row.parent;
        if(known.ContainsKey(pid) || !known.ContainsKey(parent)) continue;
        HandoffIdentity child;
        // A process absent by the time its identity is opened is not a visible-window claim.
        // Handle-open failures remain fatal. Image-query races retain the handle.
        try { child=CaptureDescendant(pid,parent); } catch(ArgumentException) { continue; }
        if(child==null) continue;
        var owner=known[parent].process;
        var created=child.process.StartTime.ToUniversalTime();
        var ownerExit=ReadExitTime(owner);
        if(created<boundary || created<owner.StartTime.ToUniversalTime() || (ownerExit.HasValue && created>ownerExit.Value)) { child.process.Dispose(); continue; }
        known.Add(pid,child); added=true;
      }
    } while(added);
    sample.oldExited=known[root].process.HasExited;
    foreach(var identity in known.Values) {
      RefreshImage(identity);
      if(identity.imageError!=0 && !identity.process.HasExited) sample.unresolvedImages++;
      if(Same(identity.path,installer)) {
        if(installerPid!=0 && installerPid!=identity.pid) throw new Exception("Ambiguous installer identity");
        installerPid=identity.pid; identity.role="installer";
      }
    }
    foreach(var identity in known.Values) {
      // The product publishes helperPid after its visible-window acknowledgement.
      // Revisit retained descendants until that exact operation identity is available.
      if(identity.role=="descendant" && IsOperationHelper(identity)) identity.role="progress";
      if(installerPid!=0 && DescendsFrom(identity.pid,installerPid) && identity.pid!=installerPid) identity.role=Same(identity.path,app) ? "successor" : "installer-child";
      var exitedAt=ReadExitTime(identity.process);
      sample.identities.Add(new { identity.pid, identity.parent, identity.path, identity.started, identity.role, identity.imageError, identity.imageQueryFailures, identity.lastImageError, exited=identity.process.HasExited, exitedAt=exitedAt.HasValue ? exitedAt.Value.ToString("o") : null });
    }
    EnumWindow enumerate = delegate(IntPtr window, IntPtr unused) {
      int pid; GetWindowThreadProcessId(window,out pid);
      if(!known.ContainsKey(pid) || !IsWindowVisible(window) || IsIconic(window)) return true;
      var identity=known[pid];
      if(identity.path==null || identity.role=="descendant" || identity.process.HasExited) return true;
      var title=new StringBuilder(2048); GetWindowTextW(window,title,title.Capacity);
      sample.windows.Add(new HandoffWindow { pid=pid, title=title.ToString(), handle=window.ToString(), role=identity.role });
      if(sample.oldExited && identity.role=="successor") sample.successorPid=pid;
      return true;
    };
    if(!EnumWindows(enumerate,IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    GC.KeepAlive(enumerate);
    return sample;
  }
  public void RequireResolvedImages() { foreach(var identity in known.Values) RequireResolvedImage(identity); }
  public void Dispose() { foreach(var identity in known.Values) identity.process.Dispose(); }
}
