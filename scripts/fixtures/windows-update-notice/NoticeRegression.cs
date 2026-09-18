// An opt-in native installer test, not an application helper. Observes real Win32 dialogs
// belonging only to the child installer. The elevation variant substitutes only the
// external UAC request; it observes the actual NSIS cancellation path without granting rights.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32;

class NoticeRegression {
  const string Name = "open-science-update-notice-test";
  const string Guid = "11f7eae6-e7e3-4c1c-931f-2a9b1df095ea";
  delegate bool WindowCallback(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, WindowCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr window, int id);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

  static void Require(bool value, string message) { if (!value) throw new Exception(message); }
  static Process Start(string file, string arguments) {
    return Process.Start(new ProcessStartInfo(file, arguments) { UseShellExecute = false, CreateNoWindow = true });
  }
  static int Finish(Process process) {
    Require(process.WaitForExit(30000), "Installer did not finish within 30 seconds.");
    return process.ExitCode;
  }
  static int Run(string file, string arguments) { using (var process = Start(file, arguments)) return Finish(process); }
  static IntPtr Dialog(Process process) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((window, _) => {
      uint pid; GetWindowThreadProcessId(window, out pid);
      if (pid == process.Id && IsWindowVisible(window) &&
          (GetDlgItem(window, 1) != IntPtr.Zero || GetDlgItem(window, 2) != IntPtr.Zero)) found = window;
      return true;
    }, IntPtr.Zero);
    return found;
  }
  static string Text(IntPtr dialog) {
    var result = new StringBuilder();
    EnumChildWindows(dialog, (window, _) => {
      var text = new StringBuilder(4096);
      GetWindowText(window, text, text.Capacity);
      result.AppendLine(text.ToString());
      return true;
    }, IntPtr.Zero);
    return result.ToString();
  }
  static IntPtr WaitForNotice(Process process) {
    var timer = Stopwatch.StartNew();
    while (timer.ElapsedMilliseconds < 10000) {
      var dialog = Dialog(process);
      if (dialog != IntPtr.Zero) return dialog;
      if (process.HasExited) throw new Exception("Installer exited with code " + process.ExitCode + " without showing an update failure notice; the user can only reopen the old version.");
      Thread.Sleep(30);
    }
    throw new Exception("No update failure notice appeared within 10 seconds.");
  }
  static void Click(IntPtr dialog, int id) {
    Require(GetDlgItem(dialog, id) != IntPtr.Zero, "Expected notice button " + id + " was absent.");
    Require(PostMessage(dialog, 0x0111, new IntPtr(id), IntPtr.Zero), "Could not invoke notice button.");
  }

  static int Main(string[] args) {
    string install = null, uninstaller = null, protectedFile = null, originalAcl = null, machineDirectory = null;
    const string MachineHive = "Software\\" + Guid + "-machine-hive";
    bool createdMachineHive = false;
    FileStream held = null;
    Process updater = null;
    try {
      var fixture = Path.GetFullPath(args[0]);
      var scenario = args[1];
      bool elevation = scenario.Contains("elevation");
      bool currentUser = scenario == "denied-currentuser";
      bool elevatedTarget = scenario == "denied-elevated-target";
      bool writable = scenario == "writable";
      var elevationMarker = Path.Combine(Path.GetTempPath(), "elevation-requested");
      Require(!File.Exists(elevationMarker), "Previous elevation marker exists; inspect it before running.");
      foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine }) {
        using (var key = hive.OpenSubKey("Software\\" + Guid)) Require(key == null, "Previous test registration exists; inspect it before running.");
      }
      using (var key = Registry.CurrentUser.OpenSubKey(MachineHive))
        Require(key == null, "Previous simulated machine hive exists; inspect it before running.");
      install = Path.Combine(fixture, "installed");
      Require(!Directory.Exists(install) || Directory.GetFileSystemEntries(install).Length == 0, "Test install directory must be empty.");
      Directory.CreateDirectory(install);
      var previous = Path.Combine(fixture, "0.25.1", "dist", "notice-fixture-installer.exe");
      var current = Path.Combine(fixture, elevatedTarget ? "elevated-preflight" : elevation || currentUser ? "elevation" : "0.26.0", "dist", "notice-fixture-installer.exe");
      Require(Run(previous, "/S /D=" + install) == 0, "Fixture install failed.");
      var executable = Path.Combine(install, Name + ".exe");
      uninstaller = Path.Combine(install, "Uninstall " + Name + ".exe");
      protectedFile = uninstaller;
      if (elevatedTarget) {
        var candidateDirectory = Path.Combine(fixture, "machine-installed");
        Require(!Directory.Exists(candidateDirectory), "Simulated machine install already exists.");
        Directory.CreateDirectory(candidateDirectory);
        machineDirectory = candidateDirectory;
        protectedFile = Path.Combine(machineDirectory, Path.GetFileName(uninstaller));
        File.Copy(uninstaller, protectedFile);
        using (var key = Registry.CurrentUser.CreateSubKey(MachineHive + "\\Software\\" + Guid)) {
          createdMachineHive = true;
          key.SetValue("InstallLocation", machineDirectory);
        }
      }
      Require(Run(executable, "") == 25, "Previous version was not launchable.");
      bool denied = scenario.StartsWith("denied");
      bool silent = scenario.EndsWith("silent");
      bool retry = scenario == "locked-retry";
      if (denied) {
        var original = File.GetAccessControl(protectedFile);
        foreach (FileSystemAccessRule rule in original.GetAccessRules(true, false, typeof(SecurityIdentifier)))
          Require(rule.IsInherited, "Fixture must have an inherited DACL for safe restoration.");
        Require(!original.AreAccessRulesProtected, "Fixture DACL must not be protected.");
        originalAcl = original.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
        var acl = new FileSecurity();
        acl.SetAccessRuleProtection(true, false);
        foreach (var sid in new[] { "S-1-5-18", "S-1-5-32-544" })
          acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, AccessControlType.Allow));
        acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-5-32-545"), FileSystemRights.ReadAndExecute, AccessControlType.Allow));
        File.SetAccessControl(protectedFile, acl);
        bool refused = false;
        try { using (File.Open(protectedFile, FileMode.Open, FileAccess.Write, FileShare.Read)) {} }
        catch (UnauthorizedAccessException) { refused = true; }
        Require(refused, "Permission fixture needs a non-elevated process; write probe unexpectedly succeeded.");
      } else if (!writable) {
        held = File.Open(uninstaller, FileMode.Open, FileAccess.Read, FileShare.Read);
      }
      var nestedData = Path.Combine(install, "OpenScience", "sentinel.txt");
      if (scenario.EndsWith("-data")) {
        Directory.CreateDirectory(Path.GetDirectoryName(nestedData));
        File.WriteAllText(nestedData, "keep original data");
      }
      updater = Start(current, "/S --updated " + (elevation ? "/allusers " : currentUser ? "/currentuser " : "") + (silent || writable ? "" : "--force-run ") + (elevatedTarget ? "" : "/D=" + install));
      if (elevation) {
        string notice = "";
        var timer = Stopwatch.StartNew();
        while (!updater.HasExited && timer.ElapsedMilliseconds < 10000) {
          var dialog = Dialog(updater);
          if (dialog != IntPtr.Zero) { notice = Text(dialog); Click(dialog, 2); break; }
          Thread.Sleep(30);
        }
        int exit = Finish(updater);
        Require(File.Exists(elevationMarker), "Installer rejected the protected file before requesting UAC; exit=" + exit + "\n" + notice);
        if (scenario.EndsWith("-data"))
          Require(File.ReadAllText(elevationMarker).Contains("data-in-place"), "Outer installer moved user data before UAC approval.");
        File.Delete(elevationMarker);
        Require(exit == 1223, "Installer did not preserve UAC cancellation exit status.");
        if (scenario.EndsWith("-data")) {
          Require(File.ReadAllText(nestedData) == "keep original data", "Cancellation changed nested user data.");
          File.Delete(nestedData);
          Directory.Delete(Path.GetDirectoryName(nestedData));
        }
      } else if (writable) {
        Require(Finish(updater) == 0, "Writable current-user upgrade failed.");
      } else if (silent) {
        Require(Finish(updater) == 2, "Unattended update must fail silently with exit 2.");
      } else {
        var dialog = WaitForNotice(updater);
        var text = Text(dialog);
        Console.WriteLine(text);
        Require(text.Contains(protectedFile), "Notice did not identify the final installation target.");
        Require(text.Contains(denied ? "Windows error: 5" : "Windows error: 32"), "Notice omitted the actual Windows error.");
        Require(text.Contains(denied ? "administrator" : "Retry"), "Notice did not explain recovery.");
        // Local screenshot mode leaves the real dialog available for Computer Use.
        if (args.Length > 2 && args[2] == "--inspect") {
          Console.WriteLine("NOTICE_READY_FOR_SCREENSHOT");
          Require(updater.WaitForExit(180000), "Screenshot inspection timed out.");
        } else if (retry) {
          held.Dispose(); held = null;
          Click(dialog, 4);
        } else Click(dialog, 2); // Windows gives a single OK button IDCANCEL, as well as Cancel.
        Require(Finish(updater) == (retry ? 0 : 2), "Unexpected installer result after notice action.");
      }
      Require(!File.Exists(elevationMarker), "Current-user update unexpectedly requested elevation.");
      Require(Run(executable, "") == (retry || writable ? 26 : 25), "Notice action left the wrong app version.");
      Console.WriteLine("PASS: " + scenario);
      return 0;
    } catch (Exception error) {
      Console.Error.WriteLine(error.Message);
      return 1;
    } finally {
      if (updater != null) { if (!updater.HasExited) { updater.Kill(); updater.WaitForExit(); } updater.Dispose(); }
      if (held != null) held.Dispose();
      if (originalAcl != null) {
        Require(Run("icacls.exe", "\"" + protectedFile + "\" /reset") == 0, "Could not restore fixture DACL.");
        Require(File.GetAccessControl(protectedFile).GetSecurityDescriptorSddlForm(AccessControlSections.Access) == originalAcl, "Fixture DACL was not restored exactly.");
      }
      if (createdMachineHive) Registry.CurrentUser.DeleteSubKeyTree(MachineHive);
      if (machineDirectory != null && Directory.Exists(machineDirectory)) {
        File.Delete(Path.Combine(machineDirectory, "Uninstall " + Name + ".exe"));
        Directory.Delete(machineDirectory);
      }
      if (uninstaller != null && File.Exists(uninstaller)) {
        Require(Run(uninstaller, "/S /currentuser _?=" + install) == 0, "Fixture uninstall failed.");
        File.Delete(uninstaller);
      }
    }
  }
}
