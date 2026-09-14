!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "WinMessages.nsh"

; NSIS uses physical pixels for this custom layout. Declaring DPI awareness
; prevents Windows from applying a second bitmap scale that would blur or crop
; the 16:9 artwork at 125%/150% display scaling.
ManifestDPIAware true

; The updater invokes this same installer with /S. Everything below is only
; visual: silent updates keep electron-builder's standard unattended path,
; while a setup opened by hand gets the branded Cobblemon interface.

!ifndef BUILD_UNINSTALLER
  AutoCloseWindow true

  Var CobblemonInstallerBackground
  Var CobblemonInstallerBackgroundBitmap
  Var CobblemonInstallerTitle
  Var CobblemonInstallerSubtitle
  Var CobblemonInstallerVersion
  Var CobblemonInstallerTitleFont
  Var CobblemonInstallerBodyFont
  Var CobblemonInstallerOperation

  ; assistedInstaller.nsh expands this hook immediately before declaring the
  ; InstFiles page. Defining the callback globally would let the hidden install
  ; mode page consume it first.
  !macro customPageAfterChangeDir
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW CobblemonInstallerPageShow
  !macroend

  ; Keep the installation scope previously selected by the player, but skip
  ; the stock white selection page. Fresh installs default to CurrentUser,
  ; exactly like electron-builder's assisted installer did before.
  !macro customInstallMode
    ${If} $installMode == "all"
      StrCpy $isForceMachineInstall "1"
    ${Else}
      StrCpy $isForceCurrentInstall "1"
    ${EndIf}
  !macroend

  ; No stock white finish page. The real progress page closes when complete.
  !macro customFinishPage
  !macroend

  ; Assisted installers normally launch from the finish page. Since that page
  ; is intentionally removed, launch here for interactive runs. Silent updater
  ; runs retain electron-builder's --force-run handling and never double-launch.
  !macro customInstall
    ${IfNot} ${Silent}
      Sleep 350
      HideWindow
      ${If} ${isUpdated}
        StrCpy $R7 "--updated"
      ${Else}
        StrCpy $R7 ""
      ${EndIf}
      ${StdUtils.ExecShellAsUser} $R6 "$launchLink" "open" "$R7"
    ${EndIf}
  !macroend

  !macro customInit
    StrCpy $CobblemonInstallerOperation "INSTALLATION DU LAUNCHER"

    ${If} ${isUpdated}
      StrCpy $CobblemonInstallerOperation "MISE À JOUR DU LAUNCHER"
    ${Else}
      ; A setup opened manually does not receive --updated. Detect an existing
      ; installation so the wording remains accurate for manual updates too.
      ReadRegStr $R8 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
      ${If} $R8 == ""
        ReadRegStr $R8 HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
      ${EndIf}
      ${If} $R8 != ""
        StrCpy $CobblemonInstallerOperation "MISE À JOUR DU LAUNCHER"
      ${EndIf}
    ${EndIf}

    IfSilent cobblemon_visual_init_done
      InitPluginsDir
      File /oname=$PLUGINSDIR\cobblemon-installer-background.bmp "${BUILD_RESOURCES_DIR}\installer-background.bmp"
    cobblemon_visual_init_done:
  !macroend

  Function CobblemonInstallerPageShow
    ; Normally the page is not shown in /S mode. This explicit guard makes the
    ; updater compatibility contract clear and protects future template changes.
    IfSilent cobblemon_page_done

    LockWindow on

    ; Ask Windows for the exact outer size needed by a 960 x 600 client area
    ; (540 px artwork + 60 px footer). This avoids clipping at different window
    ; frame/DPI settings instead of assuming a hard-coded title-bar height.
    System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -16) i .r6'
    System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20) i .r7'
    System::Call '*(i 0, i 0, i 960, i 600) p .r9'
    System::Call 'user32::AdjustWindowRectEx(p $9, i $6, i 0, i $7) i .r8'
    System::Call '*$9(i .r0, i .r1, i .r2, i .r3)'
    System::Free $9
    IntOp $R6 $2 - $0
    IntOp $R7 $3 - $1

    ; Center the resulting outer window in the work area of the monitor Windows
    ; chose for the setup (including secondary monitors with negative origins).
    System::Call 'user32::MonitorFromWindow(p $HWNDPARENT, i 2) p .r8'
    System::Call '*(i 40, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0) p .r9'
    System::Call 'user32::GetMonitorInfoW(p $8, p $9) i .r8'
    System::Call '*$9(i, i .r0, i .r1, i .r2, i .r3, i .r4, i .r5, i .r6, i .r7, i)'
    System::Free $9
    IntOp $6 $6 - $4
    IntOp $6 $6 - $R6
    IntOp $6 $6 / 2
    IntOp $6 $6 + $4
    IntOp $7 $7 - $5
    IntOp $7 $7 - $R7
    IntOp $7 $7 / 2
    IntOp $7 $7 + $5
    ${If} $6 < $4
      StrCpy $6 $4
    ${EndIf}
    ${If} $7 < $5
      StrCpy $7 $5
    ${EndIf}
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i $6, i $7, i $R6, i $R7, i 0x0014)'

    ; The install-files page is the child dialog hosted by the MUI wizard.
    FindWindow $R0 "#32770" "" $HWNDPARENT
    System::Call 'user32::SetWindowPos(p $R0, p 0, i 0, i 0, i 960, i 600, i 0x0014)'

    ; Remove the stock white header and separators. The title bar and native
    ; Cancel action remain available for keyboard use and safe cancellation.
    GetDlgItem $R1 $HWNDPARENT 1034
    ShowWindow $R1 ${SW_HIDE}
    GetDlgItem $R1 $HWNDPARENT 1035
    ShowWindow $R1 ${SW_HIDE}
    GetDlgItem $R1 $HWNDPARENT 1045
    ShowWindow $R1 ${SW_HIDE}
    GetDlgItem $R1 $HWNDPARENT 1046
    ShowWindow $R1 ${SW_HIDE}
    GetDlgItem $R1 $HWNDPARENT 1044
    ShowWindow $R1 ${SW_HIDE}
    GetDlgItem $R1 $HWNDPARENT 1037
    ShowWindow $R1 ${SW_HIDE}
    GetDlgItem $R1 $HWNDPARENT 1038
    ShowWindow $R1 ${SW_HIDE}
    GetDlgItem $R1 $HWNDPARENT 1039
    ShowWindow $R1 ${SW_HIDE}
    GetDlgItem $R1 $HWNDPARENT 1036
    ShowWindow $R1 ${SW_HIDE}
    GetDlgItem $R1 $HWNDPARENT 1256
    ShowWindow $R1 ${SW_HIDE}
    GetDlgItem $R1 $HWNDPARENT 1028
    ShowWindow $R1 ${SW_HIDE}

    ; Single 960 x 600 canvas: an exact 960 x 540 derivative of Cobblemon artwork
    ; followed by the 60 px dark footer. WS_CLIPSIBLINGS prevents the bitmap
    ; from repainting over MUI's real status/progress controls.
    System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i 0x5400000E, i 0, i 0, i 960, i 600, p $R0, p 0, p 0, p 0) p .s'
    Pop $CobblemonInstallerBackground
    ${NSD_SetImage} $CobblemonInstallerBackground "$PLUGINSDIR\cobblemon-installer-background.bmp" $CobblemonInstallerBackgroundBitmap
    System::Call 'user32::SetWindowPos(p $CobblemonInstallerBackground, p 1, i 0, i 0, i 0, i 0, i 0x0013)'

    System::Call 'gdi32::CreateFontW(i 18, i 0, i 0, i 0, i 700, i 0, i 0, i 0, i 0, i 0, i 0, i 0, w "Segoe UI") p .s'
    Pop $CobblemonInstallerTitleFont
    System::Call 'gdi32::CreateFontW(i 14, i 0, i 0, i 0, i 600, i 0, i 0, i 0, i 0, i 0, i 0, i 0, w "Segoe UI") p .s'
    Pop $CobblemonInstallerBodyFont

    ; All installation information lives in the dedicated footer, keeping the
    ; supplied 16:9 banner fully visible and undistorted above it.
    System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "$CobblemonInstallerOperation", i 0x50000000, i 22, i 548, i 275, i 20, p $R0, p 0, p 0, p 0) p .s'
    Pop $CobblemonInstallerTitle
    SetCtlColors $CobblemonInstallerTitle EDF6FF 071425
    SendMessage $CobblemonInstallerTitle ${WM_SETFONT} $CobblemonInstallerTitleFont 1

    System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "Préparation de Licaris Launcher...", i 0x50000000, i 22, i 571, i 375, i 17, p $R0, p 0, p 0, p 0) p .s'
    Pop $CobblemonInstallerSubtitle
    SetCtlColors $CobblemonInstallerSubtitle A5D2F0 071425
    SendMessage $CobblemonInstallerSubtitle ${WM_SETFONT} $CobblemonInstallerBodyFont 1

    System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "v${VERSION}", i 0x50000002, i 300, i 550, i 95, i 18, p $R0, p 0, p 0, p 0) p .s'
    Pop $CobblemonInstallerVersion
    SetCtlColors $CobblemonInstallerVersion A5D2F0 071425
    SendMessage $CobblemonInstallerVersion ${WM_SETFONT} $CobblemonInstallerBodyFont 1

    ; Reuse the actual NSIS status/progress controls. The bar follows real
    ; extraction progress rather than a simulated animation.
    GetDlgItem $R2 $R0 1006
    System::Call 'user32::SetWindowPos(p $R2, p 0, i 410, i 569, i 370, i 18, i 0x0010)'
    ShowWindow $R2 ${SW_SHOW}
    SetCtlColors $R2 FFFFFF 071425
    SendMessage $R2 ${WM_SETFONT} $CobblemonInstallerBodyFont 1

    GetDlgItem $R3 $R0 1004
    System::Call 'user32::SetWindowPos(p $R3, p 0, i 410, i 550, i 370, i 11, i 0x0010)'
    ShowWindow $R3 ${SW_SHOW}
    SendMessage $R3 0x0410 2 0

    GetDlgItem $R4 $R0 1027
    ShowWindow $R4 ${SW_HIDE}
    GetDlgItem $R4 $R0 1016
    ShowWindow $R4 ${SW_HIDE}

    ; Keep only a clear native cancel action in the footer.
    GetDlgItem $R5 $HWNDPARENT 1
    ShowWindow $R5 ${SW_HIDE}
    GetDlgItem $R5 $HWNDPARENT 3
    ShowWindow $R5 ${SW_HIDE}
    GetDlgItem $R5 $HWNDPARENT 2
    SendMessage $R5 ${WM_SETTEXT} 0 "STR:Annuler"
    System::Call 'user32::SetWindowPos(p $R5, p 0, i 820, i 548, i 120, i 32, i 0x0010)'
    ShowWindow $R5 ${SW_SHOW}
    EnableWindow $R5 1
    System::Call 'user32::BringWindowToTop(p $R5)'

    LockWindow off

    cobblemon_page_done:
  FunctionEnd
!endif
