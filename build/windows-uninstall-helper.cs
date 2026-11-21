using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

// Native replacement for the uninstall PowerShell scripts. Launching powershell.exe from NSIS
// costs 0.6-1.2 s per script; this .NET Framework helper starts in about 0.1 s. Each subcommand
// keeps the exit codes and messages of the script it replaced, so the NSIS flow is unchanged.
// Built with the system csc.exe (C# 5) together with windows-install-publication.cs.
public static class UninstallHelper {
  sealed class ExitException : Exception {
    public readonly int Code;
    public ExitException(int code) { Code = code; }
  }

  static void Exit(int code) { throw new ExitException(code); }

  public static int Main(string[] args) {
    try {
      if (args.Length == 0) throw new ArgumentException("Missing subcommand.");
      var options = ParseOptions(args);
      switch (args[0]) {
        case "update-handoff": UpdateHandoff(Required(options, "install-path")); break;
        case "notebook-sandbox": NotebookSandbox(Required(options, "sandbox-root")); break;
        case "runtime-cache": RuntimeCache(); break;
        case "prepared-updates":
          // Published payloads can contain node_modules paths beyond the Framework legacy limit.
          AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
          AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
          RemovePreparedUpdates(Required(options, "cache"), Required(options, "executable"));
          break;
        case "program-data-paths":
          ProgramDataPaths(
            Required(options, "install-path"),
            Required(options, "output"),
            int.Parse(Required(options, "max-line-length")));
          break;
        case "program-cleanup":
          ProgramCleanup(
            Required(options, "staging-path"),
            options.ContainsKey("report") ? options["report"] : null,
            options.ContainsKey("upgrade"));
          break;
        case "diagnostics": InstallDiagnostics.Run(options); break;
#if OPEN_SCIENCE_HELPER_TEST_SEAMS
        // Test builds only: expose the ownership verdicts for parity with the reset script.
        case "test-inspect-cache": InspectCache(options); break;
#endif
        default: throw new ArgumentException("Unknown subcommand: " + args[0]);
      }
      return 0;
    } catch (ExitException exit) {
      return exit.Code;
    } catch (Exception error) {
      Console.Error.WriteLine(error.ToString());
      return 1;
    }
  }

  static Dictionary<string, string> ParseOptions(string[] args) {
    var options = new Dictionary<string, string>(StringComparer.Ordinal);
    for (var index = 1; index < args.Length; index++) {
      if (!args[index].StartsWith("--", StringComparison.Ordinal))
        throw new ArgumentException("Unexpected argument: " + args[index]);
      var name = args[index].Substring(2);
      if (name == "upgrade" || name == "write-message-next-to-report") { options[name] = ""; continue; }
      if (index + 1 >= args.Length) throw new ArgumentException("Missing value for --" + name);
      options[name] = args[++index];
    }
    return options;
  }

  static string Required(Dictionary<string, string> options, string name) {
    string value;
    if (!options.TryGetValue(name, out value)) throw new ArgumentException("Missing --" + name);
    return value;
  }

  static string Variable(string name) {
    return Environment.GetEnvironmentVariable(name) ?? "";
  }

  static string ApplicationData() {
#if OPEN_SCIENCE_HELPER_TEST_SEAMS
    // Test builds only: redirect the fixed managed root. Shipped helpers have no seam.
    var redirected = Variable("OPEN_SCIENCE_HELPER_TEST_APPDATA");
    if (redirected.Length > 0) return redirected;
#endif
    return Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
  }

  // ---- Process inventory -------------------------------------------------------------------

  internal sealed class ProcessRecord {
    public uint ProcessId;
    public uint ParentProcessId;
    // Null when the process identity cannot be inspected, like Win32_Process.ExecutablePath.
    public string ExecutablePath;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct ProcessEntry {
    public uint Size, Usage, ProcessId;
    public IntPtr DefaultHeapId;
    public uint ModuleId, Threads, ParentProcessId;
    public int PriorityClassBase;
    public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ExeFile;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref int size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  internal static List<ProcessRecord> Processes() {
#if OPEN_SCIENCE_HELPER_TEST_SEAMS
    var injected = Variable("OPEN_SCIENCE_HELPER_TEST_PROCESSES");
    if (injected == "throw") throw new InvalidOperationException("Injected process inventory failure");
    if (injected.Length > 0) {
      var records = new List<ProcessRecord>();
      foreach (var item in (object[])new JavaScriptSerializer().DeserializeObject(File.ReadAllText(injected))) {
        var values = (Dictionary<string, object>)item;
        var pid = values["ProcessId"];
        records.Add(new ProcessRecord {
          ProcessId = pid is string && (string)pid == "self" ? (uint)Process.GetCurrentProcess().Id : Convert.ToUInt32(pid),
          ParentProcessId = Convert.ToUInt32(values["ParentProcessId"]),
          ExecutablePath = values["ExecutablePath"] as string
        });
      }
      return records;
    }
#endif
    var snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      var result = new List<ProcessRecord>();
      var entry = new ProcessEntry();
      entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
      var more = Process32FirstW(snapshot, ref entry);
      while (more) {
        result.Add(new ProcessRecord {
          ProcessId = entry.ProcessId,
          ParentProcessId = entry.ParentProcessId,
          ExecutablePath = ImagePath(entry.ProcessId)
        });
        more = Process32NextW(snapshot, ref entry);
      }
      var error = Marshal.GetLastWin32Error();
      // ERROR_NO_MORE_FILES ends a complete walk; anything else leaves the inventory unproven.
      if (error != 18) throw new Win32Exception(error);
      return result;
    } finally { CloseHandle(snapshot); }
  }

  static string ImagePath(uint processId) {
    var process = OpenProcess(0x1000, false, processId);
    if (process == IntPtr.Zero) return null;
    try {
      var name = new StringBuilder(32768);
      var size = name.Capacity;
      return QueryFullProcessImageNameW(process, 0, name, ref size) ? name.ToString() : null;
    } finally { CloseHandle(process); }
  }

