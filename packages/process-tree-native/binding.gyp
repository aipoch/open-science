{
  "targets": [
    {
      "target_name": "process_tree_native",
      "sources": ["src/process_tree_native.cc"],
      "defines": ["NAPI_VERSION=8"],
      "conditions": [
        [
          "OS=='win'",
          {
            "msvs_settings": {
              "VCCLCompilerTool": {
                "AdditionalOptions": ["/std:c++17"]
              }
            }
          }
        ],
        [
          "OS!='win'",
          {
            "cflags_cc": ["-std=c++17"]
          }
        ]
      ]
    }
  ]
}
