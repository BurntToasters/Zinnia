; Keep aligned with $ZinniaMinRealShellArtifactBytes in
; scripts/verify-windows-authenticode.ps1. Generated CI stubs are empty.
!define ZINNIA_MIN_REAL_SHELL_ARTIFACT_BYTES 1024

!macro ZINNIA_REGISTER_PROGID_OPEN EXT
  ; Enhance Tauri's default ProgId open verb. Do not write a parallel
  ; SystemFileAssociations\ZinniaOpen  -  that doubles "Open with Zinnia" under
  ; Show more options when the ProgId is already the default association.
  WriteRegStr HKCU "Software\Classes\run.rosie.zinnia${EXT}\shell\open" "MUIVerb" "Open with Zinnia"
  WriteRegStr HKCU "Software\Classes\run.rosie.zinnia${EXT}\shell\open" "Icon" "$INSTDIR\zinnia.exe"
  WriteRegStr HKCU "Software\Classes\run.rosie.zinnia${EXT}\shell\open" "MultiSelectModel" "Player"
!macroend

!macro ZINNIA_REGISTER_CLASSIC_EXTRACT EXT
  ; Fallback only when Win11 sparse packages are unavailable. Those packages
  ; also surface in the legacy menu, so classic Extract would duplicate them.
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\ZinniaExtract" "" "Extract with Zinnia"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\ZinniaExtract" "Icon" "$INSTDIR\zinnia.exe"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\ZinniaExtract" "MultiSelectModel" "Player"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\ZinniaExtract\command" "" '"$INSTDIR\zinnia.exe" --extract "%1"'
!macroend

!macro ZINNIA_CLEAN_LEGACY_ARCHIVE_VERBS EXT
  ; Always purge classic archive verbs on install/upgrade. Earlier betas left
  ; ZinniaOpen beside the ProgId open verb; beta.20 could leave Extract after a
  ; failed cleanup path. Win11 packages re-provide Extract when registered.
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\ZinniaOpen"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\ZinniaExtract"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\Zinnia.Extract"
!macroend

!macro ZINNIA_UNREGISTER_ARCHIVE_VERBS EXT
  !insertmacro ZINNIA_CLEAN_LEGACY_ARCHIVE_VERBS "${EXT}"
  DeleteRegKey HKCU "Software\Classes\${EXT}\OpenWithProgids\Zinnia.Archive"
!macroend

!macro ZINNIA_REGISTER_COMPRESS_VERBS
  DeleteRegKey HKCU "Software\Classes\*\shell\Zinnia"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Zinnia"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Zinnia"

  WriteRegStr HKCU "Software\Classes\*\shell\ZinniaCompress" "MUIVerb" "Compress with Zinnia"
  WriteRegStr HKCU "Software\Classes\*\shell\ZinniaCompress" "Icon" "$INSTDIR\zinnia.exe"
  WriteRegStr HKCU "Software\Classes\*\shell\ZinniaCompress" "MultiSelectModel" "Player"
  WriteRegStr HKCU "Software\Classes\*\shell\ZinniaCompress\command" "" '"$INSTDIR\zinnia.exe" --compress "%1"'
  WriteRegStr HKCU "Software\Classes\Directory\shell\ZinniaCompress" "MUIVerb" "Compress folder with Zinnia"
  WriteRegStr HKCU "Software\Classes\Directory\shell\ZinniaCompress" "Icon" "$INSTDIR\zinnia.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\ZinniaCompress" "MultiSelectModel" "Player"
  WriteRegStr HKCU "Software\Classes\Directory\shell\ZinniaCompress\command" "" '"$INSTDIR\zinnia.exe" --compress "%1"'
  ; Empty folder background: %V is the folder path.
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ZinniaCompress" "MUIVerb" "Compress with Zinnia"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ZinniaCompress" "Icon" "$INSTDIR\zinnia.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ZinniaCompress\command" "" '"$INSTDIR\zinnia.exe" --compress "%V"'
!macroend

!macro ZINNIA_UNREGISTER_COMPRESS_VERBS
  DeleteRegKey HKCU "Software\Classes\*\shell\ZinniaCompress"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\ZinniaCompress"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\ZinniaCompress"
  DeleteRegKey HKCU "Software\Classes\*\shell\Zinnia"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Zinnia"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Zinnia"
!macroend

