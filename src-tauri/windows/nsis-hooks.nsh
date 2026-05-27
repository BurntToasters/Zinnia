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

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro ZINNIA_REGISTER_ARCHIVE_VERBS ".7z"
  !insertmacro ZINNIA_REGISTER_ARCHIVE_VERBS ".zip"
  !insertmacro ZINNIA_REGISTER_ARCHIVE_VERBS ".tar"
  !insertmacro ZINNIA_REGISTER_ARCHIVE_VERBS ".gz"
  !insertmacro ZINNIA_REGISTER_ARCHIVE_VERBS ".tgz"
  !insertmacro ZINNIA_REGISTER_ARCHIVE_VERBS ".bz2"
  !insertmacro ZINNIA_REGISTER_ARCHIVE_VERBS ".tbz2"
  !insertmacro ZINNIA_REGISTER_ARCHIVE_VERBS ".xz"
  !insertmacro ZINNIA_REGISTER_ARCHIVE_VERBS ".txz"
  !insertmacro ZINNIA_REGISTER_ARCHIVE_VERBS ".rar"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".7z"
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".zip"
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".tar"
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".gz"
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".tgz"
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".bz2"
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".tbz2"
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".xz"
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".txz"
  !insertmacro ZINNIA_UNREGISTER_ARCHIVE_VERBS ".rar"
!macroend
