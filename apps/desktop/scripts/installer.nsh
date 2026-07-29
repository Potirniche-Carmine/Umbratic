!ifdef BUILD_UNINSTALLER
  !include "LogicLib.nsh"
  !include "MUI2.nsh"
  !include "nsDialogs.nsh"

  Var RemoveUmbraticDataCheckbox
  Var RemoveUmbraticData

  Function un.UmbraticDataPageCreate
    !insertmacro MUI_HEADER_TEXT "Local data" "Select whether to remove this user's Umbratic data."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateCheckbox} 0 18u 100% 16u "Remove all local Umbratic data"
    Pop $RemoveUmbraticDataCheckbox
    ${NSD_Uncheck} $RemoveUmbraticDataCheckbox
    nsDialogs::Show
  FunctionEnd

  Function un.UmbraticDataPageLeave
    ${NSD_GetState} $RemoveUmbraticDataCheckbox $RemoveUmbraticData
  FunctionEnd

  !macro customUnWelcomePage
    !insertmacro MUI_UNPAGE_WELCOME
    UninstPage custom un.UmbraticDataPageCreate un.UmbraticDataPageLeave
  !macroend

  !macro customUnInstall
    ${If} $RemoveUmbraticData == ${BST_CHECKED}
      RMDir /r "$LOCALAPPDATA\Umbratic"
    ${EndIf}
  !macroend
!endif
