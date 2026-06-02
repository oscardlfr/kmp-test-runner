@echo off
REM Fake gradlew.bat for the flavored-unit-only fixture (Windows twin). Emits
REM :app's flavored unit-test tasks + umbrella `test` and the true-negative
REM :instrumented-only's connected tasks when the probe runs `tasks --all
REM --quiet`. Flavors come from the ROOT convention, so :app's build file stays
REM flavor-free and only the probe reveals the flavored task graph.
setlocal enabledelayedexpansion
for %%a in (%*) do (
  set "arg=%%~a"
  if "!arg!"=="tasks" (
    echo app:testDemoDebugUnitTest - Runs the demoDebug unit tests.
    echo app:testProdDebugUnitTest - Runs the prodDebug unit tests.
    echo app:testDemoReleaseUnitTest - Runs the demoRelease unit tests.
    echo app:testProdReleaseUnitTest - Runs the prodRelease unit tests.
    echo app:test - Runs all unit tests.
    echo instrumented-only:connectedDebugAndroidTest - Runs the debug instrumented tests.
    echo instrumented-only:connectedAndroidTest - Runs all instrumented tests.
    exit /b 0
  )
)
echo BUILD SUCCESSFUL in 1s
exit /b 0