!macro ZINNIA_CLEAN_LEGACY_SHELL_PAYLOAD
  ; Beta 11/13 placed these directly in $INSTDIR. Keep cleanup available on
  ; both update and uninstall in case a mapped DLL survived the first attempt.
  Delete /REBOOTOK "$INSTDIR\zinnia_shell.dll"
  Delete /REBOOTOK "$INSTDIR\zinnia_extract_shell.dll"
  Delete /REBOOTOK "$INSTDIR\ZinniaContextMenu.msix"
  Delete /REBOOTOK "$INSTDIR\ZinniaExtractContextMenu.msix"
  Delete /REBOOTOK "$INSTDIR\register-windows-context-menu.ps1"
!macroend

!macro ZINNIA_REGISTER_WIN11_CONTEXT_MENU
  ; Sparse MSIX + IExplorerCommand DLL.
  ; Shell hosts can keep a COM DLL mapped long after the menu closes. Every
  ; release therefore gets a new directory so an update never overwrites a DLL
  ; that Explorer/dllhost still has open. ${VERSION} is defined by Tauri's NSIS
  ; template before this macro is expanded.
  ; $R6 = 1 when packages registered successfully (caller skips classic verbs).
  StrCpy $R6 "0"
  IfFileExists "$INSTDIR\shell-${VERSION}\ZinniaContextMenu.msix" 0 zinnia_skip_win11_menu
  StrCpy $R9 "$INSTDIR\shell-${VERSION}"
  IfFileExists "$R9\zinnia_shell.dll" 0 zinnia_skip_win11_menu
  IfFileExists "$R9\ZinniaExtractContextMenu.msix" 0 zinnia_skip_win11_menu
  IfFileExists "$R9\zinnia_extract_shell.dll" 0 zinnia_skip_win11_menu
  ; Skip empty CI stubs (real packages are much larger than 1 KiB).
  FileOpen $R8 "$R9\ZinniaContextMenu.msix" r
  FileSeek $R8 0 END $R7
  FileClose $R8
  IntCmp $R7 ${ZINNIA_MIN_REAL_SHELL_ARTIFACT_BYTES} zinnia_skip_win11_menu zinnia_skip_win11_menu 0
  FileOpen $R8 "$R9\ZinniaExtractContextMenu.msix" r
  FileSeek $R8 0 END $R7
  FileClose $R8
  IntCmp $R7 ${ZINNIA_MIN_REAL_SHELL_ARTIFACT_BYTES} zinnia_skip_win11_menu zinnia_skip_win11_menu 0

  ; The script and sparse packages ship beside the DLLs. ExternalLocation stays
  ; at $INSTDIR because AppxManifest references both root zinnia.exe and the
  ; versioned shell-${VERSION} COM server paths from that common external root.
  StrCpy $R8 "$R9\register-windows-context-menu.ps1"
  IfFileExists "$R8" 0 zinnia_menu_script_instdir
  Goto zinnia_menu_run_script
  zinnia_menu_script_instdir:
  StrCpy $R8 "$INSTDIR\register-windows-context-menu.ps1"
  IfFileExists "$R8" 0 zinnia_menu_no_script
  zinnia_menu_run_script:
  DetailPrint "Registering Win11 context menu package... (this may take a moment)"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$R8" -MsixPath "$R9\ZinniaContextMenu.msix" -ExtractMsixPath "$R9\ZinniaExtractContextMenu.msix" -ExternalLocation "$INSTDIR" -ShellPayloadLocation "$R9" -LogPath "$INSTDIR\zinnia-context-menu-register.log"'
  Pop $0
  ; The registration script removed the old sparse identities, so their
  ; unversioned beta payload is no longer live registration state.
  !insertmacro ZINNIA_CLEAN_LEGACY_SHELL_PAYLOAD
  IntCmp $0 0 zinnia_menu_registered 0 0
  DetailPrint "WARNING: Win11 context menu registration failed (exit $0). Classic verbs still work. See $INSTDIR\zinnia-context-menu-register.log"
  Goto zinnia_skip_win11_menu
  zinnia_menu_registered:
  DetailPrint "Win11 context menu package registered."
  StrCpy $R6 "1"
  Goto zinnia_skip_win11_menu
  zinnia_menu_no_script:
  DetailPrint "WARNING: register-windows-context-menu.ps1 missing; skipping Win11 modern menu. Classic verbs still work."
  FileOpen $R8 "$INSTDIR\zinnia-context-menu-register.log" w
  FileWrite $R8 "ERROR: register-windows-context-menu.ps1 not found next to shell package or in $INSTDIR$\r$\n"
  FileClose $R8
  zinnia_skip_win11_menu:
