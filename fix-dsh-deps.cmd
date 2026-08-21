@echo off
chcp 65001 >nul
echo === 1/3 create dir: node_modules\@deepseek-ai ===
set "TARGET=D:\code\ai\dsh-plugin-archived-sessions\node_modules\@deepseek-ai"
set "SRC=D:\Program Files\DeepSeek Harness Desktop\resources\app\node_modules\@deepseek-ai"
if not exist "%TARGET%" mkdir "%TARGET%"
echo === 2/3 create junctions ===
if exist "%TARGET%\dsh-session" (
  echo [skip] dsh-session already exists
) else (
  mklink /J "%TARGET%\dsh-session" "%SRC%\dsh-session"
)
if exist "%TARGET%\dsh-typert-protocol" (
  echo [skip] dsh-typert-protocol already exists
) else (
  mklink /J "%TARGET%\dsh-typert-protocol" "%SRC%\dsh-typert-protocol"
)
echo === 3/3 verify imports ===
cd /d D:\code\ai\dsh-plugin-archived-sessions
node --input-type=module -e "const s=await import('@deepseek-ai/dsh-session/types'); const t=await import('@deepseek-ai/dsh-typert-protocol'); console.log('VERIFY OK: SessionId='+typeof s.SessionId+' Remote='+typeof t.Remote+' TypertRemoteService='+typeof t.TypertRemoteService);"
echo.
echo Done. Now fully quit DeepSeek Harness Desktop (tray icon -^> exit) and reopen it.
pause
