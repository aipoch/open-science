{
  "targets": [
    {
      "target_name": "safe_file_publisher_native",
      "sources": ["src/safe_file_publisher_native.cc"],
      "defines": ["NAPI_VERSION=8"],
      "conditions": [
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": ["/std:c++17"]
            }
          }
        }],
        ["OS!='win'", {
          "cflags_cc": ["-std=c++17"]
        }]
      ]
    }
  ]
}
