@echo off
REM Fake gradlew.bat for the root-convention-jacoco fixture (Windows twin).
REM When the project-model probe runs `tasks --all --quiet`, emit the report +
REM test tasks for both modules. JaCoCo is applied via the ROOT build.gradle.kts
REM `subprojects {}` block, so jacocoTestReport exists on both modules even
REM though neither module's own build file references jacoco.
setlocal enabledelayedexpansion
for %%a in (%*) do (
  set "arg=%%~a"
  if "!arg!"=="tasks" (
    echo core-foo:compileKotlin - Compiles main Kotlin source.
    echo core-foo:test - Runs the unit test suite.
    echo core-foo:jacocoTestReport - Generates a JaCoCo coverage report.
    echo core-bar:compileKotlin - Compiles main Kotlin source.
    echo core-bar:test - Runs the unit test suite.
    echo core-bar:jacocoTestReport - Generates a JaCoCo coverage report.
    exit /b 0
  )
)
echo BUILD SUCCESSFUL in 1s
exit /b 0
