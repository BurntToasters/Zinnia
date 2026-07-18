!macro ZINNIA_REGISTER_ARCHIVE_VERBS EXT
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\ZinniaOpen" "" "Open with Zinnia"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\ZinniaOpen" "Icon" "$INSTDIR\zinnia.exe"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\ZinniaOpen\command" "" '"$INSTDIR\zinnia.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\ZinniaExtract" "" "Extract with Zinnia"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\ZinniaExtract" "Icon" "$INSTDIR\zinnia.exe"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\ZinniaExtract\command" "" '"$INSTDIR\zinnia.exe" --extract "%1"'
!macroend

!macro ZINNIA_UNREGISTER_ARCHIVE_VERBS EXT
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\ZinniaOpen"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\ZinniaExtract"
!macroend

!macro ZINNIA_REGISTER_COMPRESS_VERBS
  DeleteRegKey HKCU "Software\Classes\*\shell\Zinnia"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Zinnia"

  WriteRegStr HKCU "Software\Classes\*\shell\ZinniaCompress" "MUIVerb" "Compress with Zinnia"
  WriteRegStr HKCU "Software\Classes\*\shell\ZinniaCompress" "Icon" "$INSTDIR\zinnia.exe"
  WriteRegStr HKCU "Software\Classes\*\shell\ZinniaCompress\command" "" '"$INSTDIR\zinnia.exe" --compress "%1"'
  WriteRegStr HKCU "Software\Classes\Directory\shell\ZinniaCompress" "MUIVerb" "Compress folder with Zinnia"
  WriteRegStr HKCU "Software\Classes\Directory\shell\ZinniaCompress" "Icon" "$INSTDIR\zinnia.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\ZinniaCompress\command" "" '"$INSTDIR\zinnia.exe" --compress "%1"'
!macroend

!macro ZINNIA_UNREGISTER_COMPRESS_VERBS
  DeleteRegKey HKCU "Software\Classes\*\shell\ZinniaCompress"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\ZinniaCompress"
  DeleteRegKey HKCU "Software\Classes\*\shell\Zinnia"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Zinnia"
!macroend

!macro ZINNIA_REGISTER_WIN11_CONTEXT_MENU
  ; Sparse MSIX + IExplorerCommand DLL.
  ; Tauri Windows resourceDir is the exe directory ($INSTDIR). We also accept
  ; $INSTDIR\resources when mapped that way. ExternalLocation = folder with DLL.
  StrCpy $R9 "$INSTDIR"
  IfFileExists "$R9\ZinniaContextMenu.msix" 0 zinnia_menu_try_resources
  IfFileExists "$R9\zinnia_shell.dll" 0 zinnia_menu_try_resources
  Goto zinnia_menu_register
  zinnia_menu_try_resources:
  StrCpy $R9 "$INSTDIR\resources"
  IfFileExists "$R9\ZinniaContextMenu.msix" 0 zinnia_skip_win11_menu
  IfFileExists "$R9\zinnia_shell.dll" 0 zinnia_skip_win11_menu
  zinnia_menu_register:
  ; Skip empty CI stubs (real packages are much larger than 1 KiB).
  FileOpen $R8 "$R9\ZinniaContextMenu.msix" r
  FileSeek $R8 0 END $R7
  FileClose $R8
  IntCmp $R7 1024 zinnia_skip_win11_menu zinnia_skip_win11_menu 0

  ; Register script ships next to the DLL/MSIX (same ExternalLocation folder).
  StrCpy $R8 "$R9\register-windows-context-menu.ps1"
  IfFileExists "$R8" 0 zinnia_menu_script_instdir
  Goto zinnia_menu_run_script
  zinnia_menu_script_instdir:
  StrCpy $R8 "$INSTDIR\register-windows-context-menu.ps1"
  IfFileExists "$R8" 0 zinnia_menu_no_script
  zinnia_menu_run_script:
  DetailPrint "Registering Win11 context menu package…"
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$R8" -MsixPath "$R9\ZinniaContextMenu.msix" -ExternalLocation "$R9" -LogPath "$INSTDIR\zinnia-context-menu-register.log"'
  Pop $0
  IntCmp $0 0 zinnia_menu_registered 0 0
  DetailPrint "WARNING: Win11 context menu registration failed (exit $0). Classic verbs still work. See $INSTDIR\zinnia-context-menu-register.log"
  Goto zinnia_skip_win11_menu
  zinnia_menu_registered:
  DetailPrint "Win11 context menu package registered."
  Goto zinnia_skip_win11_menu
  zinnia_menu_no_script:
  DetailPrint "WARNING: register-windows-context-menu.ps1 missing; skipping Win11 modern menu. Classic verbs still work."
  FileOpen $R8 "$INSTDIR\zinnia-context-menu-register.log" w
  FileWrite $R8 "ERROR: register-windows-context-menu.ps1 not found next to shell package or in $INSTDIR$\r$\n"
  FileClose $R8
  zinnia_skip_win11_menu:
!macroend

!macro ZINNIA_UNREGISTER_WIN11_CONTEXT_MENU
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-AppxPackage -Name run.rosie.zinnia.contextmenu -ErrorAction SilentlyContinue | Remove-AppxPackage -ErrorAction SilentlyContinue"'
  Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro ZINNIA_REGISTER_COMPRESS_VERBS
  !insertmacro ZINNIA_REGISTER_ARCHIVE_VERBS ".7z"
  !insertmacro ZINNIA_REGISTER_ARCHIVE_VERBS ".zip"
  !insertmacro ZINNIA_REGISTER_ARCHIVE_VERBS ".tar"
  !insertmacro ZINNIA_REGISTER_ARCHIVE_VERBS ".gz"
  !insertmacro ZINNIA_REGISTER_ARCHIVE_VERBS ".tgz"
  !insertmacro ZINNIA_REGISTER_ARCHIVE_VERBS ".bz2"
  !insertmacro ZINNIA_REGISTER_ARCHIVE_VERBS ".tbz2"
  !insertmacro ZINNIA_REGISTER_ARCHIVE_VERBS ".xz"
  !insertmacro ZINNIA_REGISTER_ARCHIVE_VERBS ".txz"
  !insertmacro ZINNIA_REGISTER_WIN11_CONTEXT_MENU
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro ZINNIA_UNREGISTER_WIN11_CONTEXT_MENU
  !insertmacro ZINNIA_UNREGISTER_COMPRESS_VERBS
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".7z"
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".zip"
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".tar"
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".gz"
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".tgz"
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".bz2"
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".tbz2"
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".xz"
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".txz"
!macroend
