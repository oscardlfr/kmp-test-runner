# WET-AUDIT-V0.9-RELEASE

Generated: 2026-05-09T16:39:03.507Z
Mode: `reclassify`
Repo HEAD: see `git rev-parse HEAD` at run time.

Validates the post-989f57b surface (PRs #183/#184/#185 → 867df44+) end-to-end against 7 real projects + S22 Ultra. Explicit coverage of the new `isolated_runtime_race` rejection path and `schema_version:2` everywhere.

## Bucket counts

| Bucket | Count | Meaning |
|---|---|---|
| PASS | 52 | wet exit 0 + tests ran (or accepted exit set) |
| PASS-AS-EXPECTED | 5 | negative-test cell hit expected error code + exit |
| SKIP-legit | 6 | no testcases + legit reasons (no source set, etc.) |
| RED-repo | 2 | real test failures in the upstream project |
| RED-orchestrator | 0 | orchestrator-side break — investigate AND fix in-session |
| DRIFT | 0 | envelope contract divergence (schema_version, etc.) — investigate |
| TIMEOUT | 0 | process timed out (likely orchestrator hang) |
| ABSENT | 0 | reclassify saw no captured artifacts |

**Total cells:** 65

## Per-cell results

| Cell | Project | Kind | Bucket | Duration | Exit | Schema | Codes | Reason |
|---|---|---|---|---|---|---|---|---|
| sanity_doctor__shared-kmp-libs | shared-kmp-libs | sanity-doctor | PASS | 1s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| sanity_info__shared-kmp-libs | shared-kmp-libs | sanity-info | PASS | 1s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| sanity_doctor__DawSync | DawSync | sanity-doctor | PASS | 1s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| sanity_info__DawSync | DawSync | sanity-info | PASS | 1s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| sanity_doctor__OmniSound | OmniSound | sanity-doctor | PASS | 1s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| sanity_info__OmniSound | OmniSound | sanity-info | PASS | 1s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| sanity_doctor__dipatternsdemo | dipatternsdemo | sanity-doctor | PASS | 1s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| sanity_info__dipatternsdemo | dipatternsdemo | sanity-info | PASS | 1s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| sanity_doctor__TaskFlow | TaskFlow | sanity-doctor | PASS | 1s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| sanity_info__TaskFlow | TaskFlow | sanity-info | PASS | 1s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| sanity_doctor__KaMPKit | KaMPKit | sanity-doctor | PASS | 1s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| sanity_info__KaMPKit | KaMPKit | sanity-info | PASS | 1s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| sanity_doctor__PeopleInSpace | PeopleInSpace | sanity-doctor | PASS | 1s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| sanity_info__PeopleInSpace | PeopleInSpace | sanity-info | PASS | 1s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| discovery_describe_miss__shared-kmp-libs | shared-kmp-libs | discovery-describe-miss | PASS | 0s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| discovery_describe_hit__shared-kmp-libs | shared-kmp-libs | discovery-describe-hit | PASS | 0s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| discovery_describe_miss__DawSync | DawSync | discovery-describe-miss | PASS | 1s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| discovery_describe_hit__DawSync | DawSync | discovery-describe-hit | PASS | 0s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| discovery_describe_miss__OmniSound | OmniSound | discovery-describe-miss | PASS | 0s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| discovery_describe_hit__OmniSound | OmniSound | discovery-describe-hit | PASS | 0s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| discovery_describe_miss__dipatternsdemo | dipatternsdemo | discovery-describe-miss | PASS | 0s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| discovery_describe_hit__dipatternsdemo | dipatternsdemo | discovery-describe-hit | PASS | 0s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| discovery_describe_miss__TaskFlow | TaskFlow | discovery-describe-miss | PASS | 0s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| discovery_describe_hit__TaskFlow | TaskFlow | discovery-describe-hit | PASS | 0s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| discovery_describe_miss__KaMPKit | KaMPKit | discovery-describe-miss | PASS | 0s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| discovery_describe_hit__KaMPKit | KaMPKit | discovery-describe-hit | PASS | 0s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| discovery_describe_miss__PeopleInSpace | PeopleInSpace | discovery-describe-miss | PASS | 0s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| discovery_describe_hit__PeopleInSpace | PeopleInSpace | discovery-describe-hit | PASS | 0s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| plan_dry_run__shared-kmp-libs | shared-kmp-libs | plan-dry-run | PASS | 0s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| plan_list_only__shared-kmp-libs | shared-kmp-libs | plan-list-only | PASS | 2s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=69, schema=2) |
| plan_dry_run__DawSync | DawSync | plan-dry-run | PASS | 0s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| plan_list_only__DawSync | DawSync | plan-list-only | PASS | 2s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=21, schema=2) |
| plan_dry_run__OmniSound | OmniSound | plan-dry-run | PASS | 0s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| plan_list_only__OmniSound | OmniSound | plan-list-only | PASS | 1s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=11, schema=2) |
| plan_dry_run__dipatternsdemo | dipatternsdemo | plan-dry-run | PASS | 0s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| plan_list_only__dipatternsdemo | dipatternsdemo | plan-list-only | PASS | 1s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=3, schema=2) |
| plan_dry_run__TaskFlow | TaskFlow | plan-dry-run | PASS | 0s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| plan_list_only__TaskFlow | TaskFlow | plan-list-only | PASS | 1s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=1, schema=2) |
| plan_dry_run__KaMPKit | KaMPKit | plan-dry-run | PASS | 0s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| plan_list_only__KaMPKit | KaMPKit | plan-list-only | PASS | 1s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=1, schema=2) |
| plan_dry_run__PeopleInSpace | PeopleInSpace | plan-dry-run | PASS | 0s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| plan_list_only__PeopleInSpace | PeopleInSpace | plan-list-only | PASS | 1s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=3, schema=2) |
| wet_common__shared-kmp-libs | shared-kmp-libs | wet-common | PASS | 34s | 0 | 2 | – | 3875 testcases ran |
| wet_common__DawSync | DawSync | wet-common | RED-repo | 1m 10s | 1 | 2 | module_failed,module_failed,module_failed,module_failed,module_failed | module_failed (5 mod, 8282 testcases ran) |
| wet_common__dipatternsdemo | dipatternsdemo | wet-common | SKIP-legit | 1s | 0 | 2 | – | exit 0, no testcases (skip reasons: no test source set \| no common target (--test-type=common)) |
| wet_common__KaMPKit | KaMPKit | wet-common | SKIP-legit | 1s | 0 | 2 | – | exit 0, no testcases (skip reasons: no test source set \| no common target (--test-type=common)) |
| wet_common__PeopleInSpace | PeopleInSpace | wet-common | PASS | 10s | 0 | 2 | – | 8 testcases ran |
| wet_desktop__shared-kmp-libs | shared-kmp-libs | wet-desktop | PASS | 42s | 0 | 2 | – | 3875 testcases ran |
| wet_desktop__KaMPKit | KaMPKit | wet-desktop | SKIP-legit | 1s | 0 | 2 | – | exit 0, no testcases (skip reasons: no test source set \| no desktop target (--test-type=desktop)) |
| wet_desktop__PeopleInSpace | PeopleInSpace | wet-desktop | PASS | 3s | 0 | 2 | – | 8 testcases ran |
| neg_filter_nomatch__shared-kmp-libs | shared-kmp-libs | neg-filter | PASS-AS-EXPECTED | 2s | 2 | 2 | no_test_modules | errors[].code='no_test_modules' present, exit=2 |
| neg_iso_ios__shared-kmp-libs | shared-kmp-libs | neg-iso-ios | PASS-AS-EXPECTED | 2s | 2 | 2 | isolated_runtime_race | errors[].code='isolated_runtime_race' present, exit=2 |
| neg_iso_all__shared-kmp-libs | shared-kmp-libs | neg-iso-all | PASS-AS-EXPECTED | 2s | 2 | 2 | isolated_runtime_race | errors[].code='isolated_runtime_race' present, exit=2 |
| coverage_only__shared-kmp-libs | shared-kmp-libs | coverage-only | PASS | 18s | 0 | 2 | – | non-test cell exit 0; envelope healthy (modules=0, schema=2) |
| coverage_min_missed_zero__shared-kmp-libs | shared-kmp-libs | coverage-min-missed | PASS | 21s | 0 | 2 | – | 70 testcases ran |
| wet_full_parallel__shared-kmp-libs | shared-kmp-libs | wet-full-parallel | RED-repo | 5m 2s | 1 | 2 | module_failed | module_failed (1 mod, 7750 testcases ran) |
| pos_iso_common__shared-kmp-libs | shared-kmp-libs | pos-iso | PASS | 25s | 0 | 2 | – | 70 testcases ran |
| pos_iso_common__KaMPKit | KaMPKit | pos-iso | SKIP-legit | 1s | 0 | 2 | – | exit 0, no testcases (skip reasons: no common target (--test-type=common)) |
| wet_aunit__shared-kmp-libs | shared-kmp-libs | wet-aunit | SKIP-legit | 19s | 0 | 2 | – | exit 0, no testcases (skip reasons: no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit) \| no androidUnit target (--test-type=androidUnit)) |
| wet_aunit__DawSync | DawSync | wet-aunit | SKIP-legit | 3s | 0 | 2 | – | exit 0, no testcases (skip reasons: no test source set \| no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit) \| no androidUnit target (--test-type=androidUnit)) |
| wet_aunit__dipatternsdemo | dipatternsdemo | wet-aunit | PASS | 4s | 0 | 2 | – | 68 testcases ran |
| neg_iso_aint_no_device__DawSync | DawSync | neg-iso-aint | PASS-AS-EXPECTED | 1s | 2 | 2 | isolated_runtime_race | errors[].code='isolated_runtime_race' present, exit=2 |
| wet_aint_android_subcommand__shared-kmp-libs | shared-kmp-libs | wet-aint | PASS | 32s | 0 | 2 | – | 3 testcases ran |
| wet_aint_parallel_dipatternsdemo | dipatternsdemo | wet-aint-parallel | PASS | 4s | 0 | 2 | – | 1 testcases ran |
| neg_flavor_unused__DawSync | DawSync | neg-flavor | PASS-AS-EXPECTED | 1m 9s | 2 | 2 | flavor_unused | errors[].code='flavor_unused' present, exit=2 |

