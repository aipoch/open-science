# Keep the existing install/update/uninstall lifecycle independent of license presentation.
# Backslash separators only: NSIS does not treat a forward-slash path as absolute for !include,
# so the mixed form resolves through the include search path and fails the Windows package build.
!include "${BUILD_RESOURCES_DIR}\installer.nsh"

# electron-builder inserts this hook immediately before its license page, and skips that page
# during updates. Override all agreement copy; Next only advances the informational page.
!macro customWelcomePage
  !define MUI_PAGE_HEADER_TEXT "Open-source license"
  !define MUI_PAGE_HEADER_SUBTEXT "Apache License 2.0"
  !define MUI_LICENSEPAGE_TEXT_TOP "Open Science is distributed under the Apache License 2.0."
  !define MUI_LICENSEPAGE_TEXT_BOTTOM "The license is also included with the installed application."
  !define MUI_LICENSEPAGE_BUTTON "$(^NextBtn)"
!macroend
