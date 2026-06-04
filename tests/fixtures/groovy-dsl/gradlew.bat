@echo off
REM Fake gradlew.bat for the groovy-dsl fixture (Windows twin). Emits the same
REM per-module unit-test tasks on `tasks --all --quiet` as the POSIX gradlew.
setlocal enabledelayedexpansion
for %%a in (%*) do (
  set "arg=%%~a"
  if "!arg!"=="tasks" (
    echo app:testDebugUnitTest - Runs the debug unit tests.
    echo app:test - Runs all unit tests.
    echo core-lib:test - Runs all unit tests.
    echo data:testDebugUnitTest - Runs the debug unit tests.
    echo data:test - Runs all unit tests.
    exit /b 0
  )
)
echo BUILD SUCCESSFUL in 1s
exit /b 0
