Unicode true
Name "Umbratic"
RequestExecutionLevel user
SilentInstall silent
OutFile "${OUT_FILE}"
VIProductVersion "${RELEASE}.0"
VIAddVersionKey /LANG=1033 "ProductName" "Umbratic"
VIAddVersionKey /LANG=1033 "ProductVersion" "${RELEASE}"
VIAddVersionKey /LANG=1033 "FileVersion" "${RELEASE}"
VIAddVersionKey /LANG=1033 "FileDescription" "Umbratic signing fixture"
Section
  SetOutPath "$INSTDIR"
  SetCompress off
  File /oname=app.7z "${APP_ARCHIVE}"
  SetCompress auto
  File "/oname=Uninstall Umbratic.exe" "${UNINSTALLER_FILE}"
SectionEnd
