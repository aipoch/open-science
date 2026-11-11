{
  "targets": [
    {
      "target_name": "process_tree_native",
      "sources": [
        "src/process_tree_native.cc",
        "src/windows_owned_process.cc",
        "src/windows_resource_snapshot.cc"
      ],
      "defines": ["NAPI_VERSION=8"],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": ["Advapi32.lib", "Psapi.lib", "Rstrtmgr.lib", "Shell32.lib"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                "AdditionalOptions": ["/std:c++17"]
              }
            },
            "defines": ["_WIN32_WINNT=0x0A00"]
          }
        ],
        [
          "OS!='win'",
          {
            "cflags_cc!": ["-fno-exceptions"],
            "cflags_cc": ["-std=c++17"]
          }
        ],
        [
          "OS=='mac'",
          {
            "xcode_settings": {
              "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
              "CLANG_CXX_LANGUAGE_STANDARD": "c++17"
            }
          }
        ]
      ]
    }
  ]
}