!macroend

!macro ZINNIA_UNREGISTER_WIN11_CONTEXT_MENU
  ; Retry once, then fail the PowerShell step if either sparse package remains.
  ; Leaving packages registered against a deleted ExternalLocation breaks modern
  ; menus after uninstall; surface that instead of claiming cleanup succeeded.
  DetailPrint "Unregistering Win11 sparse context-menu packages…"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference=\"Stop\"; $names=@(\"run.rosie.zinnia.contextmenu\",\"run.rosie.zinnia.extractmenu\"); for($attempt=0;$attempt -lt 2;$attempt++){ foreach($name in $names){ Get-AppxPackage -Name $name -ErrorAction SilentlyContinue | Remove-AppxPackage -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 400 }; $left=@(); foreach($name in $names){ $left += @(Get-AppxPackage -Name $name -ErrorAction SilentlyContinue) }; if($left.Count -gt 0){ $joined=(($left | ForEach-Object Name) -join \", \"); Write-Error \"Zinnia AppX packages still registered after uninstall: $joined\"; exit 1 }"'
  Pop $0
  IntCmp $0 0 zinnia_win11_unregister_ok 0 0
  DetailPrint "WARNING: Could not fully unregister Win11 sparse context-menu packages (exit $0). Remove run.rosie.zinnia.contextmenu / extractmenu manually if menus misbehave."
  FileOpen $R8 "$INSTDIR\zinnia-context-menu-register.log" a
  FileSeek $R8 0 END
  FileWrite $R8 "WARNING: Win11 sparse package unregister incomplete during uninstall (exit $0)$\r$\n"
  FileClose $R8
  zinnia_win11_unregister_ok:
!macroend

!macro ZINNIA_CLEAN_SHELL_PAYLOADS KEEPDIR LABELPREFIX
  ; Remove only installer-owned files from each payload except KEEPDIR. Avoid
  ; recursive deletion so an unexpected junction or user file is never followed.
  ; Locked DLLs and the directory are scheduled for deletion after reboot.
  FindFirst $R8 $R9 "$INSTDIR\shell-*"
  ${LABELPREFIX}_loop:
  StrCmp $R9 "" ${LABELPREFIX}_done
  StrCmp $R9 "${KEEPDIR}" ${LABELPREFIX}_next
  ; Never follow a junction/symlink that happens to match shell-*.
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\$R9") i .R7'
  IntOp $R7 $R7 & 0x400
  IntCmp $R7 0 ${LABELPREFIX}_clean ${LABELPREFIX}_next ${LABELPREFIX}_next
  ${LABELPREFIX}_clean:
  Delete /REBOOTOK "$INSTDIR\$R9\zinnia_shell.dll"
  Delete /REBOOTOK "$INSTDIR\$R9\zinnia_extract_shell.dll"
  Delete /REBOOTOK "$INSTDIR\$R9\ZinniaContextMenu.msix"
  Delete /REBOOTOK "$INSTDIR\$R9\ZinniaExtractContextMenu.msix"
  Delete /REBOOTOK "$INSTDIR\$R9\register-windows-context-menu.ps1"
  RMDir /REBOOTOK "$INSTDIR\$R9"
  ${LABELPREFIX}_next:
  FindNext $R8 $R9
  Goto ${LABELPREFIX}_loop
  ${LABELPREFIX}_done:
  FindClose $R8
!macroend

