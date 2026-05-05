# kmp-test-runner — changed-modules orchestrator wrapper (Node-backed since v0.8).
# Logic lives in lib/changed-orchestrator.js. This wrapper passes argv through
# verbatim. PRODUCT.md "logic in Node, plumbing in shell".
$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $ScriptDir '..\..\lib\runner.js') changed @args
exit $LASTEXITCODE