  // Terminates every process whose full image path is inside root (trailing-backslash boundary),
  // like Get-CimInstance | Stop-Process -Force -ErrorAction SilentlyContinue. Best effort.
  static void StopProcessesUnder(string root) {
    var prefix = Path.GetFullPath(root).TrimEnd('\\') + "\\";
    List<ProcessRecord> processes;
    try { processes = Processes(); } catch { return; }
    var self = (uint)Process.GetCurrentProcess().Id;
    foreach (var record in processes) {
      if (record.ProcessId == self || record.ExecutablePath == null ||
          !record.ExecutablePath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
      var process = OpenProcess(0x0001, false, record.ProcessId);
      if (process == IntPtr.Zero) continue;
      try { TerminateProcess(process, 1); } finally { CloseHandle(process); }
    }
  }

  // ---- PowerShell-compatible JSON comparisons ----------------------------------------------
  // The scripts parsed JSON with ConvertFrom-Json (JavaScriptSerializer underneath) and compared
  // with PowerShell's loose operators. These keep the same verdicts for the values they accept.

  // Match SETTINGS_RESOURCE_LIMITS.documentBytes in the application settings store.
  const int SettingsDocumentBytes = 128 * 1024 * 1024;

  static Dictionary<string, object> ReadJsonObject(string path, int? maxBytes = null) {
    var serializer = new JavaScriptSerializer();
    string contents;
    using (var stream = File.OpenRead(path)) {
      if (maxBytes.HasValue) {
        if (stream.Length > maxBytes.Value)
          throw new InvalidDataException("Settings document exceeds the " + maxBytes.Value + " byte limit.");
        // A UTF-8 document has at most one UTF-16 code unit per byte.
        serializer.MaxJsonLength = maxBytes.Value;
      }
      using (var reader = new StreamReader(stream)) contents = reader.ReadToEnd();
    }
    var value = serializer.DeserializeObject(contents);
    var result = value as Dictionary<string, object>;
    if (result == null) throw new InvalidDataException("Expected a JSON object: " + path);
    return result;
  }

  static object Field(Dictionary<string, object> values, string name) {
    object value;
    return values.TryGetValue(name, out value) ? value : null;
  }

  // [string]$value: $null becomes "", other scalars use invariant formatting.
  static string AsString(object value) {
    if (value == null) return "";
    if (value is bool) return (bool)value ? "True" : "False";
    return Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture);
  }

  // $value -eq <number>: numbers compare numerically; a string left operand compares as text.
  static bool NumberEquals(object value, long expected) {
    if (value is string) return (string)value == expected.ToString(System.Globalization.CultureInfo.InvariantCulture);
    decimal number;
    return TryNumber(value, out number) && number == expected;
  }

  static bool TryNumber(object value, out decimal number) {
    number = 0;
    if (value == null || value is bool) return false;
    if (value is string)
      return decimal.TryParse((string)value, System.Globalization.NumberStyles.Float,
        System.Globalization.CultureInfo.InvariantCulture, out number);
    try { number = Convert.ToDecimal(value); return true; } catch { return false; }
  }

  // $value -eq "text" (case-insensitive); $null never equals a string.
  static bool TextEquals(object value, string expected) {
    return value != null && string.Equals(AsString(value), expected, StringComparison.OrdinalIgnoreCase);
  }

  // ---- Cache and record ownership ----------------------------------------------------------
  // Same policy as micromamba-cache.ts and scripts/windows-reset/reset-open-science.ps1; the
  // parity test in scripts/windows-data-reset.test.ts runs both against the same fixtures.

  static bool PathExists(string path) {
    return File.Exists(path) || Directory.Exists(path);
  }

  static bool IsReparsePoint(string path) {
    return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
  }

  // Throws when a segment is missing, like Get-Item; callers treat that as untrusted.
  internal static bool NoReparsePointInPath(string path) {
    var full = Path.GetFullPath(path);
    var root = Path.GetPathRoot(full);
    if (string.IsNullOrWhiteSpace(root)) return false;
    var current = root;
    foreach (var segment in full.Substring(root.Length).Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries)) {
      current = Path.Combine(current, segment);
      if (IsReparsePoint(current)) return false;
    }
    return true;
  }

  static byte[] CacheDigest(string runtimeRoot, string userIdentity) {
    var key = userIdentity.ToLowerInvariant() + '\0' + runtimeRoot.ToLowerInvariant();
    using (var sha = SHA256.Create()) return sha.ComputeHash(Encoding.UTF8.GetBytes(key));
  }

  internal static string CacheLeaf(string runtimeRoot, string userIdentity) {
    var digest = CacheDigest(runtimeRoot, userIdentity);
    var hex = new StringBuilder();
    foreach (var value in digest) hex.Append(value.ToString("x2"));
    return "osp" + hex.ToString().Substring(0, 10);
  }

