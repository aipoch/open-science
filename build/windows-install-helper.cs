using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

// Native replacement for the install-path PowerShell scripts (windows-install-publication.ps1 and
// windows-extract-payload.ps1). A normal x64 install launches powershell.exe three times, and each
// launch costs 0.6-1.2 s in the installer context before the script does any work. This .NET
// Framework helper starts in about 0.1 s. Exit codes, stdout and the diagnostic JSON match the
// scripts, so the NSIS flow and the failure notices built from the reports do not change.
// Built with the system csc.exe (C# 5) together with windows-install-publication.cs.
public static class InstallHelper {
  sealed class ExitException : Exception {
    public readonly int Code;
    public ExitException(int code) { Code = code; }
  }

  static void Exit(int code) { throw new ExitException(code); }

  public static int Main(string[] args) {
    try {
      // Unicode NSIS nsExec reads the stack as UTF-16LE. The default console code page loses
      // profile characters, so the staging path and status lines must be written as UTF-16LE.
      Console.OutputEncoding = Encoding.Unicode;
      if (args.Length == 0) throw new ArgumentException("Missing subcommand.");
      var options = ParseOptions(args);
      switch (args[0]) {
        case "prepare":
        case "publish":
        case "cleanup":
          Publication(args[0], Required(options, "install-path"), Required(options, "state"), Optional(options, "report"));
          break;
        case "extract":
          Extract(
            Required(options, "extractor"),
            Required(options, "archive"),
            Required(options, "target"),
            Required(options, "lists"),
            Optional(options, "report"));
          break;
        case "diagnostics":
          InstallDiagnostics.Run(options);
          break;
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
    var options = new Dictionary<string, string>();
    for (var i = 1; i < args.Length; i++) {
      if (!args[i].StartsWith("--", StringComparison.Ordinal) || i + 1 >= args.Length)
        throw new ArgumentException("Expected --name value options, got: " + args[i]);
      options[args[i].Substring(2)] = args[++i];
    }
    return options;
  }

  static string Required(Dictionary<string, string> options, string name) {
    string value;
    if (!options.TryGetValue(name, out value) || value.Length == 0)
      throw new ArgumentException("Missing --" + name + ".");
    return value;
  }

  static string Optional(Dictionary<string, string> options, string name) {
    string value;
    return options.TryGetValue(name, out value) ? value : null;
  }

  static Dictionary<string, object> Object(object value) { return (Dictionary<string, object>)value; }

  static string Text(Dictionary<string, object> value, string name) { return (string)value[name]; }

  static bool Flag(Dictionary<string, object> value, string name) { return (bool)value[name]; }

  // The scripts parsed and wrote JSON through PowerShell's serializer, which shares
  // JavaScriptSerializer's type mapping (numbers become int/long/decimal, objects become
  // Dictionary<string, object>). State files round-trip through the same serializer.
  static Dictionary<string, object> ReadJson(string path) {
    var value = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(path));
    if (!(value is Dictionary<string, object>)) throw new InvalidDataException("Expected a JSON object: " + path);
    return Object(value);
  }

  static void WriteJson(string path, object value) {
    File.WriteAllText(path, new JavaScriptSerializer().Serialize(value), new UTF8Encoding(false));
  }

  // ---- publication: windows-install-publication.ps1 ----

  static string operation = "load-publication-helper";
  static string operationPath = null;

  static void Step(string name, string path) { operation = name; operationPath = path; }

  static string Extended(string path) { return path.StartsWith(@"\\?\", StringComparison.Ordinal) ? path : @"\\?\" + path; }

  static Dictionary<string, object> ErrorRecord(Exception error) {
    var hresult = unchecked((uint)error.HResult);
    var record = new Dictionary<string, object>();
    record["operation"] = error.Data.Contains("operation") ? error.Data["operation"] : operation;
    record["path"] = error.Data.Contains("path") ? error.Data["path"] : operationPath;
    record["exceptionType"] = error.GetType().FullName;
    record["message"] = error.Message;
    record["hresult"] = "0x" + hresult.ToString("X8");
    var win32 = error as Win32Exception;
    record["nativeErrorCode"] = win32 != null ? (object)win32.NativeErrorCode : null;
    // Managed filesystem exceptions retain the HRESULT supplied by Windows. Preserve this
    // separately from a real Win32Exception, never infer it from a tool or process exit status.
    record["windowsErrorCode"] =
      (error is IOException || error is UnauthorizedAccessException) && (hresult & 0xFFFF0000) == 0x80070000
        ? (object)(hresult & 0xFFFF) : null;
    return record;
  }

  static List<object> ErrorChain(Exception error) {
    var records = new List<object>();
    records.Add(ErrorRecord(error));
    var aggregate = error as AggregateException;
    if (aggregate != null) {
      foreach (var inner in aggregate.InnerExceptions) records.AddRange(ErrorChain(inner));
    } else if (error.InnerException != null) {
      records.AddRange(ErrorChain(error.InnerException));
    }
    return records;
  }

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct FindData {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint SizeHigh, SizeLow, Reserved0, Reserved1;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string Name;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=14)] public string AlternateName;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr FindFirstFile(string pattern, out FindData data);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool FindNextFile(IntPtr search, out FindData data);
  [DllImport("kernel32.dll")] static extern bool FindClose(IntPtr search);

  // Framework enumeration expands short aliases and reapplies the legacy MAX_PATH limit, so the
  // extended prefix the script relies on is not usable through it. Enumerate with FindFirstFile and
  // keep the extended path through attributes and the permission checks.
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetSecurityInfo(Microsoft.Win32.SafeHandles.SafeFileHandle handle, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor, uint revision, uint info, out IntPtr text, out uint length);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);

  // Managed access-control calls reject the extended prefix, so read the descriptor from a
  // no-follow handle instead of from the path string.
  static string Descriptor(string path, bool directory) {
    Step("read-permissions", path);
    var handle = CreateFile(path, 0x20000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle.IsInvalid) { var error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
    using (handle) {
      IntPtr owner, group, dacl, sacl, descriptor;
      var status = GetSecurityInfo(handle, 1, 7, out owner, out group, out dacl, out sacl, out descriptor);
      if (status != 0) throw new Win32Exception((int)status);
      try {
        IntPtr text; uint length;
        if (!ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor, 1, 7, out text, out length))
          throw new Win32Exception(Marshal.GetLastWin32Error());
        try { return Marshal.PtrToStringUni(text); } finally { LocalFree(text); }
      } finally { LocalFree(descriptor); }
    }
  }

  sealed class Entry { public string Path; public uint Attributes; }
  static List<Entry> Entries(string directory) {
    FindData data;
    var search = FindFirstFile(directory + @"\*", out data);
    if (search == new IntPtr(-1)) {
      var error = Marshal.GetLastWin32Error();
      if (error == 2) return new List<Entry>();
      throw new Win32Exception(error);
    }
    var entries = new List<Entry>();
    try {
      do {
        if (data.Name == "." || data.Name == "..") continue;
        var entry = new Entry();
        entry.Path = directory + @"\" + data.Name;
        entry.Attributes = data.Attributes;
        entries.Add(entry);
      } while (FindNextFile(search, out data));
      var error = Marshal.GetLastWin32Error();
      if (error != 18) throw new Win32Exception(error);
    } finally { FindClose(search); }
    return entries;
  }

  static void RejectReparsePoint(string entry) {
    if ((File.GetAttributes(entry) & FileAttributes.ReparsePoint) != 0)
      throw new IOException("Reparse point in payload: " + entry);
  }

  // Robocopy excludes junctions, including destination entries. Reject overlapping links before
  // copying so a skipped payload cannot be reported as a successful installation. Inspect only
  // payload destinations; unrelated user-data trees remain untouched.
  [StructLayout(LayoutKind.Sequential, Pack=4)] struct ByHandle { public uint Attributes; public long Creation; public long Access; public long Write; public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links; public uint IndexHigh; public uint IndexLow; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle handle, out ByHandle information);

  // File.GetAttributes rejects the extended prefix. Open without following a reparse point and read
  // the attributes from the handle instead. Returns -1 when the entry does not exist.
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool DeleteFile(string path);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool RemoveDirectory(string path);

  // Directory.Delete rejects the extended prefix and follows reparse points. Remove files and
  // directories through the prefix instead, and never descend into a link.
  static void DeleteTree(string directory) {
    foreach (var entry in Entries(directory)) {
      if ((entry.Attributes & 0x400) != 0) throw new IOException("Reparse point in payload: " + entry.Path);
      if ((entry.Attributes & 0x10) != 0) DeleteTree(entry.Path);
      else if (!DeleteFile(entry.Path)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    if (!RemoveDirectory(directory)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }

    static int Attributes(string path) {
    var handle = CreateFile(path, 0x80, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle.IsInvalid) { var error = Marshal.GetLastWin32Error(); handle.Dispose(); if (error == 2 || error == 3) return -1; throw new Win32Exception(error); }
    using (handle) { ByHandle info; if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error()); return (int)info.Attributes; }
  }

    static void RejectDestinationReparsePoint(string destination) {
    Step("validate-payload-destination", destination);
    var attributes = Attributes(destination);
    if (attributes >= 0 && (attributes & 0x400) != 0)
      throw new IOException("Reparse point at payload destination: " + destination);
  }

  static void AssertOrdinaryTree(string root, bool checkPermissions, Dictionary<string, object> state, bool checkDestination) {
    var pending = new Stack<string>();
    pending.Push(Extended(root));
    while (pending.Count > 0) {
      var directory = pending.Pop();
      Step("enumerate-payload", directory);
      foreach (var entry in Entries(directory)) {
        Step("validate-payload-entry", entry.Path);
        if ((entry.Attributes & 0x400) != 0) throw new IOException("Reparse point in payload: " + entry.Path);
        var isDirectory = (entry.Attributes & 0x10) != 0;
        if (checkDestination) RejectDestinationReparsePoint(Extended(Text(state, "root")) + entry.Path.Substring(Extended(root).Length));
        if (checkPermissions) {
          var expected = isDirectory ? Text(state, "directoryAcl") : Text(state, "fileAcl");
          if (!String.Equals(Descriptor(entry.Path, isDirectory), expected, StringComparison.Ordinal))
            throw new IOException("Unexpected payload permissions: " + entry.Path);
        }
        if (isDirectory) pending.Push(entry.Path);
      }
    }
  }

  static void WriteReport(string reportPath, string phase, string status, List<object> errors, List<object> preparationCleanupErrors) {
    if (reportPath == null) return;
    try {
      var report = new Dictionary<string, object>();
      report["timestamp"] = DateTime.UtcNow.ToString("o");
      report["phase"] = phase;
      report["status"] = status;
      report["errorSource"] = "publication-helper";
      report["errors"] = errors;
      report["preparationCleanupErrors"] = preparationCleanupErrors;
      WriteJson(reportPath, report);
    } catch (Exception error) {
      Console.Error.WriteLine("Could not save publication diagnostic: " + error.Message);
    }
  }

  static string Phase(string action) {
    switch (action) {
      case "prepare": return "prepare-new-program-files";
      case "publish": return "publish-new-program-files";
      default: return "cleanup-payload-staging";
    }
  }

  static void Publication(string action, string installPath, string statePath, string reportPath) {
    var handles = new List<IDisposable>();
    IDisposable stageHandle = null;
    string createdStage = null;
    var preparationCleanupErrors = new List<object>();
#if OPEN_SCIENCE_HELPER_TEST_SEAMS
    // Test builds only: record each phase's process bitness, so a fixture can prove the helper
    // runs as a native 64-bit process instead of under WOW64 redirection.
    var hostLog = Environment.GetEnvironmentVariable("OPEN_SCIENCE_PUBLICATION_HOST_LOG");
    if (!String.IsNullOrEmpty(hostLog))
      File.AppendAllText(hostLog, Environment.Is64BitProcess + Environment.NewLine);
#endif
    try {
      Step("validate-install-path", installPath);
      var root = Path.GetFullPath(installPath).TrimEnd('\\');
      Step("validate-install-path", root);
      if (root.Length < 4 || root[1] != ':' || root[2] != '\\' || root.IndexOf('"') >= 0 || !Char.IsLetter(root[0]))
        throw new IOException("Expected a local installation directory, not a volume root or UNC path");
      var ancestors = new Stack<string>();
      for (var path = root; !String.IsNullOrEmpty(path); path = Path.GetDirectoryName(path)) ancestors.Push(path);
      while (ancestors.Count > 0) {
        var ancestor = ancestors.Pop();
        Step("hold-install-directory", ancestor);
        handles.Add(InstallDirectory.Hold(ancestor));
      }
      var rootHandle = (Microsoft.Win32.SafeHandles.SafeFileHandle)handles[handles.Count - 1];

      if (action == "prepare") {
        Step("create-publication-state", statePath);
        if (File.Exists(statePath)) throw new IOException("Publication state already exists");
        var identity = WindowsIdentity.GetCurrent();
        var principal = new WindowsPrincipal(identity);
        var acl = Directory.GetAccessControl(root);
        var useMove = !principal.IsInRole(WindowsBuiltInRole.Administrator) &&
          String.Equals(acl.GetOwner(typeof(SecurityIdentifier)).Value, identity.User.Value, StringComparison.OrdinalIgnoreCase);
        // A nested staging directory must not change how permissions propagate. Unusual ACLs keep
        // the existing copy path; never rewrite a user's ACL to make the optimization eligible.
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
          if (rule.PropagationFlags != PropagationFlags.None) useMove = false;
        }
        foreach (var name in new[] { "resources", "locales" }) {
          if (Directory.Exists(Path.Combine(root, name)) || File.Exists(Path.Combine(root, name))) useMove = false;
        }
        var stageParent = useMove ? root : Path.GetDirectoryName(Path.GetFullPath(statePath));
        // NSIS already gives each installer a private plugin directory. Keep the upstream short
        // fallback leaf: lengthening it can break CopyFiles even when the final path is supported.
        var stageName = useMove ? ".open-science-install-" + Guid.NewGuid().ToString("N") : "7z-out";
        var stage = Path.Combine(stageParent, stageName);
        Step("create-payload-staging", stage);
        InstallDirectory.Create(stage);
        createdStage = stage;
        stageHandle = InstallDirectory.Hold(stage);
        var reference = Path.Combine(root, ".open-science-acl-" + Guid.NewGuid().ToString("N"));
        var referenceCreated = false;
        Exception referenceFailure = null;
        try {
          Step("create-permission-reference", reference);
          var file = File.Open(reference, FileMode.CreateNew, FileAccess.Write, FileShare.None);
          referenceCreated = true;
          file.Dispose();
          var state = new Dictionary<string, object>();
          state["root"] = root;
          state["rootIdentity"] = InstallDirectory.Identity(rootHandle);
          state["rootAcl"] = Descriptor(root, true);
          state["stage"] = stage;
          state["stageIdentity"] = InstallDirectory.Identity((Microsoft.Win32.SafeHandles.SafeFileHandle)stageHandle);
          state["directoryAcl"] = Descriptor(stage, true);
          state["fileAcl"] = Descriptor(reference, false);
          state["useMove"] = useMove;
          Step("write-publication-state", statePath);
          var stream = File.Open(statePath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
          try {
            var bytes = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(state));
            stream.Write(bytes, 0, bytes.Length);
          } finally { stream.Dispose(); }
        } catch (Exception error) {
          referenceFailure = error;
          throw;
        } finally {
          if (referenceCreated) {
            try { File.Delete(reference); } catch (Exception error) {
              error.Data["operation"] = "remove-permission-reference";
              error.Data["path"] = reference;
              if (referenceFailure != null) preparationCleanupErrors.AddRange(ErrorChain(error));
              else throw;
            }
          }
        }
        Console.Out.Write(stage);
        Exit(0);
      }

      Step("read-publication-state", statePath);
      var saved = ReadJson(statePath);
      Step("validate-install-identity", root);
      if (!String.Equals(Text(saved, "root"), root, StringComparison.OrdinalIgnoreCase) ||
          Text(saved, "rootIdentity") != InstallDirectory.Identity(rootHandle))
        throw new IOException("Installation identity changed");
      if (action == "publish" && !String.Equals(Text(saved, "rootAcl"), Descriptor(root, true), StringComparison.Ordinal))
        throw new IOException("Installation permissions changed");
      var savedStage = Path.GetFullPath(Text(saved, "stage"));
      Step("validate-payload-staging", savedStage);
      var savedParent = Flag(saved, "useMove") ? root : Path.GetDirectoryName(Path.GetFullPath(statePath));
      var savedName = Path.GetFileName(savedStage);
      var validName = Flag(saved, "useMove")
        ? System.Text.RegularExpressions.Regex.IsMatch(savedName, @"^\.open-science-install-[a-f0-9]{32}$")
        : savedName == "7z-out";
      if (!String.Equals(Path.GetDirectoryName(savedStage), savedParent, StringComparison.OrdinalIgnoreCase) || !validName)
        throw new IOException("Invalid staging path");
      stageHandle = InstallDirectory.Hold(savedStage);
      if (Text(saved, "stageIdentity") != InstallDirectory.Identity((Microsoft.Win32.SafeHandles.SafeFileHandle)stageHandle))
        throw new IOException("Staging identity changed");
      if (action == "publish" && !String.Equals(Text(saved, "directoryAcl"), Descriptor(savedStage, true), StringComparison.Ordinal))
        throw new IOException("Staging permissions changed");
      AssertOrdinaryTree(savedStage, action == "publish" && Flag(saved, "useMove"), saved, action == "publish");

      if (action == "publish") {
        if (!Flag(saved, "useMove")) Exit(0);
        // Validate the entire extracted payload before the first move. Move only absent top-level
        // directories. A later error leaves the remaining source intact for NSIS retry or cleanup.
        foreach (var name in new[] { "resources", "locales" }) {
          var source = Path.Combine(savedStage, name);
          if (!Directory.Exists(source)) continue;
          var destination = Path.Combine(root, name);
          Step("validate-payload-destination", destination);
          if (Directory.Exists(destination) || File.Exists(destination))
            throw new IOException("Publication destination already exists: " + destination);
          Step("move-payload-directory", source);
          Directory.Move(source, destination);
          Console.Out.WriteLine("Published " + name + " by directory move");
        }
      } else {
        stageHandle.Dispose();
        stageHandle = null;
        Step("remove-payload-staging", savedStage);
#if OPEN_SCIENCE_HELPER_TEST_SEAMS
        if (Environment.GetEnvironmentVariable("OPEN_SCIENCE_PUBLICATION_CLEANUP_FAILURE") == "1")
          throw new IOException("Fixture staging cleanup failure");
#endif
        DeleteTree(Extended(savedStage));
        Step("remove-publication-state", statePath);
        File.Delete(statePath);
        WriteReport(reportPath, Phase(action), "succeeded", new List<object>(), preparationCleanupErrors);
      }
      Exit(0);
    } catch (ExitException) {
      throw;
    } catch (Exception error) {
      var originalErrors = ErrorChain(error);
      Console.Error.WriteLine(error.ToString());
      if (createdStage != null && !File.Exists(statePath)) {
        if (stageHandle != null) { stageHandle.Dispose(); stageHandle = null; }
        // Preparation has not extracted anything. Only remove this empty, exclusively created
        // directory; an unexpected entry keeps it on disk instead of being recursively erased.
        try { Directory.Delete(createdStage, false); } catch (Exception cleanupError) {
          Step("remove-empty-payload-staging", createdStage);
          preparationCleanupErrors.AddRange(ErrorChain(cleanupError));
          Console.Error.WriteLine(cleanupError.ToString());
        }
      }
      WriteReport(reportPath, Phase(action), "failed", originalErrors, preparationCleanupErrors);
      Exit(20);
    } finally {
      if (stageHandle != null) stageHandle.Dispose();
      for (var i = handles.Count - 1; i >= 0; i--) handles[i].Dispose();
    }
  }

  // ---- extraction: windows-extract-payload.ps1 ----

  static string extractionSource = "powershell-extractor";
  static string extractionOperation = "resolve-extraction-lists";
  static string extractionPath = null;

  static List<object> ExtractionChain(Exception error) {
    var hresult = unchecked((uint)error.HResult);
    var record = new Dictionary<string, object>();
    record["operation"] = extractionOperation;
    record["path"] = extractionPath;
    record["errorSource"] = extractionSource;
    record["exceptionType"] = error.GetType().FullName;
    record["message"] = error.Message;
    record["hresult"] = "0x" + hresult.ToString("X8");
    var win32 = error as Win32Exception;
    record["nativeErrorCode"] = win32 != null ? (object)win32.NativeErrorCode : null;
    var records = new List<object>();
    records.Add(record);
    var aggregate = error as AggregateException;
    if (aggregate != null) {
      foreach (var inner in aggregate.InnerExceptions) records.AddRange(ExtractionChain(inner));
    } else if (error.InnerException != null) {
      records.AddRange(ExtractionChain(error.InnerException));
    }
    return records;
  }

  sealed class ExtractorRun {
    public Process Process;
    public System.Threading.Tasks.Task<string> Stdout;
    public System.Threading.Tasks.Task<string> Stderr;
  }

  static ExtractorRun StartExtractor(string extractor, string archive, string target, string selectors) {
    extractionSource = "powershell-extractor";
    extractionOperation = "start-extractor";
    extractionPath = extractor;
    var info = new ProcessStartInfo();
    info.FileName = extractor;
    info.UseShellExecute = false;
    info.CreateNoWindow = true;
    info.RedirectStandardOutput = true;
    info.RedirectStandardError = true;
    info.StandardOutputEncoding = Encoding.UTF8;
    info.StandardErrorEncoding = Encoding.UTF8;
    info.Arguments = "x -y -bd -bso0 -bsp0 -bse1 -sccUTF-8 -spd \"-o" + target + "\" \"" + archive + "\" " + selectors;
    var process = new Process();
    process.StartInfo = info;
    try { process.Start(); } catch { process.Dispose(); throw; }
    // Drain both pipes immediately, including workers we will wait for later. Waiting first can
    // deadlock when either pipe fills; inherited handles lose output under nsExec.
    var run = new ExtractorRun();
    run.Process = process;
    run.Stdout = process.StandardOutput.ReadToEndAsync();
    run.Stderr = process.StandardError.ReadToEndAsync();
    return run;
  }

  static Dictionary<string, object> ExtractorResult(ExtractorRun run, string operationName, string archive) {
    var result = new Dictionary<string, object>();
    result["operation"] = operationName;
    result["errorSource"] = "7za";
    result["toolExitCode"] = run.Process.ExitCode;
    result["archive"] = archive;
    foreach (var name in new[] { "stdout", "stderr" }) {
      var task = name == "stdout" ? run.Stdout : run.Stderr;
      try {
        var text = task.Result;
        // Bound durable evidence, not the pipe reader: all children must still be drained.
        result[name] = text.Length > 16384 ? text.Substring(0, 16384) : text;
        result[name + "Truncated"] = text.Length > 16384;
      } catch (Exception readError) {
        // Diagnostic capture must not replace the proven tool exit with a secondary read error.
        var inner = readError.InnerException ?? readError;
        result[name + "ReadError"] = inner.Message;
      }
    }
        return result;
  }

  static void Extract(string extractor, string archive, string target, string listDirectory, string reportPath) {
    extractionPath = listDirectory;
    var toolFailures = new List<object>();
    var errors = new List<object>();
    var childErrors = new List<object>();
    try {
      // Create archive directories first, including empty ones, so the file workers do not race on
      // directory creation. Exclude every file: parent-directory selectors are recursive.
      var directories = Path.Combine(listDirectory, "all-directories.txt");
      var files = Path.Combine(listDirectory, "all-files.txt");
      var directoryRun = StartExtractor(extractor, archive, target, "\"-i@" + directories + "\" \"-x@" + files + "\"");
      try {
        extractionOperation = "wait-extractor";
        extractionPath = extractor;
        directoryRun.Process.WaitForExit();
        var directoryResult = ExtractorResult(directoryRun, "extract-directories", archive);
        if (directoryRun.Process.ExitCode != 0) {
          toolFailures.Add(directoryResult);
          extractionSource = "7za";
          extractionOperation = "extract-directories";
          extractionPath = null;
          throw new IOException("Directory extraction failed: " + directoryRun.Process.ExitCode);
        }
      } finally { directoryRun.Process.Dispose(); }

      var children = new List<ExtractorRun>();
      Exception failure = null;
      string failureSource = null;
      try {
        for (var index = 0; index < 2; index++) {
          var list = Path.Combine(listDirectory, "files-2-" + index + ".txt");
          extractionSource = "powershell-extractor";
          extractionOperation = "read-extraction-list";
          extractionPath = list;
          // An empty partition must not be interpreted as an unrestricted archive selector.
          if (new FileInfo(list).Length == 0) continue;
          children.Add(StartExtractor(extractor, archive, target, "\"-i@" + list + "\""));
        }
      } catch (Exception error) {
        // Capture the original failure before draining children changes the diagnostic context.
        failure = error;
        failureSource = extractionSource;
        errors = ExtractionChain(error);
      } finally {
        // Even if starting a later child fails, wait for all earlier children before NSIS may
        // clean up staging. Nonzero warning exits are failures as well as fatal errors.
        foreach (var child in children) {
          try {
            extractionSource = "powershell-extractor";
            extractionOperation = "wait-extractor";
            extractionPath = extractor;
            child.Process.WaitForExit();
#if OPEN_SCIENCE_HELPER_TEST_SEAMS
            if (Environment.GetEnvironmentVariable("OPEN_SCIENCE_EXTRACT_WAIT_FAILURE") == "1")
              throw new Win32Exception(6);
#endif
            var childResult = ExtractorResult(child, "extract-files", archive);
            if (child.Process.ExitCode != 0) {
              toolFailures.Add(childResult);
              extractionSource = "7za";
              extractionOperation = "extract-files";
              extractionPath = null;
              throw new IOException("File extraction failed: " + child.Process.ExitCode);
            }
          } catch (Exception error) {
            if (failure == null) {
              failure = error;
              failureSource = extractionSource;
              errors = ExtractionChain(error);
            } else {
              childErrors.AddRange(ExtractionChain(error));
            }
          } finally { child.Process.Dispose(); }
        }
      }
      if (failure != null) { extractionSource = failureSource; throw failure; }
    } catch (Exception error) {
      if (reportPath != null) {
        try {
          if (errors.Count == 0) errors = ExtractionChain(error);
          var report = new Dictionary<string, object>();
          report["phase"] = "extract-new-program-files";
          report["status"] = "failed";
          report["errorSource"] = extractionSource;
          report["archive"] = archive;
          report["target"] = target;
          report["errors"] = errors;
          report["toolFailures"] = toolFailures;
          report["childErrors"] = childErrors;
          WriteJson(reportPath, report);
        } catch (Exception reportError) {
          Console.Error.WriteLine("Could not save extraction diagnostic: " + reportError.Message);
        }
      }
      throw;
    }
  }
}
