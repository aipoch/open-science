using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

// Native implementation of installer failure diagnostics. The NSIS failure path invokes this
// through the already-staged install or uninstall helper, so recording and finalizing a report do
// not pay for another powershell.exe startup.
public static class InstallDiagnostics {
  static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer();

  public static void Run(Dictionary<string, string> options) {
    Console.OutputEncoding = Encoding.Unicode;
    var action = Required(options, "action");
    if (action == "record") Record(options);
    else if (action == "finalize") Finalize(options);
    else throw new ArgumentException("Unknown diagnostics action: " + action);
  }

  static string Required(Dictionary<string, string> options, string name) {
    string value;
    if (!options.TryGetValue(name, out value) || value.Length == 0)
      throw new ArgumentException("Missing --" + name + ".");
    return value;
  }

  static string Optional(Dictionary<string, string> options, string name, string fallback = null) {
    string value;
    return options.TryGetValue(name, out value) ? value : fallback;
  }

  static Dictionary<string, object> ReadReport(string path) {
    if (string.IsNullOrEmpty(path) || !File.Exists(path)) return null;
    try {
      var value = Serializer.DeserializeObject(File.ReadAllText(path));
      var report = value as Dictionary<string, object>;
      if (report == null) throw new InvalidDataException("Expected a JSON object: " + path);
      return report;
    } catch (Exception error) {
      Console.Error.WriteLine("Could not read cleanup diagnostic: " + error.Message);
      return null;
    }
  }

  static object Field(Dictionary<string, object> values, string name) {
    object value;
    return values != null && values.TryGetValue(name, out value) ? value : null;
  }

  static void Set(Dictionary<string, object> values, string name, object value) {
    values[name] = value;
  }

