{
  "targets": [
    {
      "target_name": "process_tree_native",
      "sources": [
        "src/process_tree_native.cc",
        "src/windows_owned_process.cc"
      ],
      "defines": [
        "NAPI_VERSION=8"
      ],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": [
              "Advapi32.lib"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "AdditionalOptions": [
                  "/std:c++17"
                ]
              }
            },
            "defines": [
              "_WIN32_WINNT=0x0A00"
            ]
          }
        ],
        [
          "OS!='win'",
          {
            "cflags_cc": [
              "-std=c++17"
            ]
          }
        ],
        [
          "OS=='mac'",
          {
            "xcode_settings": {
              "CLANG_CXX_LANGUAGE_STANDARD": "c++17"
            }
          }
        ]
      ]
    }
  ]
}
