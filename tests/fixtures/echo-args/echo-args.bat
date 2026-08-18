@echo off
REM Passes all args through to echo-args.mjs via node.
REM Used by Candidate B (PowerShell) proof in windows-metachar tests:
REM the .bat boundary is where cmd.exe might expand %VAR% patterns.
REM Invokes node via KMP_METACHAR_NODE_EXE (an absolute path the test itself sets to
REM process.execPath) rather than a bare `node` PATH lookup: on hosts where a PowerShell-routed
REM .bat's nested cmd.exe inherits an empty PATH regardless of what the caller passes, a bare-name
REM lookup here is never found even when the caller's own PATH is fully populated -- a custom,
REM non-PATH env var does not hit that same stripping.
if not defined KMP_METACHAR_NODE_EXE (
  echo echo-args.bat: KMP_METACHAR_NODE_EXE is not set 1>&2
  exit /b 1
)
"%KMP_METACHAR_NODE_EXE%" "%~dp0echo-args.mjs" %*
