@echo off
REM Fake gradlew.bat for the convention-flavors fixture (Windows twin). Emits the
REM flavored unit-test + per-variant AGP coverage report tasks for both modules
REM when the project-model probe runs `tasks --all --quiet`. Flavors + jacoco are
REM applied by the ROOT build.gradle.kts convention, so the module build files
REM stay flavor-/coverage-free and only the probe reveals the flavored task graph.
setlocal enabledelayedexpansion
for %%a in (%*) do (
  set "arg=%%~a"
  if "!arg!"=="tasks" (
    echo app:testDemoDebugUnitTest - Runs the demoDebug unit tests.
    echo app:testProdDebugUnitTest - Runs the prodDebug unit tests.
    echo app:testDemoReleaseUnitTest - Runs the demoRelease unit tests.
    echo app:testProdReleaseUnitTest - Runs the prodRelease unit tests.
    echo app:test - Runs all unit tests.
    echo app:createDemoDebugUnitTestCoverageReport - Creates the demoDebug unit-test coverage report.
    echo app:createProdDebugUnitTestCoverageReport - Creates the prodDebug unit-test coverage report.
    echo app:connectedDemoDebugAndroidTest - Runs the demoDebug instrumented tests.
    echo app:connectedProdDebugAndroidTest - Runs the prodDebug instrumented tests.
    echo app:connectedAndroidTest - Runs all instrumented tests.
    echo core-foo:testDemoDebugUnitTest - Runs the demoDebug unit tests.
    echo core-foo:testProdDebugUnitTest - Runs the prodDebug unit tests.
    echo core-foo:testDemoReleaseUnitTest - Runs the demoRelease unit tests.
    echo core-foo:testProdReleaseUnitTest - Runs the prodRelease unit tests.
    echo core-foo:test - Runs all unit tests.
    echo core-foo:createDemoDebugUnitTestCoverageReport - Creates the demoDebug unit-test coverage report.
    echo core-foo:createProdDebugUnitTestCoverageReport - Creates the prodDebug unit-test coverage report.
    exit /b 0
  )
)
echo BUILD SUCCESSFUL in 1s
exit /b 0
