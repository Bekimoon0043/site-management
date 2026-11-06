@echo off
rem Starts the local .mpp -> MS Project XML converter (server.py) on port %MPP_PORT% (default 8787).
setlocal
set "HERE=%~dp0"
if not defined JAVA_HOME if exist "%USERPROFILE%\android-toolchain\jdk17\bin\java.exe" set "JAVA_HOME=%USERPROFILE%\android-toolchain\jdk17"
set "ENVFILE=%HERE%..\..\web\.env"
if exist "%ENVFILE%" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ENVFILE%") do (
    if /i "%%A"=="VITE_SUPABASE_URL" if not defined SUPABASE_URL set "SUPABASE_URL=%%B"
    if /i "%%A"=="VITE_SUPABASE_ANON_KEY" if not defined SUPABASE_ANON_KEY set "SUPABASE_ANON_KEY=%%B"
  )
)
set "PY=%HERE%.venv\Scripts\python.exe"
if not exist "%PY%" (
  echo Python venv not found at %PY% - see README.md for setup.
  exit /b 1
)
echo JAVA_HOME=%JAVA_HOME%
echo SUPABASE_URL=%SUPABASE_URL%
"%PY%" "%HERE%server.py"
