{
  "targets": [
    {
      "target_name": "credential_identity_probe",
      "type": "executable",
      "sources": ["src/credential_identity_probe.cc"],
      "conditions": [
        ["OS=='mac'", {
          "libraries": ["-framework Security", "-framework CoreFoundation"],
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "WARNING_CFLAGS": ["-Wno-deprecated-declarations"]
          }
        }],
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": { "AdditionalOptions": ["/std:c++17"] }
          }
        }],
        ["OS!='win'", { "cflags_cc": ["-std=c++17"] }]
      ]
    },
    {
      "target_name": "credential_key_validator",
      "type": "executable",
      "sources": ["src/credential_key_validator.cc"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": { "CLANG_CXX_LANGUAGE_STANDARD": "c++17" }
        }],
        ["OS=='win'", {
          "libraries": ["Crypt32.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": { "AdditionalOptions": ["/std:c++17"] }
          }
        }],
        ["OS!='win'", { "cflags_cc": ["-std=c++17"] }]
      ]
    }
  ]
}
