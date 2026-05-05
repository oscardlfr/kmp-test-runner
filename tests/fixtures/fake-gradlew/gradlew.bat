@echo off
REM Fake gradlew.bat for e2e integration tests of lib/orchestrator-utils.js#spawnGradle.
REM Mimics gradle's stdout shape so classifyTaskResults can correctly identify
REM per-task pass/fail. Reads task names from %* and prints "> Task <name>" for
REM each, then "BUILD SUCCESSFUL in 1s" or "BUILD FAILED in 1s" depending on
REM the KMP_FAKE_GRADLE_FAIL env var.
REM
REM Existence proof: this script being invoked at all proves spawnGradle bypassed
REM Node 18.20.2+ EINVAL block on direct .bat execution. The orchestrator records
REM stdout in real spawnSync result; tests assert on that result.
setlocal enabledelayedexpansion
set "FAIL=%KMP_FAKE_GRADLE_FAIL%"
echo > Task :app:compileKotlin
for %%a in (%*) do (
  set "arg=%%~a"
  if "!arg:~0,1!"==":" (
    if defined FAIL (
      echo ^> Task !arg! FAILED
    ) else (
      echo ^> Task !arg!
    )
  )
)
if defined FAIL (
  echo BUILD FAILED in 1s
  exit /b 1
) else (
  echo BUILD SUCCESSFUL in 1s
  exit /b 0
)
