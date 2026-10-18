// Isolated native-window/process fixture. Never reads or changes an installed application.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
class Program {
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  static string root = Environment.GetEnvironmentVariable("OPEN_SCIENCE_PROGRESS_FIXTURE");
  static void Write(string name, string value) { File.WriteAllText(Path.Combine(root, name), value); }
  static void Wait(string name) {
    var limit = DateTime.UtcNow.AddSeconds(90);
    while (!File.Exists(Path.Combine(root, name))) {
      if (File.Exists(Path.Combine(root, "cancel-fixture"))) throw new OperationCanceledException("Fixture cancelled");
      if (DateTime.UtcNow > limit) throw new Exception("Fixture barrier timed out: " + name);
      Thread.Sleep(20);
    }
  }
  [STAThread] static int Main(string[] args) {
    try {
      if (args[0] == "inspect") {
        try { using (var process = Process.GetProcessById(int.Parse(args[1]))) {
            // Retain the identity before checking the window: the process may exit
            // between enumeration and MainWindowHandle. Absence still requires
            // confirmation from this handle; other inspection errors remain fatal.
            try {
              var handle = process.Handle;
              Console.WriteLine(process.HasExited ? "absent" : IsWindowVisible(process.MainWindowHandle) ? "visible" : "hidden");
            } catch (InvalidOperationException) {
              if (!process.HasExited) throw;
              Console.WriteLine("absent");
            }
          }
        } catch (ArgumentException) { Console.WriteLine("absent"); }
        return 0;
      }
      if (args[0] == "close") {
        using (var process = Process.GetProcessById(int.Parse(args[1]))) {
          if (!process.CloseMainWindow()) throw new Exception("Owned fixture window rejected close");
        }
        return 0;
      }
      if (args[0] == "installer") {
        Write("installer-ready", Process.GetCurrentProcess().Id.ToString());
        Wait("release-new-process");
        if (Environment.GetEnvironmentVariable("OPEN_SCIENCE_PROGRESS_SCENARIO") == "installer-failure") return 23;
        using (var child = Process.Start(new ProcessStartInfo(Path.Combine(root, "installation", "application.exe"), "app") { UseShellExecute = false })) {
          Write("successor-pid", child.Id.ToString());
        }
        return 0;
      }
      var pid = Process.GetCurrentProcess().Id.ToString();
      if (args[0] == "app") { Write("app-started", pid); Wait("release-window"); }
      Application.EnableVisualStyles();
      using (var form = new Form()) {
        form.Text = "PR3599 isolated successor " + args[0];
        form.Shown += (s, e) => Write(args[0] + "-visible", pid);
        using (var timer = new System.Windows.Forms.Timer()) {
          timer.Interval = 50;
          timer.Tick += (s, e) => { if (File.Exists(Path.Combine(root, "close-" + pid)) || File.Exists(Path.Combine(root, "cancel-fixture"))) form.Close(); };
          timer.Start(); Application.Run(form);
        }
      }
      return 0;
    } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
  }
}