!macro ZINNIA_POSTINSTALL_CLASSIC_EXTRACT_FALLBACK
  !insertmacro ZINNIA_REGISTER_CLASSIC_EXTRACT ".7z"
  !insertmacro ZINNIA_REGISTER_CLASSIC_EXTRACT ".zip"
  !insertmacro ZINNIA_REGISTER_CLASSIC_EXTRACT ".tar"
  !insertmacro ZINNIA_REGISTER_CLASSIC_EXTRACT ".gz"
  !insertmacro ZINNIA_REGISTER_CLASSIC_EXTRACT ".bz2"
  !insertmacro ZINNIA_REGISTER_CLASSIC_EXTRACT ".xz"
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Refuse a pre-created junction/symlink before Tauri copies any resources
  ; through it. A missing destination returns INVALID_FILE_ATTRIBUTES (-1).
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\shell-${VERSION}") i .R7'
  IntCmp $R7 -1 zinnia_preinstall_destination_safe zinnia_preinstall_check_reparse zinnia_preinstall_check_reparse
  zinnia_preinstall_check_reparse:
  IntOp $R8 $R7 & 0x400
  IntCmp $R8 0 zinnia_preinstall_destination_safe 0 0
  MessageBox MB_ICONSTOP|MB_OK "Zinnia cannot install into a shell directory that is a junction or symbolic link:$\r$\n$INSTDIR\shell-${VERSION}"
  Abort
  zinnia_preinstall_destination_safe:
  ; Re-running the exact same installer must not try to rewrite its own loaded
  ; shell DLL. For an existing same-version payload, NSIS skips equal-timestamp
  ; files while still restoring missing or genuinely different files. A normal
  ; future-version update has no destination directory and keeps overwrite=on.
  IfFileExists "$INSTDIR\shell-${VERSION}\zinnia_shell.dll" 0 zinnia_preinstall_done
  SetOverwrite ifdiff
  zinnia_preinstall_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  SetOverwrite on
  ; Drop leftover classic archive verbs from earlier betas before writing new
  ; state. Win11 sparse packages also appear under Show more options, so classic
  ; Extract/Compress must not stack on top of them when registration succeeds.
  !insertmacro ZINNIA_CLEAN_LEGACY_ARCHIVE_VERBS ".7z"
  !insertmacro ZINNIA_CLEAN_LEGACY_ARCHIVE_VERBS ".zip"
  !insertmacro ZINNIA_CLEAN_LEGACY_ARCHIVE_VERBS ".tar"
  !insertmacro ZINNIA_CLEAN_LEGACY_ARCHIVE_VERBS ".gz"
  !insertmacro ZINNIA_CLEAN_LEGACY_ARCHIVE_VERBS ".bz2"
  !insertmacro ZINNIA_CLEAN_LEGACY_ARCHIVE_VERBS ".xz"
  !insertmacro ZINNIA_REGISTER_PROGID_OPEN ".7z"
  !insertmacro ZINNIA_REGISTER_PROGID_OPEN ".zip"
  !insertmacro ZINNIA_REGISTER_PROGID_OPEN ".tar"
  !insertmacro ZINNIA_REGISTER_PROGID_OPEN ".gz"
  !insertmacro ZINNIA_REGISTER_PROGID_OPEN ".bz2"
  !insertmacro ZINNIA_REGISTER_PROGID_OPEN ".xz"
  !insertmacro ZINNIA_REGISTER_COMPRESS_VERBS
  !insertmacro ZINNIA_REGISTER_WIN11_CONTEXT_MENU
  IntCmp $R6 1 zinnia_postinstall_win11_ok 0 0
  DetailPrint "Keeping classic Extract/Compress verbs (Win11 menu unavailable)."
  !insertmacro ZINNIA_POSTINSTALL_CLASSIC_EXTRACT_FALLBACK
  Goto zinnia_postinstall_verbs_done
  zinnia_postinstall_win11_ok:
  DetailPrint "Removing classic Extract/Compress verbs; Win11 packages cover legacy menu too."
  !insertmacro ZINNIA_UNREGISTER_COMPRESS_VERBS
  zinnia_postinstall_verbs_done:
  !insertmacro ZINNIA_CLEAN_SHELL_PAYLOADS "shell-${VERSION}" zinnia_update_shell_cleanup
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Tauri checks for a running app before reaching this hook, so canceling that
  ; prompt cannot partially unregister an otherwise installed app. Its normal
  ; resource deletes run first; this then unregisters the packages and schedules
  ; any DLLs still mapped by a shell host for deletion after reboot.
  !insertmacro ZINNIA_UNREGISTER_WIN11_CONTEXT_MENU
  !insertmacro ZINNIA_CLEAN_SHELL_PAYLOADS "" zinnia_uninstall_shell_cleanup
  !insertmacro ZINNIA_CLEAN_LEGACY_SHELL_PAYLOAD
  Delete /REBOOTOK "$INSTDIR\zinnia-context-menu-register.log"
  !insertmacro ZINNIA_UNREGISTER_COMPRESS_VERBS
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".7z"
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".zip"
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".tar"
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".gz"
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".bz2"
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".xz"
  DeleteRegKey HKCU "Software\Classes\Zinnia.Archive"
  RMDir /REBOOTOK "$INSTDIR"
!macroend
