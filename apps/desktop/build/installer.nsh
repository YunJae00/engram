# The MCP server runs from this same executable — Electron doubles as the Node
# runtime, and a renamed copy of it would cost the ~180MB the exe weighs. Those
# helper processes are started by whichever AI client the user connected them
# to, so they outlive the app, they have no window, and one accumulates per
# client session. The installer's app-running check matches on the executable
# name, finds them, and asks the person to close an application that is not
# open and has nothing to click.
#
# So end the helpers here, before that check runs. Their clients start a fresh
# one on the next connection, and every vault write is write-then-rename, so
# there is no half-written file to lose. A genuinely running Engram is left
# alone and still gets the normal "please close it" dialog after this.
!macro engramEndMcpHelpers
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter 'Name=''${APP_EXECUTABLE_FILENAME}'' AND CommandLine LIKE ''%engram-mcp%''' | Invoke-CimMethod -MethodName Terminate -ErrorAction SilentlyContinue"`
  Pop $0
!macroend

!macro customInit
  !insertmacro engramEndMcpHelpers
!macroend

!macro customUnInit
  !insertmacro engramEndMcpHelpers
!macroend
