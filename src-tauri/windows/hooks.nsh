!include LogicLib.nsh
!define STACKCABIN_HOOK_DIRECTORY "${__FILEDIR__}"

!macro NSIS_HOOK_PREINSTALL
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\StackCabin-prerequisites"
  File /oname=vc_redist.x64.exe "${STACKCABIN_HOOK_DIRECTORY}\..\..\artifacts\windows-prerequisites\vc_redist.x64.exe"
  File /oname=windows-prerequisites.json "${STACKCABIN_HOOK_DIRECTORY}\..\..\runtime-catalog\windows-prerequisites.json"
  File "${STACKCABIN_HOOK_DIRECTORY}\install-vc-runtime.ps1"
  DetailPrint "Checking the bundled Microsoft Visual C++ x64 runtime"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\StackCabin-prerequisites\install-vc-runtime.ps1"'
  Pop $0
  ${If} $0 == 3010
    SetRebootFlag true
  ${ElseIf} $0 != 0
    DetailPrint "Microsoft Visual C++ setup failed: $0"
    IfSilent +2
    MessageBox MB_ICONSTOP|MB_OK "Microsoft Visual C++ setup did not complete. Check the installer details and try again."
    SetErrorLevel 1
    Abort
  ${EndIf}
  SetOutPath "$INSTDIR"
!macroend
