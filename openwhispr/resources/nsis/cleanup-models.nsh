!macro customHeader
  ManifestDPIAware true
!macroend

!macro customInstall
  ${ifNot} ${isUpdated}
    ; The native keyboard hooks and shell integration must start in a fresh
    ; Windows boot session. Keep a marker next to the installed executable so
    ; Type can reject manual launches when the user chooses "Restart later".
    ClearErrors
    FileOpen $R9 "$INSTDIR\.type-install-reboot-required" w
    IfErrors type_reboot_marker_failed type_reboot_marker_created
    type_reboot_marker_failed:
      MessageBox MB_ICONSTOP|MB_OK "Type could not create the restart marker. Installation cannot continue."
      Abort
    type_reboot_marker_created:
    FileWrite $R9 "Restart Windows to finish installing Type.$\r$\n"
    FileClose $R9
    SetFileAttributes "$INSTDIR\.type-install-reboot-required" HIDDEN

    ; Modern UI 2 uses this flag to replace the normal finish screen with the
    ; standard Restart now / Restart later choice.
    SetRebootFlag true

    ; ERROR_SUCCESS_REBOOT_REQUIRED for silent/managed deployments and for
    ; users who close the installer without restarting immediately.
    SetErrorLevel 3010
  ${endIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    StrCpy $0 "$PROFILE\.cache\openwhispr\models"
    IfFileExists "$0\*.*" 0 +3
      RMDir /r "$0"
      DetailPrint "Removed Type cached models"
    StrCpy $1 "$PROFILE\.cache\openwhispr"
    RMDir "$1"
  ${endIf}
!macroend