  static string Base32Prefix(byte[] digest) {
    const string alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
    var encoded = new StringBuilder();
    long value = 0;
    var bits = 0;
    for (var index = 0; index < 5; index++) {
      value = (value << 8) | digest[index];
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        encoded.Append(alphabet[(int)((value >> bits) & 31)]);
        value &= (1L << bits) - 1;
      }
    }
    return encoded.ToString();
  }

  internal static string CompactCacheLeaf(string runtimeRoot, string userIdentity) {
    return "os" + Base32Prefix(CacheDigest(runtimeRoot, userIdentity));
  }

  internal static string WorkingCacheLeaf(string runtimeRoot, string userIdentity) {
    return "m-" + Base32Prefix(CacheDigest(runtimeRoot, userIdentity));
  }

  static FileSystemSecurity Security(string path) {
    return Directory.Exists(path)
      ? (FileSystemSecurity)Directory.GetAccessControl(path)
      : File.GetAccessControl(path);
  }

  internal static bool TrustedAcl(string path) {
    var acl = Security(path);
    var user = WindowsIdentity.GetCurrent().User.Value;
    var trustedOwners = new[] { user, "S-1-5-18", "S-1-5-32-544" };
    var owner = acl.GetOwner(typeof(SecurityIdentifier));
    if (owner == null || !trustedOwners.Contains(owner.Value)) return false;
    var trustedWriters = trustedOwners.Concat(new[] { "S-1-3-0" }).ToArray();
    // Match the dangerous-rights policy in micromamba-cache.ts using only mutating bits.
    // Modify/FullControl also contain read bits: testing overlap with them rejects harmless readers.
    const FileSystemRights writeMask = FileSystemRights.Write | FileSystemRights.Delete |
      FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions |
      FileSystemRights.TakeOwnership;
    foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
      if (rule.AccessControlType == AccessControlType.Allow &&
          !trustedWriters.Contains(rule.IdentityReference.Value) &&
          (rule.FileSystemRights & writeMask) != 0) return false;
    }
    return true;
  }

  internal static bool TrustedCache(string path, string canonicalRoot, string userIdentity) {
    if (!NoReparsePointInPath(path) || IsReparsePoint(path)) return false;
    var marker = ReadJsonObject(Path.Combine(path, ".open-science-cache.json"));
    if (!NumberEquals(Field(marker, "schema"), 1) ||
        !TextEquals(Field(marker, "canonicalRoot"), canonicalRoot.ToLowerInvariant()) ||
        !TextEquals(Field(marker, "userIdentity"), userIdentity)) return false;
    return TrustedAcl(path);
  }

  internal static bool TrustedManagedParent(string path, string userIdentity) {
    if (!NoReparsePointInPath(path) || IsReparsePoint(path)) return false;
    var marker = ReadJsonObject(Path.Combine(path, ".open-science-temp.json"));
    if (!NumberEquals(Field(marker, "schema"), 1) ||
        !TextEquals(Field(marker, "kind"), "micromamba-working-cache-parent") ||
        !TextEquals(Field(marker, "userIdentity"), userIdentity)) return false;
    return TrustedAcl(path);
  }

  static void RemoveEmptyManagedParent(string path, string userIdentity) {
    if (!TrustedManagedParent(path, userIdentity)) return;
    var markerPath = Path.Combine(path, ".open-science-temp.json");
    var markerContents = File.ReadAllText(markerPath);
    var entries = Directory.GetFileSystemEntries(path);
    if (entries.Length != 1 ||
        !string.Equals(Path.GetFileName(entries[0]), ".open-science-temp.json", StringComparison.OrdinalIgnoreCase)) return;
    File.Delete(markerPath);
    try {
      // Non-recursive removal fails safely if another app process adds a child after the empty check.
      Directory.Delete(path, false);
    } catch {
      try { if (!File.Exists(markerPath)) File.WriteAllText(markerPath, markerContents); } catch { }
      throw;
    }
  }

  // Remove-Item -Recurse -Force without ever following a link: a reparse point is removed itself.
  static void RemoveTree(string path) {
    var attributes = File.GetAttributes(path);
    if ((attributes & FileAttributes.ReparsePoint) != 0) {
      if ((attributes & FileAttributes.Directory) != 0) Directory.Delete(path, false);
      else File.Delete(path);
      return;
    }
    if ((attributes & FileAttributes.ReadOnly) != 0) File.SetAttributes(path, attributes & ~FileAttributes.ReadOnly);
    if ((attributes & FileAttributes.Directory) == 0) { File.Delete(path); return; }
    using (InstallDirectory.HoldForProgramCleanup(path)) {
      foreach (var child in Directory.GetFileSystemEntries(path)) RemoveTree(child);
    }
    Directory.Delete(path, false);
  }

#if OPEN_SCIENCE_HELPER_TEST_SEAMS
  static void InspectCache(Dictionary<string, string> options) {
    var runtimeRoot = Required(options, "runtime-root");
    var identity = Required(options, "identity");
    Func<Func<bool>, object> verdict = check => { try { return check(); } catch { return "error"; } };
    var result = new Dictionary<string, object>();
    result["Parent"] = verdict(() => TrustedManagedParent(Required(options, "parent"), identity));
    result["Cache"] = verdict(() => TrustedCache(Required(options, "cache"), runtimeRoot, identity));
    result["Leaf"] = WorkingCacheLeaf(runtimeRoot, identity);
    result["CacheLeaf"] = CacheLeaf(runtimeRoot, identity);
    result["CompactLeaf"] = CompactCacheLeaf(runtimeRoot, identity);
    Console.WriteLine(new JavaScriptSerializer().Serialize(result));
  }
