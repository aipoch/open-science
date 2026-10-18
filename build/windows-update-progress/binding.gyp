{
  "targets": [{
    "target_name": "open-science-update-progress",
    "type": "executable",
    "win_delay_load_hook": "false",
    "sources": ["progress.cc"],
    "defines": ["UNICODE", "_UNICODE", "NOMINMAX", "_WIN32_WINNT=0x0A00"],
    "libraries": ["user32.lib", "gdi32.lib", "comctl32.lib", "shell32.lib"],
    "msvs_settings": {
      "VCCLCompilerTool": {"AdditionalOptions": ["/utf-8"], "ExceptionHandling": 1, "RuntimeLibrary": 0},
      "VCLinkerTool": {"target_conditions": [["_type=='executable'", {"SubSystem": 2}]]}
    }
  }]
}