## Non-PASS cells (forensic detail)

### wet_common__DawSync — RED-repo

Project: DawSync
Kind: wet-common
Reason: module_failed (5 mod, 8282 testcases ran)
Exit code: 1
Schema version: 2
Error codes: module_failed, module_failed, module_failed, module_failed, module_failed

Forensic captures: `.smoke/wet-audit-v0.9-release/wet_common__DawSync.{out,err,json,meta.json}`

### wet_full_parallel__shared-kmp-libs — RED-repo

Project: shared-kmp-libs
Kind: wet-full-parallel
Reason: module_failed (1 mod, 7750 testcases ran)
Exit code: 1
Schema version: 2
Error codes: module_failed

Forensic captures: `.smoke/wet-audit-v0.9-release/wet_full_parallel__shared-kmp-libs.{out,err,json,meta.json}`

## Per-cell artifacts

Each cell wrote 4 files under `.smoke/wet-audit-v0.9-release/` (gitignored):

- `<id>.out` — stdout (envelope between `__KMP_TEST_ENVELOPE_V1_*__` markers)
- `<id>.err` — stderr (orchestrator log + gradle stderr)
- `<id>.json` — extracted JSON envelope (only when emitted)
- `<id>.meta.json` — run metadata (bucket, reason, exit, codes)