#endif

  static string UserIdentity() {
    return string.Join("\\", new[] { Variable("USERDOMAIN"), Variable("USERNAME") }
      .Where(part => !string.IsNullOrWhiteSpace(part)));
  }

  // A true uninstall can precede the first launch of the successor. The updater cache is
  // per user and may also contain packages for another installation of the same product.
  static void RemovePreparedUpdates(string cache, string executable) {
    var root = Path.Combine(cache, "open-science-prepared");
    if (!Directory.Exists(root) || !NoReparsePointInPath(root) || !TrustedAcl(root)) return;
    var installed = InstallDirectory.CanonicalPath(executable);
    root = root.StartsWith(@"\\", StringComparison.Ordinal) ? @"\\?\UNC\" + root.Substring(2) : @"\\?\" + root;
    bool failed = false;
    using (InstallDirectory.HoldForProgramCleanup(cache))
    using (InstallDirectory.HoldForProgramCleanup(root)) {
      foreach (var stage in Directory.GetDirectories(root)) {
        if (!Regex.IsMatch(Path.GetFileName(stage), @"\A[a-f0-9]{32}\z") || IsReparsePoint(stage)) continue;
        try {
          using (InstallDirectory.HoldForProgramCleanup(stage)) {
            if (!TrustedAcl(stage)) continue;
            var marker = new[] { "ready.json", "installing.json", "scan-timed-out.json" }
              .Select(name => Path.Combine(stage, name)).FirstOrDefault(File.Exists);
            if (marker == null || IsReparsePoint(marker) || !TrustedAcl(marker)) continue;
            var receipt = ReadJsonObject(marker, 64 * 1024);
            if (!TextEquals(Field(receipt, "executable"), installed)) continue;
            var sha512 = Field(receipt, "sha512") as string;
            if (sha512 == null || !Regex.IsMatch(sha512, @"\A[A-Za-z0-9+/]{86}==\z")) continue;
            // The canonical executable in the receipt identifies the installation; the digest
            // identifies the installer. Never consume or delete the SDK's own pending files.
            var payload = Path.Combine(stage, "payload");
            if (Directory.Exists(payload)) RemoveTree(payload);
            foreach (var file in Directory.GetFiles(stage)) {
              if (Regex.IsMatch(Path.GetFileName(file), @"\A(?:occupant-\d+-\d+|accepted-[a-f0-9-]{36})\z"))
                File.Delete(file);
            }
            File.Delete(marker);
          }
          if (!Directory.EnumerateFileSystemEntries(stage).Any()) Directory.Delete(stage);
        } catch (Exception error) {
          Console.Error.WriteLine("Retained prepared update at " + stage + ": " + error.Message);
          failed = true;
        }
      }
    }
    if (!Directory.EnumerateFileSystemEntries(root).Any()) Directory.Delete(root);
    if (failed) Exit(1);
  }

  // ---- runtime-cache: owned micromamba caches --------------------------------------------

  static void RuntimeCache() {
    var userIdentity = UserIdentity();
    var profile = Variable("USERPROFILE");
    var roots = new List<string>();
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    Action<string> addRoot = root => { if (seen.Add(root)) roots.Add(root); };
    addRoot(Path.Combine(profile, @"OpenScience\runtime"));
    addRoot(Path.Combine(profile, @"Open-Science\runtime"));
    addRoot(Path.Combine(profile, @".open-science\runtime"));
    var settingsPath = Path.Combine(profile, @".open-science\settings.json");
    if (File.Exists(settingsPath)) {
      try {
        var dataRoot = AsString(Field(ReadJsonObject(settingsPath, SettingsDocumentBytes), "dataRoot"));
        if (dataRoot.Length > 0 && Path.IsPathRooted(dataRoot)) addRoot(Path.Combine(dataRoot, "runtime"));
      } catch { }
    }

    foreach (var root in roots) {
      try {
        var canonicalRoot = InstallDirectory.CanonicalPath(root);
        var drive = Path.GetPathRoot(canonicalRoot);
        var leaf = CacheLeaf(canonicalRoot, userIdentity);
        var compactLeaf = CompactCacheLeaf(canonicalRoot, userIdentity);
        var workingLeaf = WorkingCacheLeaf(canonicalRoot, userIdentity);
        var candidates = new List<KeyValuePair<string, bool>>();
        Action<string, bool> addCandidate = (path, managedParent) => {
          var candidate = new KeyValuePair<string, bool>(path, managedParent);
          if (!candidates.Contains(candidate)) candidates.Add(candidate);
        };
        addCandidate(Path.Combine(drive, leaf), false);
        var publicRoot = Variable("PUBLIC");
        if (!string.IsNullOrWhiteSpace(publicRoot)) addCandidate(Path.Combine(publicRoot, leaf), false);
        addCandidate(Path.Combine(profile, leaf), false);
        addCandidate(Path.Combine(profile, compactLeaf), false);
        var managedParents = new List<string> {
          Path.Combine(drive, "OpenScienceTmp"),
          Path.Combine(drive, "Open-ScienceTmp")
        };
        foreach (var configuredTemp in new[] { Variable("TEMP"), Variable("TMP") }) {
          if (configuredTemp.Length == 0) continue;
          managedParents.Add(Path.Combine(configuredTemp, "OpenScienceTmp"));
          managedParents.Add(Path.Combine(configuredTemp, "Open-ScienceTmp"));
        }
        managedParents.Add(Path.Combine(profile, "os-tmp"));
        foreach (var managedParent in managedParents.Distinct(StringComparer.Ordinal))
          addCandidate(Path.Combine(managedParent, workingLeaf), true);

        foreach (var candidate in candidates) {
          try {
            var candidatePath = candidate.Key;
            var parent = Path.GetDirectoryName(candidatePath);
            if (PathExists(candidatePath) &&
                (!candidate.Value || TrustedManagedParent(parent, userIdentity)) &&
                TrustedCache(candidatePath, canonicalRoot, userIdentity)) {
              RemoveTree(candidatePath);
              if (candidate.Value) RemoveEmptyManagedParent(parent, userIdentity);
            } else if (candidate.Value && PathExists(parent)) {
              // A prior cleanup may have removed the child but lost a race or lock while removing the now
              // marker-only parent. Revalidate it and retry the same non-recursive empty-parent cleanup.
              RemoveEmptyManagedParent(parent, userIdentity);
            }
          } catch { }
        }
      } catch { }
    }
  }

  // ---- update-handoff: owned in-app update records -----------------------------------------

  const string Uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  static readonly Regex OperationName = new Regex("^" + Uuid + "$");
  static readonly Regex OwnedRecord = new Regex(
    @"^(request\.json|config\.bin|helper\.exe|cancel|(accepted|installing|installed|failed|ready|closed|aborted|handoff|unconfirmed)\.receipt)(?:\." +
    Uuid + @"\.tmp|\.tmp)?$");

  // Same token as process-birth-identity.ts: the kernel creation FILETIME at 100 ns resolution.
  // Returns "" when the PID no longer exists and null when the live process cannot be inspected.
  static string LiveProcessBirthToken(int processId) {
    Process live;
    try { live = Process.GetProcessById(processId); }
    catch (ArgumentException) { return ""; }
    catch { return null; }
    try { return "windows-creation-time:" + live.StartTime.ToFileTimeUtc(); }
    catch { return null; }
    finally { live.Dispose(); }
  }

  static bool RecordedOwner(ProcessRecord process, object recordedPid, object recordedBirthToken) {
    decimal pid;
    if (!TryNumber(recordedPid, out pid) || pid == 0 || process.ProcessId != pid) return false;
    // Records from older versions carry no birth identity; a matching PID remains possible ownership.
    var expected = AsString(recordedBirthToken);
    if (string.IsNullOrWhiteSpace(expected)) return true;
    var actual = LiveProcessBirthToken((int)pid);
    // An uninspectable live process is uncertainty, not proof that the owner is gone.
    if (actual == null) return true;
    return string.Equals(actual, expected, StringComparison.Ordinal);
  }

  static void DeleteFile(string path) {
    var attributes = File.GetAttributes(path);
    if ((attributes & FileAttributes.ReadOnly) != 0) File.SetAttributes(path, attributes & ~FileAttributes.ReadOnly);
    File.Delete(path);
  }

  static void UpdateHandoff(string installPath) {
    var appData = ApplicationData();
    var roots = new[] {
      Path.Combine(appData, @"Open-Science\UpdateHandoffs"),
      Path.Combine(appData, "Open-Science-UpdateHandoffs")
    }.Where(PathExists).ToList();
    if (roots.Count == 0) return;
    var installation = Path.GetFullPath(installPath).TrimEnd('\\');
    // Read-only process inventory. An unavailable inventory must not authorize deletion.
    var processes = Processes();
    // NSIS starts this helper as its child. A historical update PID can be reused by that process,
    // and its executable identity may be hidden. Exclude this process and its observed ancestors
    // before evaluating recorded owners.
    var self = (uint)Process.GetCurrentProcess().Id;
    var ancestors = new HashSet<uint>();
    var cursor = processes.FirstOrDefault(process => process.ProcessId == self);
    while (cursor != null && cursor.ParentProcessId != 0 && ancestors.Add(cursor.ParentProcessId)) {
      var parentPid = cursor.ParentProcessId;
      cursor = processes.FirstOrDefault(process => process.ProcessId == parentPid);
    }
    Func<ProcessRecord, bool> excluded = process => process.ProcessId == self || ancestors.Contains(process.ProcessId);
    var otherInstallationHelpers = new List<string>();
    foreach (var root in roots) {
      try {
        if (!PathExists(root)) continue;
        if (!NoReparsePointInPath(root) || !TrustedAcl(root)) {
          Console.WriteLine("Retained update records at '" + root + "': storage ownership could not be verified.");
          continue;
        }
        foreach (var directory in Directory.GetFileSystemEntries(root)) {
          var name = Path.GetFileName(directory);
          if (!Directory.Exists(directory) || !OperationName.IsMatch(name) ||
              !NoReparsePointInPath(directory) || !TrustedAcl(directory)) continue;
          var files = Directory.GetFileSystemEntries(directory);
          // Never recursively erase unknown content or follow a reparse point.
          if (files.Any(file => Directory.Exists(file) || IsReparsePoint(file) ||
              !OwnedRecord.IsMatch(Path.GetFileName(file)) || !TrustedAcl(file))) continue;
          var requestPath = Path.Combine(directory, "request.json");
          Dictionary<string, object> request;
          string requestInstallation;
          try {
            if (new FileInfo(requestPath).Length > 16384) continue;
            request = ReadJsonObject(requestPath);
            decimal parentPid;
            if (!NumberEquals(Field(request, "schema"), 1) ||
                !(Field(request, "operationId") is string) || (string)Field(request, "operationId") != name ||
                !Path.IsPathRooted(AsString(Field(request, "applicationPath"))) ||
                !Path.IsPathRooted(AsString(Field(request, "installerPath"))) ||
                !TryNumber(Field(request, "parentPid"), out parentPid) || parentPid <= 0) continue;
            requestInstallation = Path.GetDirectoryName(Path.GetFullPath(AsString(Field(request, "applicationPath")))).TrimEnd('\\');
          } catch { continue; }
          var helper = Path.Combine(directory, "helper.exe");
          if (!string.Equals(requestInstallation, installation, StringComparison.OrdinalIgnoreCase)) {
            // Only a trusted record can establish that this helper belongs to a different installation.
            // Enumeration can expand 8.3 ancestors; retain the root spelling used by the fallback scan.
            otherInstallationHelpers.Add(Path.Combine(Path.Combine(root, name), "helper.exe"));
            continue;
          }
          var applicationPath = AsString(Field(request, "applicationPath"));
          var installerPath = AsString(Field(request, "installerPath"));
          var active = processes.Where(process => {
            if (excluded(process)) return false;
            // Historic PIDs can be reused by unrelated processes after an update or reboot. A readable
            // different executable is not an owner; preserve uncertainty only when its identity is hidden.
            // Legacy helpers predate birth identity and are matched by PID alone.
            if (process.ExecutablePath == null)
              return RecordedOwner(process, Field(request, "parentPid"), Field(request, "parentBirthToken")) ||
                RecordedOwner(process, Field(request, "helperPid"), null) ||
                RecordedOwner(process, Field(request, "successorPid"), Field(request, "successorBirthToken"));
            return string.Equals(process.ExecutablePath, helper, StringComparison.OrdinalIgnoreCase) ||
              string.Equals(process.ExecutablePath, applicationPath, StringComparison.OrdinalIgnoreCase) ||
              string.Equals(process.ExecutablePath, installerPath, StringComparison.OrdinalIgnoreCase);
          }).ToList();
          if (active.Any(process => process.ExecutablePath == null)) {
            Console.WriteLine("Could not inspect a recorded owner of update operation " + name + ". Retry uninstall after closing its update window.");
            Exit(1);
          }
          if (active.Count > 0) {
            Console.WriteLine("Update operation " + name + " is still active; close its presentation after installation finishes and retry uninstall.");
            Exit(2);
          }
          // Remove the executable first (Windows refuses if still mapped), the request last so retry retains
          // its ownership evidence. Unknown outcomes may be removed only during an explicit product uninstall.
          if (File.Exists(helper)) DeleteFile(helper);
          foreach (var file in files) {
            var fileName = Path.GetFileName(file);
            if (!string.Equals(fileName, "request.json", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(fileName, "helper.exe", StringComparison.OrdinalIgnoreCase)) DeleteFile(file);
          }
          DeleteFile(requestPath);
          Directory.Delete(directory, false);
        }
      } catch (ExitException) {
        throw;
      } catch (Exception error) {
        // Optional record cleanup must not trap product removal. Preserve remaining ownership evidence
        // for a later cleanup; never repair ACLs or recursively remove content we cannot verify.
        Console.WriteLine("Retained update records at '" + root + "': " + error.Message);
      }
    }
    // NSIS holds the installer mutex independently of these optional records. Older detached helpers
    // have their own lifetime: identify them from the captured process inventory even when storage is
    // untrusted, except where a verified record established a different installation above.
    foreach (var process in processes) {
      if (excluded(process) || process.ExecutablePath == null ||
          otherInstallationHelpers.Contains(process.ExecutablePath, StringComparer.OrdinalIgnoreCase)) continue;
      foreach (var root in roots) {
        var pattern = "^" + Regex.Escape(root) + @"\\" + Uuid + @"\\helper\.exe$";
        if (Regex.IsMatch(process.ExecutablePath, pattern, RegexOptions.IgnoreCase)) {
          Console.WriteLine("Update helper is still active: " + process.ExecutablePath);
          Exit(2);
        }
      }
    }
  }

  // ---- notebook-sandbox: owned AppContainer resources --------------------------------------

  const string NotebookInstallationId = "0f3cd2a44c3d4e4e9f1e2a5b";

  sealed class HelperError : Exception {
    public readonly int Code;
    public HelperError(string message, int code) : base(message) { Code = code; }
  }

  static bool CurrentUserIsAdministrator() {
#if OPEN_SCIENCE_HELPER_TEST_SEAMS
    if (Variable("OPEN_SCIENCE_HELPER_TEST_NOT_ADMIN") == "1") return false;
#endif
    return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
  }

  // Any file, including unexpected ones, so corrupt records cannot silently select a fresh location.
  // Links are not followed: a linked directory's target is not this profile's state.
  static bool OwnershipState(string root) {
    if (!PathExists(root)) return false;
    return AnyFile(root);
  }

  static bool AnyFile(string directory) {
    foreach (var entry in Directory.GetFileSystemEntries(directory)) {
      var attributes = File.GetAttributes(entry);
      if ((attributes & FileAttributes.Directory) == 0) return true;
      if ((attributes & FileAttributes.ReparsePoint) == 0 && AnyFile(entry)) return true;
    }
    return false;
  }

  // CommandLineToArgvW quoting for one argument.
  static string WindowsArgument(string value) {
    return "\"" + Regex.Replace(Regex.Replace(value, "(\\\\*)\"", "$1$1\\\""), "(\\\\+)$", "$1$1") + "\"";
  }

  static string HostArguments(string command, string ownershipRoot) {
    return string.Join(" ", new[] { command, NotebookInstallationId, ownershipRoot }.Select(WindowsArgument));
  }

  // Runs the host in this console, so its output reaches the NSIS log like a PowerShell call.
  static int RunHost(string hostPath, string command, string ownershipRoot) {
    var start = new ProcessStartInfo(hostPath, HostArguments(command, ownershipRoot)) { UseShellExecute = false };
    using (var process = Process.Start(start)) {
      process.WaitForExit();
      return process.ExitCode;
    }
  }

  static int RunElevatedHost(string hostPath, string command, string ownershipRoot) {
    var start = new ProcessStartInfo(hostPath, HostArguments(command, ownershipRoot)) { UseShellExecute = true, Verb = "runas" };
#if OPEN_SCIENCE_HELPER_TEST_SEAMS
    // Test builds only: never show UAC. "direct" keeps the serialized command line without elevation.
    var elevation = Variable("OPEN_SCIENCE_HELPER_TEST_ELEVATION");
    if (elevation.StartsWith("deny:", StringComparison.Ordinal)) {
      File.WriteAllText(elevation.Substring(5), start.Verb);
      throw new InvalidOperationException("Unexpected elevation request for the isolated uninstall fixture.");
    }
    if (elevation == "direct") { start.UseShellExecute = false; start.Verb = ""; }
#endif
    using (var process = Process.Start(start)) {
      process.WaitForExit();
      return process.ExitCode;
    }
  }

  static void NotebookSandbox(string sandboxRoot) {
    var hostPaths = new[] {
      Path.Combine(sandboxRoot, @"x64\notebook-appcontainer-host.exe"),
      Path.Combine(sandboxRoot, @"arm64\notebook-appcontainer-host.exe")
    };
    var localAppData = Variable("LOCALAPPDATA");
    var ownershipRoot = Path.Combine(localAppData, @"Aipoch\Open-Science\notebook-sandbox\" + NotebookInstallationId);
    var legacyOwnershipRoot = Path.Combine(localAppData, @"Aipoch\OpenScience\notebook-sandbox\" + NotebookInstallationId);
    try {
      var isolatedRoot = Variable("OPEN_SCIENCE_E2E_STORAGE_ROOT").Trim();
      if (isolatedRoot.Length == 0) isolatedRoot = Variable("OPEN_SCIENCE_CONFIG_ROOT").Trim();
      if (isolatedRoot.Length > 0) {
        if (!Path.IsPathRooted(isolatedRoot)) throw new HelperError("The config root must be an absolute path.", 1);
        ownershipRoot = Path.Combine(isolatedRoot, @"notebook-sandbox\" + NotebookInstallationId);
      } else if (OwnershipState(legacyOwnershipRoot)) {
        if (OwnershipState(ownershipRoot))
          throw new HelperError("Notebook isolation ownership is ambiguous. Resolve both existing ownership directories before uninstalling. currentRoot=" + ownershipRoot + " legacyRoot=" + legacyOwnershipRoot, 1);
        ownershipRoot = legacyOwnershipRoot;
      }
      var hostPath = hostPaths.FirstOrDefault(File.Exists);
      if (hostPath == null) {
        var leaseRoot = Path.Combine(ownershipRoot, "acl-leases");
        var hasLease = Directory.Exists(leaseRoot) && Directory.GetFileSystemEntries(leaseRoot, "*.json").Length > 0;
        var hasReceipt = File.Exists(Path.Combine(ownershipRoot, "receipt.json"));
        var hasJournal = File.Exists(Path.Combine(ownershipRoot, "creating.json"));
        if (hasReceipt || hasJournal || hasLease)
          throw new HelperError("The Notebook isolation host is missing while owned resources still require cleanup. sandboxRoot=" + sandboxRoot + " ownershipRoot=" + ownershipRoot + " receipt=" + (hasReceipt ? "True" : "False") + " journal=" + (hasJournal ? "True" : "False") + " aclLeases=" + (hasLease ? "True" : "False"), 1);
        return;
      }
      try {
        StopProcessesUnder(sandboxRoot);
        var prepareCode = RunHost(hostPath, "prepare-remove", ownershipRoot);
        if (prepareCode != 0)
          throw new HelperError("Notebook isolation preparation exited " + prepareCode + ". host=" + hostPath + " ownershipRoot=" + ownershipRoot, prepareCode);
        // An unused standard-mode profile has no protected resources to remove. Still run the native
        // host so it validates current ownership; a concurrent setup must not be silently skipped.
        // Already-elevated uninstalls also run directly and wait before NSIS deletes this install tree.
        var removeCode = CurrentUserIsAdministrator() || !OwnershipState(ownershipRoot)
          ? RunHost(hostPath, "remove", ownershipRoot)
          : RunElevatedHost(hostPath, "remove", ownershipRoot);
        if (removeCode != 0)
          throw new HelperError("Notebook isolation removal exited " + removeCode + ". host=" + hostPath + " ownershipRoot=" + ownershipRoot, removeCode);
        var finishCode = RunHost(hostPath, "finish-remove", ownershipRoot);
        if (finishCode != 0)
          Console.Error.WriteLine("Notebook isolation finalization exited " + finishCode + ". host=" + hostPath + " ownershipRoot=" + ownershipRoot);
        Exit(finishCode);
      } finally {
        StopProcessesUnder(sandboxRoot);
      }
    } catch (ExitException) {
      throw;
    } catch (HelperError error) {
      Console.Error.WriteLine(error.Message);
      Exit(error.Code);
    } catch (Win32Exception error) {
      if (error.NativeErrorCode == 1223) {
        Console.Error.WriteLine("AppContainer removal was cancelled by the user.");
        Exit(1223);
      }
      Console.Error.WriteLine(error.ToString());
      Exit(1);
    } catch (Exception error) {
      Console.Error.WriteLine(error.Message);
      Console.Error.WriteLine(error.ToString());
      Exit(1);
    }
  }

  // ---- program-data-paths: configured data roots inside the installation ------------------

  static readonly Regex AbsolutePathPattern = new Regex(@"^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)");

  static string AbsolutePath(string path) {
    if (!AbsolutePathPattern.IsMatch(path) || Regex.IsMatch(path, @"[\x00-\x1f]"))
      throw new InvalidDataException("The configured storage location must be an absolute path without control characters.");
    var full = Path.GetFullPath(path);
    if (full.Length > Path.GetPathRoot(full).Length) full = full.TrimEnd('\\');
    return full;
  }

  static string ErrorDetails(Exception error) {
    var parts = new List<string> {
      "exceptionType=" + error.GetType().FullName,
      "message=" + error.Message,
      "hresult=0x" + unchecked((uint)error.HResult).ToString("X8")
    };
    for (var inner = error; inner != null; inner = inner.InnerException) {
      var native = inner as Win32Exception;
      if (native != null) { parts.Add("nativeErrorCode=" + native.NativeErrorCode); break; }
    }
    return string.Join(" ", parts);
  }

  static void ProgramDataPaths(string installPath, string outputPath, int maxLineLength) {
    try {
      // Match the packaged bootstrap resolver. A development-only STORAGE_ROOT does not participate.
      var configRoot = Variable("OPEN_SCIENCE_E2E_STORAGE_ROOT");
      if (configRoot.Trim().Length == 0) configRoot = Variable("OPEN_SCIENCE_CONFIG_ROOT");
      if (configRoot.Trim().Length == 0) configRoot = Path.Combine(Variable("USERPROFILE"), ".open-science");
      configRoot = AbsolutePath(configRoot.Trim());
      var dataRoot = "";
      var settingsPath = Path.Combine(configRoot, "settings.json");
      if (File.Exists(settingsPath)) {
        var saved = Field(ReadJsonObject(settingsPath, SettingsDocumentBytes), "dataRoot");
        if (saved != null) {
          if (!(saved is string)) throw new InvalidDataException("The saved data location is not a path.");
          if (((string)saved).Trim().Length > 0) dataRoot = AbsolutePath((string)saved);
        }
      }
      var install = AbsolutePath(installPath);
      // .NET expands existing 8.3 ancestors, while NSIS traversal can retain that spelling.
      // Match normalized locations, then emit descendants under the caller's exact root prefix.
      var traversalRoot = installPath.TrimEnd('\\');
      var prefix = install.TrimEnd('\\') + "\\";
      var physicalInstall = InstallDirectory.CanonicalPath(install).TrimEnd('\\');
      var physicalPrefix = physicalInstall + "\\";
      // The installation root itself already uses an allowlist. Protect any configured descendants,
      // including roots inside resources/locales, without retaining unrelated ancestors' program files.
      var paths = new List<string>();
      foreach (var root in new[] { configRoot, dataRoot }) {
        paths.Add(root.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? traversalRoot + root.Substring(install.Length) : "");
        // Preserve both the saved access path and its physical target. A junction/short-path alias
        // outside the installation can still address research inside the program tree.
        if (root.Length == 0) { paths.Add(""); continue; }
        if (File.Exists(root)) throw new InvalidDataException("The configured storage location is not a directory.");
        var physical = InstallDirectory.CanonicalPath(root);
        paths.Add(physical.StartsWith(physicalPrefix, StringComparison.OrdinalIgnoreCase) ? traversalRoot + physical.Substring(physicalInstall.Length) : "");
      }
      if (paths.Any(path => path.Length + 2 >= maxLineLength))
        throw new InvalidDataException("A configured storage location exceeds the installer path buffer.");
      File.WriteAllText(outputPath, string.Join("\r\n", paths) + "\r\n", new UnicodeEncoding(false, false));
    } catch (Exception error) {
      Console.Error.WriteLine("Open-Science windows-uninstall-helper program-data-paths failed phase=resolve-configured-data-locations " + ErrorDetails(error));
      Exit(2);
    }
  }

  // ---- program-cleanup: remove the staged program tree ------------------------------------

  static IEnumerable<Dictionary<string, object>> ErrorEvidence(Exception error, Dictionary<string, object> report) {
    var evidence = new Dictionary<string, object>();
    evidence["operation"] = error.Data["operation"];
    evidence["path"] = error.Data["path"];
    evidence["exceptionType"] = error.GetType().FullName;
    evidence["message"] = error.Message;
    evidence["hresult"] = "0x" + unchecked((uint)error.HResult).ToString("X8");
    // Only a real Win32Exception is evidence of a Win32 error; HRESULT low bits are not.
    var native = error as Win32Exception;
    evidence["nativeErrorCode"] = native != null ? (object)native.NativeErrorCode : null;
    foreach (var key in new[] { "deletionCancellation", "attributeRestoration" })
      if (error.Data.Contains(key)) report[key] = error.Data[key];
    yield return evidence;
    var aggregate = error as AggregateException;
    var inners = aggregate != null ? aggregate.InnerExceptions.ToArray()
      : error.InnerException != null ? new[] { error.InnerException } : new Exception[0];
    foreach (var inner in inners)
      foreach (var item in ErrorEvidence(inner, report)) yield return item;
  }

  static bool RecoverableSharingError(Exception error) {
    foreach (var key in new[] { "deletionCancellation", "attributeRestoration" })
      if (error.Data.Contains(key) && (string)error.Data[key] != "succeeded") return false;
    var native = error as Win32Exception;
    if (native != null && native.NativeErrorCode != 32 && native.NativeErrorCode != 33) return false;
    var aggregate = error as AggregateException;
    if (aggregate != null) {
      foreach (var key in new[] { "deletionCancellation", "attributeRestoration" })
        if (!error.Data.Contains(key)) return false;
      return aggregate.InnerExceptions.Count > 0 && aggregate.InnerExceptions.All(RecoverableSharingError);
    }
    if (error.InnerException != null) return RecoverableSharingError(error.InnerException);
    return native != null;
  }

  static void WriteCleanupReport(string reportPath, Dictionary<string, object> report) {
    if (string.IsNullOrEmpty(reportPath)) return;
    try {
      File.WriteAllText(reportPath, new JavaScriptSerializer().Serialize(report), new UTF8Encoding(false));
    } catch (Exception error) {
      Console.Error.WriteLine("Could not save cleanup diagnostic: " + error.Message);
    }
  }

  static void ProgramCleanup(string stagingPath, string reportPath, bool upgrade) {
    var attempts = new List<object>();
    var report = new Dictionary<string, object>();
    report["timestamp"] = DateTime.UtcNow.ToString("o");
    report["phase"] = "remove-staged-program-files";
    report["stagingPath"] = stagingPath;
    report["status"] = "failed";
    report["deletionCancellation"] = "unknown";
    report["attributeRestoration"] = "unknown";
    report["fileMoveBack"] = "unknown";
    report["errors"] = new object[0];
    report["attempts"] = attempts;
    Action<int, int> saveAttempt = (number, delay) => {
      var attempt = new Dictionary<string, object>();
      attempt["number"] = number;
      attempt["timestamp"] = DateTime.UtcNow.ToString("o");
      attempt["status"] = report["status"];
      attempt["deletionCancellation"] = report["deletionCancellation"];
      attempt["attributeRestoration"] = report["attributeRestoration"];
      attempt["errors"] = report["errors"];
      attempt["retryDelaySeconds"] = delay;
      attempts.Add(attempt);
      WriteCleanupReport(reportPath, report);
    };
    Microsoft.Win32.SafeHandles.SafeFileHandle directoryHandle = null;
    try {
      for (var attempt = 1; attempt <= 4; attempt++) {
        report["deletionCancellation"] = "unknown";
        report["attributeRestoration"] = "unknown";
        try {
          if (directoryHandle == null) {
            var protectedPath = stagingPath;
            if (!protectedPath.StartsWith(@"\\?\", StringComparison.Ordinal))
              protectedPath = protectedPath.StartsWith(@"\\", StringComparison.Ordinal)
                ? @"\\?\UNC\" + protectedPath.Substring(2) : @"\\?\" + protectedPath;
            try { directoryHandle = InstallDirectory.HoldForProgramCleanup(protectedPath); }
            catch (Exception failure) {
              failure.Data["operation"] = "hold-staging-directory";
              failure.Data["path"] = stagingPath;
              throw;
            }
          }
          // Keep the no-delete-sharing directory handle across all calls and waits. The staging
          // name cannot be replaced between otherwise independently protected helper calls.
          InstallDirectory.RemoveStagedProgramFiles(stagingPath);
          report["status"] = "succeeded";
          report["errors"] = new object[0];
          report["deletionCancellation"] = "not-needed";
          report["attributeRestoration"] = "not-needed";
          saveAttempt(attempt, 0);
          Console.WriteLine("Open-Science program cleanup attempt=" + attempt + " result=succeeded");
          return;
        } catch (Exception failure) {
          report["errors"] = ErrorEvidence(failure, report).ToArray();
          var delay = 0;
          if (upgrade && attempt < 4 &&
              (string)report["deletionCancellation"] == "succeeded" && (string)report["attributeRestoration"] == "succeeded" &&
              RecoverableSharingError(failure)) delay = attempt;
          saveAttempt(attempt, delay);
          Console.Error.WriteLine("Open-Science program cleanup attempt=" + attempt + " result=failed deletionCancellation=" + report["deletionCancellation"] + " attributeRestoration=" + report["attributeRestoration"] + " " + ErrorDetails(failure));
          Console.Error.WriteLine(failure.ToString());
          if (delay == 0) Exit(2);
          Console.WriteLine("Open-Science program cleanup retry: waiting " + delay + " second(s), next attempt=" + (attempt + 1));
          System.Threading.Thread.Sleep(delay * 1000);
        }
      }
    } finally {
      if (directoryHandle != null) directoryHandle.Dispose();
    }
  }
}