  static string Text(object value) {
    if (value == null) return "";
    if (value is bool) return (bool)value ? "True" : "False";
    return Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture);
  }

  static bool Truthy(object value) {
    if (value == null) return false;
    if (value is bool) return (bool)value;
    if (value is string) return ((string)value).Length > 0;
    decimal number;
    return Decimal.TryParse(Text(value), System.Globalization.NumberStyles.Float,
      System.Globalization.CultureInfo.InvariantCulture, out number) && number != 0;
  }

  static bool EqualsText(object value, string expected) {
    return value != null && string.Equals(Text(value), expected, StringComparison.OrdinalIgnoreCase);
  }

  static bool NumberEquals(object value, long expected) {
    decimal number;
    return value != null && Decimal.TryParse(Text(value), System.Globalization.NumberStyles.Float,
      System.Globalization.CultureInfo.InvariantCulture, out number) && number == expected;
  }

  static object NumberOrNull(string value) {
    long number;
    return !string.IsNullOrEmpty(value) && Int64.TryParse(value, out number) && number >= 0 ? (object)number : null;
  }

  static IEnumerable<object> Items(object value) {
    var enumerable = value as IEnumerable;
    if (enumerable == null || value is string) yield break;
    foreach (var item in enumerable) yield return item;
  }

  static List<object> ArrayValue(object value) {
    return value == null ? new List<object>() : Items(value).ToList();
  }

  static void WriteReport(string path, Dictionary<string, object> report) {
    File.WriteAllText(path, PrettyJson(report), new UTF8Encoding(false));
  }

  // ConvertTo-Json uses four-space indentation and two spaces after each property colon. Keep
  // that presentation in reports and durable logs so consumers that show the raw diagnostic do
  // not see a formatting change when the native helper replaces PowerShell.
  static string PrettyJson(object value) {
    var output = new StringBuilder();
    AppendPrettyJson(output, value, 0);
    return output.ToString();
  }

  static void AppendPrettyJson(StringBuilder output, object value, int indent) {
    if (value == null) { output.Append("null"); return; }
    var text = value as string;
    if (text != null) { output.Append(Serializer.Serialize(text)); return; }
    if (value is bool) { output.Append((bool)value ? "true" : "false"); return; }
    var dictionary = value as IDictionary;
    if (dictionary != null) {
      if (dictionary.Count == 0) { output.Append("{}"); return; }
      output.Append("{\r\n");
      var entries = new List<DictionaryEntry>();
      var enumerator = dictionary.GetEnumerator();
      while (enumerator.MoveNext()) entries.Add(enumerator.Entry);
      for (var index = 0; index < entries.Count; index++) {
        output.Append(new string(' ', (indent + 1) * 4));
        output.Append(Serializer.Serialize(Convert.ToString(entries[index].Key, System.Globalization.CultureInfo.InvariantCulture)));
        output.Append(":  ");
        AppendPrettyJson(output, entries[index].Value, indent + 1);
        if (index + 1 < entries.Count) output.Append(",");
        output.Append("\r\n");
      }
      output.Append(new string(' ', indent * 4));
      output.Append("}");
      return;
    }
    if (value is IEnumerable) {
      var items = Items(value).ToList();
      if (items.Count == 0) { output.Append("[]"); return; }
      output.Append("[\r\n");
      for (var index = 0; index < items.Count; index++) {
        output.Append(new string(' ', (indent + 1) * 4));
        AppendPrettyJson(output, items[index], indent + 1);
        if (index + 1 < items.Count) output.Append(",");
        output.Append("\r\n");
      }
      output.Append(new string(' ', indent * 4));
      output.Append("]");
      return;
    }
    var formattable = value as IFormattable;
    output.Append(formattable == null
      ? Serializer.Serialize(Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture))
      : formattable.ToString(null, System.Globalization.CultureInfo.InvariantCulture));
  }

  static void Record(Dictionary<string, string> options) {
    var reportPath = Optional(options, "report-path");
    var report = ReadReport(reportPath);
    try {
      if (report == null) {
        report = new Dictionary<string, object>();
        Set(report, "timestamp", DateTime.UtcNow.ToString("o"));
        Set(report, "phase", Optional(options, "phase", "remove-old-program-files"));
        Set(report, "status", "failed");
        Set(report, "deletionCancellation", "unknown");
        Set(report, "attributeRestoration", "unknown");
        Set(report, "fileMoveBack", "unknown");
        Set(report, "errors", new object[0]);
      }
      var logPhase = Optional(options, "phase", "remove-old-program-files");
      if (logPhase != "remove-old-program-files") Set(report, "phase", logPhase);
      var errorSource = Optional(options, "error-source");
      if (!string.IsNullOrEmpty(errorSource)) {
        if (errorSource != "powershell-extractor" || !Truthy(Field(report, "errorSource")))
          Set(report, "errorSource", errorSource);
        Set(report, "exitCode", Optional(options, "exit-code"));
        Set(report, "exitCodeSource", errorSource);
        Set(report, "installationIncomplete", true);
        if (!report.ContainsKey("diagnosticId")) Set(report, "diagnosticId", Guid.NewGuid().ToString("N"));
      }
      var outputPath = Optional(options, "output-path");
      if (!string.IsNullOrEmpty(outputPath) && File.Exists(outputPath)) {
        var output = File.ReadAllText(outputPath, Encoding.Unicode);
        Set(report, "output", output);
        if (errorSource == "robocopy") {
          var copyErrors = new List<object>();
          var pattern = new Regex("(?m)^.*\\(0x([0-9A-Fa-f]{8})\\)[^\\r\\n]*?([A-Za-z]:\\\\[^\\r\\n]+)");
          foreach (Match match in pattern.Matches(output)) {
            var error = new Dictionary<string, object>();
            Set(error, "operation", "copy-payload-entry");
            Set(error, "path", match.Groups[2].Value.TrimEnd());
            Set(error, "errorSource", "robocopy-reported-win32");
            Set(error, "windowsErrorCode", Convert.ToUInt32(match.Groups[1].Value, 16));
            Set(error, "nativeErrorCode", null);
            Set(error, "message", match.Value);
            copyErrors.Add(error);
          }
          Set(report, "errors", copyErrors.ToArray());
        }
      }
      var operation = Optional(options, "operation");
      if (!string.IsNullOrEmpty(operation)) {
        var nativeCode = NumberOrNull(Optional(options, "native-error-code"));
        var evidence = new Dictionary<string, object>();
        Set(evidence, "operation", operation);
        Set(evidence, "path", Optional(options, "failed-path"));
        Set(evidence, "exceptionType", null);
        Set(evidence, "hresult", null);
        Set(evidence, "nativeErrorCode", nativeCode);
        Set(evidence, "message", nativeCode == null
          ? "NSIS reported a failed operation; native error unavailable."
          : new System.ComponentModel.Win32Exception(Convert.ToInt32(nativeCode)).Message);
        if (Optional(options, "move-back", "unknown") == "unknown") {
          var errors = ArrayValue(Field(report, "errors"));
          errors.Add(evidence);
          Set(report, "errors", errors.ToArray());
        } else Set(report, "moveBackError", evidence);
      }
      var moveBack = Optional(options, "move-back", "unknown");
      if (moveBack != "unknown") Set(report, "fileMoveBack", moveBack);
      if (!string.IsNullOrEmpty(reportPath)) WriteReport(reportPath, report);
    } catch (Exception error) {
      Console.Error.WriteLine("Could not save cleanup diagnostic: " + error.Message);
    }
  }

  static void Finalize(Dictionary<string, string> options) {
    var reportPath = Optional(options, "report-path");
    var report = ReadReport(reportPath);
    var outcome = Optional(options, "outcome", "failed");
    if (report != null && outcome == "recovered") {
      Set(report, "finalOutcome", "recovered");
      Set(report, "installationIncomplete", false);
      Set(report, "status", "recovered");
      try { if (!string.IsNullOrEmpty(reportPath)) WriteReport(reportPath, report); }
      catch (Exception error) { Console.Error.WriteLine("Could not update recovered installer diagnostic: " + error.Message); }
    }

    string savedPath = null;
    try {
      var logDirectory = Optional(options, "log-directory");
      if (string.IsNullOrEmpty(logDirectory))
        logDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Open-Science\\logs\\installer");
      Directory.CreateDirectory(logDirectory);
      var id = Text(Field(report, "diagnosticId"));
      if (!Regex.IsMatch(id, "^[a-f0-9]{32}$")) id = Guid.NewGuid().ToString("N");
      var candidate = Path.Combine(logDirectory, "install-failure-" + id + ".log");
      var appVersion = Optional(options, "app-version", "unknown");
      var productName = Optional(options, "product-name", "Open-Science");
      var phase = Optional(options, "phase", "remove-old-program-files");
      var exitCode = Optional(options, "exit-code");
      var text = productName + " installer diagnostic\r\nversion=" + appVersion + "\r\ntime=" + DateTime.UtcNow.ToString("o") +
        "\r\nphase=" + phase + "\r\nexitCode=" + exitCode + "\r\noutcome=" + outcome +
        "\r\ninstallPath=" + Optional(options, "install-path") + "\r\nfinalReport=" + reportPath + "\r\n";
      var cleanupExit = Optional(options, "cleanup-exit-code");
      if (!string.IsNullOrEmpty(cleanupExit)) text += "temporaryCleanupExitCode=" + cleanupExit + "\r\n";
      var reportsDirectory = Optional(options, "reports-directory");
      if (!string.IsNullOrEmpty(reportsDirectory) && Directory.Exists(reportsDirectory)) {
        foreach (var path in Directory.GetFiles(reportsDirectory, "cleanup-attempt-*.json").OrderBy(path => path, StringComparer.Ordinal))
          text += "\r\n--- " + Path.GetFileName(path) + " ---\r\n" + File.ReadAllText(path) + "\r\n";
      }
      if (report != null && (string.IsNullOrEmpty(reportsDirectory) ||
          !string.Equals(Path.GetDirectoryName(reportPath), reportsDirectory, StringComparison.OrdinalIgnoreCase) ||
          !Path.GetFileName(reportPath).StartsWith("cleanup-attempt-", StringComparison.OrdinalIgnoreCase) ||
          !Path.GetFileName(reportPath).EndsWith(".json", StringComparison.OrdinalIgnoreCase)))
        text += PrettyJson(report);
      if (report == null) text += "\r\nFinal child report missing or unreadable. Recovery state unknown.\r\n";
      var cleanupReport = Optional(options, "cleanup-report-path");
      if (!string.IsNullOrEmpty(cleanupReport) && File.Exists(cleanupReport))
        text += "\r\n--- Temporary payload cleanup (independent of original failure) ---\r\n" + File.ReadAllText(cleanupReport) + "\r\n";
      var cleanupOutput = Optional(options, "cleanup-output-path");
      if (!string.IsNullOrEmpty(cleanupOutput) && File.Exists(cleanupOutput))
        text += "\r\n--- Temporary payload cleanup output ---\r\n" + File.ReadAllText(cleanupOutput, Encoding.Unicode) + "\r\n";
      File.WriteAllText(candidate, text, new UTF8Encoding(false));
      if (File.Exists(candidate)) savedPath = candidate;
    } catch (Exception error) {
      Console.Error.WriteLine("Could not save persistent installer diagnostic: " + error.Message);
    }

    var errors = new List<Dictionary<string, object>>();
    foreach (var item in ArrayValue(Field(report, "errors"))) {
      var error = item as Dictionary<string, object>;
      if (error != null && Truthy(Field(error, "operation"))) errors.Add(error);
    }
    var failure = errors.FirstOrDefault();
    var file = failure == null ? null : Text(Field(failure, "path"));
    if (!string.IsNullOrEmpty(file)) file = Path.GetFileName(file);
    if (file != null && file.Length > 80) file = file.Substring(0, 77) + "...";
    var incomplete = report != null && (EqualsText(Field(report, "deletionCancellation"), "failed") ||
      EqualsText(Field(report, "attributeRestoration"), "failed") || EqualsText(Field(report, "fileMoveBack"), "failed"));
    var unknown = report == null || EqualsText(Field(report, "fileMoveBack"), "unknown");
    var code = failure == null ? null : Field(failure, "nativeErrorCode");
    var source = Truthy(Field(report, "errorSource")) ? Text(Field(report, "errorSource")) :
      (Optional(options, "phase", "remove-old-program-files") == "remove-old-program-files" ? "uninstaller" : "installer");
    var result = Truthy(Field(report, "exitCode")) ? Text(Field(report, "exitCode")) : Optional(options, "exit-code");
    if (report != null && source == "7za") {
      foreach (var item in ArrayValue(Field(report, "toolFailures"))) {
        var toolFailure = item as Dictionary<string, object>;
        if (toolFailure != null && EqualsText(Field(toolFailure, "errorSource"), source) && Field(toolFailure, "toolExitCode") != null) {
          source = Text(Field(toolFailure, "errorSource"));
          result = Text(Field(toolFailure, "toolExitCode"));
          break;
        }
      }
    }
    var language = Optional(options, "language", "1033");
    var sourceResult = "";
    if (!string.IsNullOrEmpty(result)) sourceResult = language == "2052"
      ? "错误来源：" + source + "；结果：" + result + "。"
      : language == "1028" ? "錯誤來源：" + source + "；結果：" + result + "。"
      : "Error source: " + source + "; result: " + result + ".";
    var title = productTitle(options) + " could not finish updating.";
    var reason = "Windows could not remove the old application files.";
    var advice = "Check the reported path, available disk space and security software records, then run the official installer again.";
    if (NumberEquals(code, 32) || NumberEquals(code, 33)) {
      reason = "An application file is in use.";
      advice = "Close tasks using this file and run the installer again. If it persists, restart Windows and retry.";
    } else if (NumberEquals(code, 5)) {
      reason = "Windows denied access to an application file.";
      advice = "Check access permissions and security software records. Use administrator access only if this installation folder requires it.";
    }
    var recovery = "";
    if (incomplete) {
      recovery = "Old files were not fully restored.";
      advice = "Keep the diagnostic and remaining temporary files, and contact support. The application may not start.";
    } else if (unknown) {
      recovery = "Restoration of old files could not be confirmed.";
      advice = "Keep the diagnostic and remaining temporary files, and contact support before removing them.";
    }
    var log = savedPath == null ? "The diagnostic could not be saved." : "Diagnostic: " + savedPath;
    if (language == "2052") {
      title = productTitle(options) + " 未能完成更新。";
      reason = "Windows 无法清理旧应用文件。";
      advice = "请检查所报路径、磁盘空间和安全软件记录，然后重新运行官方安装包。";
      if (NumberEquals(code, 32) || NumberEquals(code, 33)) {
        reason = "应用文件正在被占用。";
        advice = "请关闭使用此文件的任务后重新运行安装包。若仍失败，请重启 Windows 后重试。";
      } else if (NumberEquals(code, 5)) {
        reason = "Windows 拒绝访问应用文件。";
        advice = "请检查访问权限及安全软件记录。仅在安装目录需要管理员权限时，以管理员身份运行。";
      }
      if (incomplete) {
        recovery = "旧应用文件未能完整恢复。";
        advice = "请保留诊断和剩余暂存文件，并联系支持。应用可能无法启动。";
      } else if (unknown) {
        recovery = "无法确认旧应用文件是否已恢复。";
        advice = "请保留诊断和剩余暂存文件，联系支持后再处理。";
      }
      log = savedPath == null ? "诊断未能保存。" : "诊断文件：" + savedPath;
    } else if (language == "1028") {
      title = productTitle(options) + " 未能完成更新。";
      reason = "Windows 無法清理舊應用程式檔案。";
      advice = "請檢查所報路徑、磁碟空間和安全軟體記錄，然後重新執行官方安裝程式。";
      if (NumberEquals(code, 32) || NumberEquals(code, 33)) {
        reason = "應用程式檔案正在使用中。";
        advice = "請關閉使用此檔案的工作後重新執行安裝程式。若仍失敗，請重新啟動 Windows 後再試。";
      } else if (NumberEquals(code, 5)) {
        reason = "Windows 拒絕存取應用程式檔案。";
        advice = "請檢查存取權限及安全軟體記錄。僅在安裝目錄需要管理員權限時，以管理員身分執行。";
      }
      if (incomplete) {
        recovery = "舊應用程式檔案未能完整還原。";
        advice = "請保留診斷和剩餘暫存檔案，並聯絡支援。應用程式可能無法啟動。";
      } else if (unknown) {
        recovery = "無法確認舊應用程式檔案是否已還原。";
        advice = "請保留診斷和剩餘暫存檔案，聯絡支援後再處理。";
      }
      log = savedPath == null ? "診斷未能儲存。" : "診斷檔案：" + savedPath;
    }
    var fallback = !(NumberEquals(code, 5) || NumberEquals(code, 32) || NumberEquals(code, 33)) ? sourceResult : "";
    var failurePhase = Optional(options, "phase", "remove-old-program-files");
    var message = new List<string> { title, recovery, reason, fallback, file, advice, log };
    if (failurePhase.EndsWith("-new-program-files", StringComparison.Ordinal) || failurePhase == "cleanup-payload-staging") {
      var windowsFailure = errors.FirstOrDefault(error => Field(error, "nativeErrorCode") != null || Field(error, "windowsErrorCode") != null);
      var windowsCode = windowsFailure == null ? null : Field(windowsFailure, "nativeErrorCode") ?? Field(windowsFailure, "windowsErrorCode");
      var cause = "";
      var stage = failurePhase == "prepare-new-program-files" ? "preparing the new application files" :
        failurePhase == "extract-new-program-files" ? "extracting the new application files" :
        failurePhase == "publish-new-program-files" ? "publishing the new application files" :
        failurePhase == "copy-new-program-files" ? "copying the new application files" : "removing the temporary payload files";
      reason = "Failed while " + stage + ".";
      advice = "Check the reported path, available disk space and security software records, then run the same official installer again. If the archive is damaged, download it again from the official source.";
      var state = "Installation is incomplete. The application may not start.";
      if (NumberEquals(windowsCode, 32) || NumberEquals(windowsCode, 33)) {
        cause = "Windows reports that an application file or directory is in use.";
        advice = "Close tasks using this file or directory, then run the same official installer again. If it persists, restart Windows and retry.";
      } else if (NumberEquals(windowsCode, 5)) {
        cause = "Windows denied access to the reported path.";
        advice = "Check access permissions and security software records, then run the same official installer again. Use administrator access only if this folder requires it.";
      } else if (NumberEquals(windowsCode, 112)) {
        cause = "Windows reports insufficient disk space.";
        advice = "Free space on the installation and temporary-file drives, then run the same official installer again.";
      }
      if (language == "2052") {
        stage = failurePhase == "prepare-new-program-files" ? "准备新应用文件" : failurePhase == "extract-new-program-files" ? "解压新应用文件" :
          failurePhase == "publish-new-program-files" ? "发布新应用文件" : failurePhase == "copy-new-program-files" ? "复制新应用文件" : "清理临时安装文件";
        reason = stage + " 时失败。";
        state = "安装尚未完成，应用可能无法启动。";
        advice = "请检查所报路径、磁盘空间及安全软件记录，解决问题后重新运行同一个官方安装包。如安装包损坏，请从官方来源重新下载。";
        if (NumberEquals(windowsCode, 32) || NumberEquals(windowsCode, 33)) {
          cause = "Windows 报告应用文件或目录正在被占用。";
          advice = "请关闭使用此文件或目录的任务，然后重新运行同一个官方安装包。若仍失败，请重启 Windows 后重试。";
        } else if (NumberEquals(windowsCode, 5)) {
          cause = "Windows 拒绝访问所报路径。";
          advice = "请检查访问权限及安全软件记录，然后重新运行同一个官方安装包。仅在目录需要管理员权限时，以管理员身份运行。";
        } else if (NumberEquals(windowsCode, 112)) {
          cause = "Windows 报告磁盘空间不足。";
          advice = "请清理安装目录和临时文件所在磁盘的空间，然后重新运行同一个官方安装包。";
        }
      } else if (language == "1028") {
        stage = failurePhase == "prepare-new-program-files" ? "準備新應用程式檔案" : failurePhase == "extract-new-program-files" ? "解壓縮新應用程式檔案" :
          failurePhase == "publish-new-program-files" ? "發佈新應用程式檔案" : failurePhase == "copy-new-program-files" ? "複製新應用程式檔案" : "清理暫存安裝檔案";
        reason = stage + " 時失敗。";
        state = "安裝尚未完成，應用程式可能無法啟動。";
        advice = "請檢查所報路徑、磁碟空間及安全軟體記錄，解決問題後重新執行同一個官方安裝程式。如安裝程式損壞，請從官方來源重新下載。";
        if (NumberEquals(windowsCode, 32) || NumberEquals(windowsCode, 33)) {
          cause = "Windows 報告應用程式檔案或目錄正在使用中。";
          advice = "請關閉使用此檔案或目錄的工作，然後重新執行同一個官方安裝程式。若仍失敗，請重新啟動 Windows 後再試。";
        } else if (NumberEquals(windowsCode, 5)) {
          cause = "Windows 拒絕存取所報路徑。";
          advice = "請檢查存取權限及安全軟體記錄，然後重新執行同一個官方安裝程式。僅在目錄需要管理員權限時，以管理員身分執行。";
        } else if (NumberEquals(windowsCode, 112)) {
          cause = "Windows 報告磁碟空間不足。";
          advice = "請清理安裝目錄和暫存檔案所在磁碟的空間，然後重新執行同一個官方安裝程式。";
        }
      }
      fallback = string.IsNullOrEmpty(cause) ? sourceResult : "";
      message = new List<string> { title, state, reason, cause, fallback, file, advice, log };
    }
    message = message.Where(item => !string.IsNullOrEmpty(item)).ToList();
    var messageText = string.Join("\r\n\r\n", message);
    var messagePath = Optional(options, "message-path");
    if (options.ContainsKey("write-message-next-to-report") && !string.IsNullOrEmpty(reportPath))
      messagePath = Path.Combine(Path.GetDirectoryName(reportPath), "cleanup-notice.txt");
    try {
      if (!string.IsNullOrEmpty(messagePath)) File.WriteAllText(messagePath, messageText, new UnicodeEncoding(false, false));
      else Console.Write(messageText);
    } catch (Exception error) { Console.Error.WriteLine("Could not save installer notice: " + error.Message); }
  }

  static string productTitle(Dictionary<string, string> options) {
    return Optional(options, "product-name", "Open-Science");
  }
}
