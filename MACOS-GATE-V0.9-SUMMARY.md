# v0.9 macOS validation gate — summary

Generated: 2026-05-06T20:49:07.901Z
Mode: `probe`
Output cells: 45
Repo HEAD: `dc83772`

## Bucket counts

| Bucket | Count |
|---|---|
| PLANNED | 0 |
| PASS | 44 |
| DRIFT | 0 |
| SKIP | 1 |
| ERROR | 0 |
| TIMEOUT | 0 |
| ABSENT | 0 |
| **Total** | **45** |

## Cells

| Subcommand | Test type | Project | Bucket | Duration | Notes |
|---|---|---|---|---|---|
| parallel | all | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | common | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | androidUnit | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | androidInstrumented | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | desktop | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | ios | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | macos | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | all | shared-kmp-libs | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | common | shared-kmp-libs | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | androidUnit | shared-kmp-libs | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | androidInstrumented | shared-kmp-libs | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | desktop | shared-kmp-libs | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | ios | shared-kmp-libs | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | macos | shared-kmp-libs | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | all | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | common | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | androidUnit | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | androidInstrumented | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | desktop | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | ios | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| parallel | macos | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | all | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | common | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | androidUnit | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | androidInstrumented | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | desktop | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | ios | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | macos | fixture | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | all | shared-kmp-libs | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | common | shared-kmp-libs | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | androidUnit | shared-kmp-libs | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | androidInstrumented | shared-kmp-libs | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | desktop | shared-kmp-libs | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | ios | shared-kmp-libs | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | macos | shared-kmp-libs | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | all | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | common | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | androidUnit | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | androidInstrumented | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | desktop | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | ios | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| changed | macos | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |
| android | n/a | fixture | SKIP | – | no-instrumented-target |
| android | n/a | shared-kmp-libs | PASS | 1s | envelope shape matches snapshot (exit 0) |
| android | n/a | KaMPKit | PASS | 0s | envelope shape matches snapshot (exit 0) |

## Forensic artifacts

Per-cell stdout / stderr / envelope / meta live under `.smoke/macos-gate-v0.9/`.
Filename pattern: `<subcommand>_<testType|none>_<project>.{out,err,json,meta.json}`.
