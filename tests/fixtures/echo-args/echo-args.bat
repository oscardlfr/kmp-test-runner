@echo off
REM Passes all args through to echo-args.mjs via node.
REM Used by Candidate B (PowerShell) proof in windows-metachar tests:
REM the .bat boundary is where cmd.exe might expand %VAR% patterns.
node "%~dp0echo-args.mjs" %*
