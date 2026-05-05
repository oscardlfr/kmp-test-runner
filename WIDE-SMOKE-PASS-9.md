# Wide-smoke pass-9 — post-fix-PR-A/D/B/C cumulative validation

Generated: 2026-05-04T17:41:26.331Z

Orchestrator HEAD: `0cd5432` (v0.8.0 fix-PR-C tip — A+D+B+C cumulative: source-set gate, KMP `androidLibrary{}` plugin opt-in, JDK preserve-host, `ANDROID_HOME` export for JVM legs).

Goal: zero regression vs pass-8 baseline (3 GREEN / 14 SKIP / 13 RED-repo / 0 cascade). Improvements expected on Bug A repros (orchestrator over-dispatch — shared-kmp-libs, dipatternsdemo, FileKit-main, WakeTheCave variants), Bug D repros (KMP `androidLibrary{}` plugin — shared-kmp-libs/:core-firebase-native), Bug B repros (JDK preserve-host notice — TaskFlow, Confetti), Bug C repros (`ANDROID_HOME` notice — Nav3Guide-scenes). Any flip from GREEN/SKIP → RED-orchestrator-cascade or RED-orchestrator blocks the v0.8.0 tag.

## Key findings

1. **0 cascade-isolation cases** — matches pass-8 baseline. PR5's execution-summary cascade signature continues to gate the retry path correctly post-fix-PR-A/D/B/C.

2. **13 legitimate RED-repo cases** — actual project test failures, out of scope for the v0.8.0 release tag. Affected: DawSync, dipatternsdemo, gyg, OmniSound, shared-kmp-libs, Confetti-main, nav3-recipes, nowinandroid, WakeTheCave, WakeTheCave_clean, WakeTheCave_ref, kotlinconf-app-main, PeopleInSpace-main.

3. **3 GREEN** — full sweep through orchestrator + JDK auto-select + tests passing: android-challenge, TaskFlow, FileKit-main.

4. **0 RED-orchestrator (other)** — every non-cascade orchestrator path is healthy post-fix-PR-A/D/B/C cumulative.

5. **fix-PR-A/D/B/C surface verified**: source-set gate (PR-A: androidUnit/androidInstrumented dispatch), KMP `androidLibrary{}` plugin opt-in detection (PR-D: testAndroidHostTest dispatch), JDK preserve-host when AGP floor met (PR-B), `ANDROID_HOME` export for JVM legs of AGP-applying projects (PR-C) — cumulative effect against the 30-project matrix.

## Bucket counts

| Bucket | Pass-8 baseline | Pass-9 actual | Δ |
|---|---|---|---|
| GREEN | 3 | 3 | 0 |
| SKIP | 14 | 14 | 0 |
| RED-repo | 13 | 13 | 0 |
| RED-orchestrator-cascade | 0 | 0 | 0 |
| RED-orchestrator | 0 | 0 | 0 |
| MISSING | 0 | 0 | 0 |
| **Total** | **30** | **30** | – |

## Summary table

| Project | Category | Bucket | Duration | Exit | Discriminators | Notes |
|---|---|---|---|---|---|---|
| android-challenge | PR3 | GREEN | 23s | 0 | – | 1 testcases ran |
| DawSync | PR3 | RED-repo | 11m 32s | 1 | module_failed×10 | cascade-isolation retry fired on all cascade legs [common, desktop] — modules independently broken at evaluation phase (not orchestrator bug). 10 module_failed, 16564 testcases ran in OTHER legs. |
| dipatternsdemo | PR3 | RED-repo | 27s | 1 | module_failed×2, task_not_found | cascade-isolation retry fired on all cascade legs [androidInstrumented] — modules independently broken at evaluation phase (not orchestrator bug). 2 module_failed, 68 testcases ran in OTHER legs. |
| dokka-markdown-plugin | PR3 | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| gyg | PR3 | RED-repo | 1m 6s | 3 | no_test_modules×2, module_failed×2 | module_failed discriminator (2 module(s), 30 testcases ran) |
| OmniSound | PR3 | RED-repo | 4m 59s | 1 | module_failed×14 | cascade-isolation retry fired on all cascade legs [common, desktop] — modules independently broken at evaluation phase (not orchestrator bug). 14 module_failed, 3630 testcases ran in OTHER legs. |
| shared-kmp-libs | PR3 | RED-repo | 6m 41s | 1 | module_failed×135, unsupported_class_version | module_failed discriminator (135 module(s), 812 testcases ran) |
| TaskFlow | PR3 | GREEN | 23s | 0 | – | 1 testcases ran |
| Confetti-main | INTERESTING | RED-repo | 47s | 1 | module_failed, unsupported_class_version | module_failed discriminator (1 module(s), 133 testcases ran) |
| DroidconKotlin-main | INTERESTING | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| KMedia-main | INTERESTING | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| kmp-production-sample-master | INTERESTING | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| nav3-recipes | INTERESTING | RED-repo | 50s | 1 | module_failed | cascade-isolation retry fired on all cascade legs [androidUnit] — modules independently broken at evaluation phase (not orchestrator bug). 1 module_failed, 0 testcases ran in OTHER legs. |
| Nav3Guide-scenes | INTERESTING | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| nowinandroid | INTERESTING | RED-repo | 19s | 3 | module_failed×2, no_test_modules×2 | module_failed discriminator (2 module(s), 8 testcases ran) |
| NYTimes-KMP-main | INTERESTING | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| AndroidCommonDoc-build-logic | NEW | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| AndroidCommonDoc-detekt-rules | NEW | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| AndroidCommonDoc-konsist-tests | NEW | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| kmp-test-runner-gradle-plugin | NEW | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| WakeTheCave | NEW | RED-repo | 1m 3s | 1 | module_failed×60 | cascade-isolation retry fired on all cascade legs [common, desktop, androidUnit, androidInstrumented] — modules independently broken at evaluation phase (not orchestrator bug). 60 module_failed, 0 testcases ran in OTHER legs. |
| WakeTheCave_clean | NEW | RED-repo | 40s | 1 | module_failed×47 | cascade-isolation retry fired on all cascade legs [common, desktop, androidUnit, androidInstrumented] — modules independently broken at evaluation phase (not orchestrator bug). 47 module_failed, 0 testcases ran in OTHER legs. |
| WakeTheCave_ref | NEW | RED-repo | 17s | 3 | no_test_modules×2, module_failed×19 | cascade-isolation retry fired on all cascade legs [androidUnit, androidInstrumented] — modules independently broken at evaluation phase (not orchestrator bug). 19 module_failed, 0 testcases ran in OTHER legs. |
| FileKit-main | NEW | GREEN | 8s | 0 | – | 56 testcases ran |
| androidify-main | NEW | SKIP | 1s | 3 | no_test_modules×4 | all errors are no_test_modules (legitimately empty) |
| KaMPKit-main | NEW | SKIP | 1s | 3 | no_test_modules×4 | all errors are no_test_modules (legitimately empty) |
| kmp-basic-sample-master | NEW | SKIP | 1s | 3 | no_test_modules×4 | all errors are no_test_modules (legitimately empty) |
| kotlinconf-app-main | NEW | RED-repo | 4m 32s | 1 | module_failed×2 | module_failed discriminator (2 module(s), 14 testcases ran) |
| Nav3Guide-master | NEW | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| PeopleInSpace-main | NEW | RED-repo | 1m 4s | 1 | module_failed | module_failed discriminator (1 module(s), 16 testcases ran) |

## Per-project envelopes (non-GREEN)

### DawSync — RED-repo

Path: `C:/Users/34645/AndroidStudioProjects/DawSync`
Category: PR3
Spawn exit: 1
Reason: cascade-isolation retry fired on all cascade legs [common, desktop] — modules independently broken at evaluation phase (not orchestrator bug). 10 module_failed, 16564 testcases ran in OTHER legs.

Envelope excerpt:
```json
{
  "exit_code": 1,
  "tests": {
    "total": 43,
    "passed": 33,
    "failed": 10,
    "skipped": 0,
    "individual_total": 16564
  },
  "errors": [
    {
      "code": "module_failed",
      "module": "core:data",
      "task": ":core:data:desktopTest",
      "message": "[FAIL] core:data"
    },
    {
      "code": "module_failed",
      "module": "desktopApp",
      "task": ":desktopApp:desktopTest",
      "message": "[FAIL] desktopApp"
    },
    {
      "code": "module_failed",
      "module": "feature:activity-log",
      "task": ":feature:activity-log:desktopTest",
      "message": "[FAIL] feature:activity-log"
    },
    {
      "code": "module_failed",
      "module": "feature:analytics",
      "task": ":feature:analytics:desktopTest",
      "message": "[FAIL] feature:analytics"
    },
    {
      "code": "module_failed",
      "module": "feature:sessions",
      "task": ":feature:sessions:desktopTest",
      "message": "[FAIL] feature:sessions"
    },
    {
      "code": "module_failed",
      "module": "core:data",
      "task": ":core:data:desktopTest",
      "message": "[FAIL] core:data"
    },
    {
      "code": "module_failed",
      "module": "desktopApp",
      "task": ":desktopApp:desktopTest",
      "message": "[FAIL] desktopApp"
    },
    {
      "code": "module_failed",
      "module": "feature:activity-log",
      "task": ":feature:activity-log:desktopTest",
      "message": "[FAIL] feature:activity-log"
    },
    {
      "code": "module_failed",
      "module": "feature:analytics",
      "task": ":feature:analytics:desktopTest",
      "message": "[FAIL] feature:analytics"
    },
    {
      "code": "module_failed",
      "module": "feature:sessions",
      "task": ":feature:sessions:desktopTest",
      "message": "[FAIL] feature:sessions"
    }
  ],
  "skipped": [
    {
      "module": "androidApp",
      "reason": "no test source set"
    },
    {
      "module": "core:testing",
      "reason": "no test source set"
    },
    {
      "module": "shared-ios",
      "reason": "no test source set"
    },
    {
      "module": "benchmark",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:audio",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:data",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:database",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:designsystem",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:domain",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:media-session",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:model",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:navigation",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "desktopApp",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "feature:action-history",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:activity-log",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:analytics",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:onboarding",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:projects",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:sessions",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:settings",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:snapshot-list",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:sync-status",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:workspace-management",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "konsist-guard",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "core:audio",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:data",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:database",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:designsystem",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:domain",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:media-session",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:model",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:navigation",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "desktopApp",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:action-history",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:activity-log",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:analytics",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:onboarding",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:projects",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:sessions",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:settings",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:snapshot-list",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:sync-status",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:workspace-management",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "konsist-guard",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    }
  ],
  "warnings": [
    {
      "code": "no_test_modules_for_leg",
      "message": "Leg 'androidUnit': No modules support the requested --test-type=androidUnit",
      "test_type": "androidUnit"
    }
  ],
  "parallel": {
    "test_type": "all",
    "max_workers": 0,
    "timeout_s": 900,
    "legs": [
      {
        "test_type": "common",
        "exit_code": 1,
        "execution": {
          "fresh": 5,
          "up_to_date": 0,
          "from_cache": 13,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 3
        }
      },
      {
        "test_type": "desktop",
        "exit_code": 1,
        "execution": {
          "fresh": 5,
          "up_to_date": 0,
          "from_cache": 13,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 3
        }
      },
      {
        "test_type": "androidUnit",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidInstrumented",
        "exit_code": 0,
        "execution": {
          "fresh": 1,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      }
    ]
  }
}
```

### dipatternsdemo — RED-repo

Path: `C:/Users/34645/AndroidStudioProjects/dipatternsdemo`
Category: PR3
Spawn exit: 1
Reason: cascade-isolation retry fired on all cascade legs [androidInstrumented] — modules independently broken at evaluation phase (not orchestrator bug). 2 module_failed, 68 testcases ran in OTHER legs.

Envelope excerpt:
```json
{
  "exit_code": 1,
  "tests": {
    "total": 3,
    "passed": 1,
    "failed": 2,
    "skipped": 0,
    "individual_total": 68
  },
  "errors": [
    {
      "code": "module_failed",
      "module": "benchmark",
      "task": ":benchmark:connectedDebugAndroidTest",
      "message": "[FAIL] benchmark"
    },
    {
      "code": "module_failed",
      "module": "sample-multimodule",
      "task": ":sample-multimodule:connectedDebugAndroidTest",
      "message": "[FAIL] sample-multimodule"
    },
    {
      "code": "task_not_found",
      "message": "Cannot locate tasks that match ':benchmark:connectedDebugAndroidTest' as task 'connectedDebugAndroidTest' not found in project ':benchmark'."
    }
  ],
  "skipped": [
    {
      "module": "di-contracts-koin",
      "reason": "no test source set"
    },
    {
      "module": "features:feature-ana-api",
      "reason": "no test source set"
    },
    {
      "module": "features:feature-ana-impl",
      "reason": "no test source set"
    },
    {
      "module": "features:feature-auth-api",
      "reason": "no test source set"
    },
    {
      "module": "features:feature-auth-impl",
      "reason": "no test source set"
    },
    {
      "module": "features:feature-core-impl",
      "reason": "no test source set"
    },
    {
      "module": "features:feature-enc-api",
      "reason": "no test source set"
    },
    {
      "module": "features:feature-enc-impl",
      "reason": "no test source set"
    },
    {
      "module": "features:feature-observability-impl",
      "reason": "no test source set"
    },
    {
      "module": "features:feature-stor-api",
      "reason": "no test source set"
    },
    {
      "module": "features:feature-stor-impl",
      "reason": "no test source set"
    },
    {
      "module": "features:feature-syn-api",
      "reason": "no test source set"
    },
    {
      "module": "features:feature-syn-impl",
      "reason": "no test source set"
    },
    {
      "module": "features:observability-api",
      "reason": "no test source set"
    },
    {
      "module": "sample-dagger-a",
      "reason": "no test source set"
    },
    {
      "module": "sample-dagger-b",
      "reason": "no test source set"
    },
    {
      "module": "sample-dagger-c",
      "reason": "no test source set"
    },
    {
      "module": "sample-hybrid",
      "reason": "no test source set"
    },
    {
      "module": "sdk:api",
      "reason": "no test source set"
    },
    {
      "module": "sdk:impl-common-d-c",
      "reason": "no test source set"
    },
    {
      "module": "sdk:impl-dagger-b",
      "reason": "no test source set"
    },
    {
      "module": "sdk:impl-dagger-c",
      "reason": "no test source set"
    },
    {
      "module": "sdk:impl-koin",
      "reason": "no test source set"
    },
    {
      "module": "sdk:sdk-wiring",
      "reason": "no test source set"
    },
    {
      "module": "sdk:wiring-e",
      "reason": "no test source set"
    },
    {
      "module": "sdk:wiring-e2",
      "reason": "no test source set"
    },
    {
      "module": "sdk:wiring-g",
      "reason": "no test source set"
    },
    {
      "module": "sdk:wiring-h",
      "reason": "no test source set"
    },
    {
      "module": "sdk:wiring-i",
      "reason": "no test source set"
    },
    {
      "module": "sdk:wiring-j",
      "reason": "no test source set"
    },
    {
      "module": "sdk:wiring-k",
      "reason": "no test source set"
    },
    {
      "module": "sdk:wiring-l",
      "reason": "no test source set"
    },
    {
      "module": "sdk:wiring-m",
      "reason": "no test source set"
    },
    {
      "module": "sdk:wiring-n",
      "reason": "no test source set"
    },
    {
      "module": "sdk:wiring-o",
      "reason": "no test source set"
    },
    {
      "module": "sdk:wiring-o2",
      "reason": "no test source set"
    },
    {
      "module": "sdk:wiring-p",
      "reason": "no test source set"
    },
    {
      "module": "sdk:wiring-p2",
      "reason": "no test source set"
    },
    {
      "module": "sdk:wiring-q",
      "reason": "no test source set"
    },
    {
      "module": "sdk:wiring-q2",
      "reason": "no test source set"
    },
    {
      "module": "benchmark",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "di-contracts",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "sample-multimodule",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "benchmark",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "di-contracts",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "sample-multimodule",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "benchmark",
      "reason": "no androidUnitTest source set (--test-type=androidUnit)"
    },
    {
      "module": "sample-multimodule",
      "reason": "no androidUnitTest source set (--test-type=androidUnit)"
    },
    {
      "module": "di-contracts",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    }
  ],
  "warnings": [
    {
      "code": "no_test_modules_for_leg",
      "message": "Leg 'common': No modules support the requested --test-type=common",
      "test_type": "common"
    },
    {
      "code": "no_test_modules_for_leg",
      "message": "Leg 'desktop': No modules support the requested --test-type=desktop",
      "test_type": "desktop"
    }
  ],
  "parallel": {
    "test_type": "all",
    "max_workers": 0,
    "timeout_s": 900,
    "legs": [
      {
        "test_type": "common",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "desktop",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidUnit",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 1,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidInstrumented",
        "exit_code": 1,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 2
        }
      }
    ]
  }
}
```

### dokka-markdown-plugin — SKIP

Path: `C:/Users/34645/AndroidStudioProjects/dokka-markdown-plugin`
Category: PR3
Spawn exit: 3
Reason: all errors are no_test_modules (legitimately empty)

Envelope excerpt:
```json
{
  "exit_code": 3,
  "tests": {
    "total": 0,
    "passed": 0,
    "failed": 0,
    "skipped": 0,
    "individual_total": 0
  },
  "errors": [
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=all",
      "test_type": "all"
    }
  ],
  "skipped": [],
  "warnings": []
}
```

### gyg — RED-repo

Path: `C:/Users/34645/AndroidStudioProjects/gyg`
Category: PR3
Spawn exit: 3
Reason: module_failed discriminator (2 module(s), 30 testcases ran)

Envelope excerpt:
```json
{
  "exit_code": 3,
  "tests": {
    "total": 2,
    "passed": 0,
    "failed": 2,
    "skipped": 0,
    "individual_total": 30
  },
  "errors": [
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=common",
      "test_type": "common"
    },
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=desktop",
      "test_type": "desktop"
    },
    {
      "code": "module_failed",
      "module": "app",
      "task": ":app:testDebugUnitTest",
      "message": "[FAIL] app"
    },
    {
      "code": "module_failed",
      "module": "app",
      "task": ":app:connectedDebugAndroidTest",
      "message": "[FAIL] app"
    }
  ],
  "skipped": [
    {
      "module": "app",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "app",
      "reason": "no desktop target (--test-type=desktop)"
    }
  ],
  "warnings": [],
  "parallel": {
    "test_type": "all",
    "max_workers": 0,
    "timeout_s": 900,
    "legs": [
      {
        "test_type": "common",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "desktop",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidUnit",
        "exit_code": 1,
        "execution": {
          "fresh": 1,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidInstrumented",
        "exit_code": 1,
        "execution": {
          "fresh": 1,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      }
    ]
  }
}
```

### OmniSound — RED-repo

Path: `C:/Users/34645/AndroidStudioProjects/OmniSound`
Category: PR3
Spawn exit: 1
Reason: cascade-isolation retry fired on all cascade legs [common, desktop] — modules independently broken at evaluation phase (not orchestrator bug). 14 module_failed, 3630 testcases ran in OTHER legs.

Envelope excerpt:
```json
{
  "exit_code": 1,
  "tests": {
    "total": 22,
    "passed": 8,
    "failed": 14,
    "skipped": 0,
    "individual_total": 3630
  },
  "errors": [
    {
      "code": "module_failed",
      "module": "core-data",
      "task": ":core-data:desktopTest",
      "message": "[FAIL] core-data"
    },
    {
      "code": "module_failed",
      "module": "feature-bandcamp",
      "task": ":feature-bandcamp:desktopTest",
      "message": "[FAIL] feature-bandcamp"
    },
    {
      "code": "module_failed",
      "module": "feature-discogs",
      "task": ":feature-discogs:desktopTest",
      "message": "[FAIL] feature-discogs"
    },
    {
      "code": "module_failed",
      "module": "feature-duplicates",
      "task": ":feature-duplicates:desktopTest",
      "message": "[FAIL] feature-duplicates"
    },
    {
      "code": "module_failed",
      "module": "feature-local-library",
      "task": ":feature-local-library:desktopTest",
      "message": "[FAIL] feature-local-library"
    },
    {
      "code": "module_failed",
      "module": "feature-soundcloud",
      "task": ":feature-soundcloud:desktopTest",
      "message": "[FAIL] feature-soundcloud"
    },
    {
      "code": "module_failed",
      "module": "feature-youtube",
      "task": ":feature-youtube:desktopTest",
      "message": "[FAIL] feature-youtube"
    },
    {
      "code": "module_failed",
      "module": "core-data",
      "task": ":core-data:desktopTest",
      "message": "[FAIL] core-data"
    },
    {
      "code": "module_failed",
      "module": "feature-bandcamp",
      "task": ":feature-bandcamp:desktopTest",
      "message": "[FAIL] feature-bandcamp"
    },
    {
      "code": "module_failed",
      "module": "feature-discogs",
      "task": ":feature-discogs:desktopTest",
      "message": "[FAIL] feature-discogs"
    },
    {
      "code": "module_failed",
      "module": "feature-duplicates",
      "task": ":feature-duplicates:desktopTest",
      "message": "[FAIL] feature-duplicates"
    },
    {
      "code": "module_failed",
      "module": "feature-local-library",
      "task": ":feature-local-library:desktopTest",
      "message": "[FAIL] feature-local-library"
    },
    {
      "code": "module_failed",
      "module": "feature-soundcloud",
      "task": ":feature-soundcloud:desktopTest",
      "message": "[FAIL] feature-soundcloud"
    },
    {
      "code": "module_failed",
      "module": "feature-youtube",
      "task": ":feature-youtube:desktopTest",
      "message": "[FAIL] feature-youtube"
    }
  ],
  "skipped": [
    {
      "module": "core-testing",
      "reason": "no test source set"
    },
    {
      "module": "desktopApp",
      "reason": "no test source set"
    },
    {
      "module": "core-data",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "core-database",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "core-designsystem",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "core-domain",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "core-model",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "feature-bandcamp",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "feature-discogs",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "feature-duplicates",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "feature-local-library",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "feature-soundcloud",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "feature-youtube",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "core-data",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "core-database",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "core-designsystem",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "core-domain",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "core-model",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature-bandcamp",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature-discogs",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature-duplicates",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature-local-library",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature-soundcloud",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature-youtube",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    }
  ],
  "warnings": [
    {
      "code": "no_test_modules_for_leg",
      "message": "Leg 'androidUnit': No modules support the requested --test-type=androidUnit",
      "test_type": "androidUnit"
    },
    {
      "code": "no_test_modules_for_leg",
      "message": "Leg 'androidInstrumented': No modules support the requested --test-type=androidInstrumented",
      "test_type": "androidInstrumented"
    }
  ],
  "parallel": {
    "test_type": "all",
    "max_workers": 0,
    "timeout_s": 900,
    "legs": [
      {
        "test_type": "common",
        "exit_code": 1,
        "execution": {
          "fresh": 0,
          "up_to_date": 4,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 7
        }
      },
      {
        "test_type": "desktop",
        "exit_code": 1,
        "execution": {
          "fresh": 0,
          "up_to_date": 4,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 7
        }
      },
      {
        "test_type": "androidUnit",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidInstrumented",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      }
    ]
  }
}
```

### shared-kmp-libs — RED-repo

Path: `C:/Users/34645/AndroidStudioProjects/shared-kmp-libs`
Category: PR3
Spawn exit: 1
Reason: module_failed discriminator (135 module(s), 812 testcases ran)

Envelope excerpt:
```json
{
  "exit_code": 1,
  "tests": {
    "total": 203,
    "passed": 68,
    "failed": 135,
    "skipped": 0,
    "individual_total": 812
  },
  "errors": [
    {
      "code": "module_failed",
      "module": "benchmark-crypto",
      "task": ":benchmark-crypto:desktopTest",
      "message": "[FAIL] benchmark-crypto"
    },
    {
      "code": "module_failed",
      "module": "benchmark-infra",
      "task": ":benchmark-infra:desktopTest",
      "message": "[FAIL] benchmark-infra"
    },
    {
      "code": "module_failed",
      "module": "benchmark-io",
      "task": ":benchmark-io:desktopTest",
      "message": "[FAIL] benchmark-io"
    },
    {
      "code": "module_failed",
      "module": "benchmark-network",
      "task": ":benchmark-network:desktopTest",
      "message": "[FAIL] benchmark-network"
    },
    {
      "code": "module_failed",
      "module": "benchmark-sdk",
      "task": ":benchmark-sdk:desktopTest",
      "message": "[FAIL] benchmark-sdk"
    },
    {
      "code": "module_failed",
      "module": "benchmark-storage",
      "task": ":benchmark-storage:desktopTest",
      "message": "[FAIL] benchmark-storage"
    },
    {
      "code": "module_failed",
      "module": "core-audit",
      "task": ":core-audit:desktopTest",
      "message": "[FAIL] core-audit"
    },
    {
      "code": "module_failed",
      "module": "core-auth-biometric",
      "task": ":core-auth-biometric:desktopTest",
      "message": "[FAIL] core-auth-biometric"
    },
    {
      "code": "module_failed",
      "module": "core-backend-api",
      "task": ":core-backend-api:desktopTest",
      "message": "[FAIL] core-backend-api"
    },
    {
      "code": "module_failed",
      "module": "core-billing-api",
      "task": ":core-billing-api:desktopTest",
      "message": "[FAIL] core-billing-api"
    },
    {
      "code": "module_failed",
      "module": "core-common",
      "task": ":core-common:desktopTest",
      "message": "[FAIL] core-common"
    },
    {
      "code": "module_failed",
      "module": "core-designsystem-foundation",
      "task": ":core-designsystem-foundation:desktopTest",
      "message": "[FAIL] core-designsystem-foundation"
    },
    {
      "code": "module_failed",
      "module": "core-di-anvil",
      "task": ":core-di-anvil:desktopTest",
      "message": "[FAIL] core-di-anvil"
    },
    {
      "code": "module_failed",
      "module": "core-domain",
      "task": ":core-domain:desktopTest",
      "message": "[FAIL] core-domain"
    },
    {
      "code": "module_failed",
      "module": "core-encryption",
      "task": ":core-encryption:desktopTest",
      "message": "[FAIL] core-encryption"
    },
    {
      "code": "module_failed",
      "module": "core-encryption-envelope",
      "task": ":core-encryption-envelope:desktopTest",
      "message": "[FAIL] core-encryption-envelope"
    },
    {
      "code": "module_failed",
      "module": "core-encryption-envelope-api",
      "task": ":core-encryption-envelope-api:desktopTest",
      "message": "[FAIL] core-encryption-envelope-api"
    },
    {
      "code": "module_failed",
      "module": "core-error",
      "task": ":core-error:desktopTest",
      "message": "[FAIL] core-error"
    },
    {
      "code": "module_failed",
      "module": "core-error-audit",
      "task": ":core-error-audit:desktopTest",
      "message": "[FAIL] core-error-audit"
    },
    {
      "code": "module_failed",
      "module": "core-error-backend",
      "task": ":core-error-backend:desktopTest",
      "message": "[FAIL] core-error-backend"
    },
    {
      "code": "module_failed",
      "module": "core-error-billing",
      "task": ":core-error-billing:desktopTest",
      "message": "[FAIL] core-error-billing"
    },
    {
      "code": "module_failed",
      "module": "core-error-biometric",
      "task": ":core-error-biometric:desktopTest",
      "message": "[FAIL] core-error-biometric"
    },
    {
      "code": "module_failed",
      "module": "core-error-encryption",
      "task": ":core-error-encryption:desktopTest",
      "message": "[FAIL] core-error-encryption"
    },
    {
      "code": "module_failed",
      "module": "core-error-firebase",
      "task": ":core-error-firebase:desktopTest",
      "message": "[FAIL] core-error-firebase"
    },
    {
      "code": "module_failed",
      "module": "core-error-gdpr",
      "task": ":core-error-gdpr:desktopTest",
      "message": "[FAIL] core-error-gdpr"
    },
    {
      "code": "module_failed",
      "module": "core-error-io",
      "task": ":core-error-io:desktopTest",
      "message": "[FAIL] core-error-io"
    },
    {
      "code": "module_failed",
      "module": "core-error-json",
      "task": ":core-error-json:desktopTest",
      "message": "[FAIL] core-error-json"
    },
    {
      "code": "module_failed",
      "module": "core-error-network",
      "task": ":core-error-network:desktopTest",
      "message": "[FAIL] core-error-network"
    },
    {
      "code": "module_failed",
      "module": "core-error-oauth",
      "task": ":core-error-oauth:desktopTest",
      "message": "[FAIL] core-error-oauth"
    },
    {
      "code": "module_failed",
      "module": "core-error-sdk",
      "task": ":core-error-sdk:desktopTest",
      "message": "[FAIL] core-error-sdk"
    },
    {
      "code": "module_failed",
      "module": "core-error-storage",
      "task": ":core-error-storage:desktopTest",
      "message": "[FAIL] core-error-storage"
    },
    {
      "code": "module_failed",
      "module": "core-error-storage-mmkv",
      "task": ":core-error-storage-mmkv:desktopTest",
      "message": "[FAIL] core-error-storage-mmkv"
    },
    {
      "code": "module_failed",
      "module": "core-firebase-api",
      "task": ":core-firebase-api:desktopTest",
      "message": "[FAIL] core-firebase-api"
    },
    {
      "code": "module_failed",
      "module": "core-firebase-native",
      "task": ":core-firebase-native:desktopTest",
      "message": "[FAIL] core-firebase-native"
    },
    {
      "code": "module_failed",
      "module": "core-firebase-rest",
      "task": ":core-firebase-rest:desktopTest",
      "message": "[FAIL] core-firebase-rest"
    },
    {
      "code": "module_failed",
      "module": "core-gdpr",
      "task": ":core-gdpr:desktopTest",
      "message": "[FAIL] core-gdpr"
    },
    {
      "code": "module_failed",
      "module": "core-io-api",
      "task": ":core-io-api:desktopTest",
      "message": "[FAIL] core-io-api"
    },
    {
      "code": "module_failed",
      "module": "core-io-kotlinxio",
      "task": ":core-io-kotlinxio:desktopTest",
      "message": "[FAIL] core-io-kotlinxio"
    },
    {
      "code": "module_failed",
      "module": "core-io-okio",
      "task": ":core-io-okio:desktopTest",
      "message": "[FAIL] core-io-okio"
    },
    {
      "code": "module_failed",
      "module": "core-io-watcher",
      "task": ":core-io-watcher:desktopTest",
      "message": "[FAIL] core-io-watcher"
    },
    {
      "code": "module_failed",
      "module": "core-json-api",
      "task": ":core-json-api:desktopTest",
      "message": "[FAIL] core-json-api"
    },
    {
      "code": "module_failed",
      "module": "core-json-kotlinx",
      "task": ":core-json-kotlinx:desktopTest",
      "message": "[FAIL] core-json-kotlinx"
    },
    {
      "code": "module_failed",
      "module": "core-logging",
      "task": ":core-logging:desktopTest",
      "message": "[FAIL] core-logging"
    },
    {
      "code": "module_failed",
      "module": "core-network-api",
      "task": ":core-network-api:desktopTest",
      "message": "[FAIL] core-network-api"
    },
    {
      "code": "module_failed",
      "module": "core-network-ktor",
      "task": ":core-network-ktor:desktopTest",
      "message": "[FAIL] core-network-ktor"
    },
    {
      "code": "module_failed",
      "module": "core-network-retrofit",
      "task": ":core-network-retrofit:desktopTest",
      "message": "[FAIL] core-network-retrofit"
    },
    {
      "code": "module_failed",
      "module": "core-oauth-1a",
      "task": ":core-oauth-1a:desktopTest",
      "message": "[FAIL] core-oauth-1a"
    },
    {
      "code": "module_failed",
      "module": "core-oauth-api",
      "task": ":core-oauth-api:desktopTest",
      "message": "[FAIL] core-oauth-api"
    },
    {
      "code": "module_failed",
      "module": "core-oauth-browser",
      "task": ":core-oauth-browser:desktopTest",
      "message": "[FAIL] core-oauth-browser"
    },
    {
      "code": "module_failed",
      "module": "core-oauth-native",
      "task": ":core-oauth-native:desktopTest",
      "message": "[FAIL] core-oauth-native"
    },
    {
      "code": "module_failed",
      "module": "core-result",
      "task": ":core-result:desktopTest",
      "message": "[FAIL] core-result"
    },
    {
      "code": "module_failed",
      "module": "core-sdk",
      "task": ":core-sdk:desktopTest",
      "message": "[FAIL] core-sdk"
    },
    {
      "code": "module_failed",
      "module": "core-security-keys",
      "task": ":core-security-keys:desktopTest",
      "message": "[FAIL] core-security-keys"
    },
    {
      "code": "module_failed",
      "module": "core-storage-api",
      "task": ":core-storage-api:desktopTest",
      "message": "[FAIL] core-storage-api"
    },
    {
      "code": "module_failed",
      "module": "core-storage-cache",
      "task": ":core-storage-cache:desktopTest",
      "message": "[FAIL] core-storage-cache"
    },
    {
      "code": "module_failed",
      "module": "core-storage-datastore",
      "task": ":core-storage-datastore:desktopTest",
      "message": "[FAIL] core-storage-datastore"
    },
    {
      "code": "module_failed",
      "module": "core-storage-encryption",
      "task": ":core-storage-encryption:desktopTest",
      "message": "[FAIL] core-storage-encryption"
    },
    {
      "code": "module_failed",
      "module": "core-storage-mmkv",
      "task": ":core-storage-mmkv:desktopTest",
      "message": "[FAIL] core-storage-mmkv"
    },
    {
      "code": "module_failed",
      "module": "core-storage-secure",
      "task": ":core-storage-secure:desktopTest",
      "message": "[FAIL] core-storage-secure"
    },
    {
      "code": "module_failed",
      "module": "core-storage-settings",
      "task": ":core-storage-settings:desktopTest",
      "message": "[FAIL] core-storage-settings"
    },
    {
      "code": "module_failed",
      "module": "core-storage-sql",
      "task": ":core-storage-sql:desktopTest",
      "message": "[FAIL] core-storage-sql"
    },
    {
      "code": "module_failed",
      "module": "core-storage-sql-cipher",
      "task": ":core-storage-sql-cipher:desktopTest",
      "message": "[FAIL] core-storage-sql-cipher"
    },
    {
      "code": "module_failed",
      "module": "core-subscription",
      "task": ":core-subscription:desktopTest",
      "message": "[FAIL] core-subscription"
    },
    {
      "code": "module_failed",
      "module": "core-system",
      "task": ":core-system:desktopTest",
      "message": "[FAIL] core-system"
    },
    {
      "code": "module_failed",
      "module": "core-system-api",
      "task": ":core-system-api:desktopTest",
      "message": "[FAIL] core-system-api"
    },
    {
      "code": "module_failed",
      "module": "core-testing",
      "task": ":core-testing:desktopTest",
      "message": "[FAIL] core-testing"
    },
    {
      "code": "module_failed",
      "module": "core-version",
      "task": ":core-version:desktopTest",
      "message": "[FAIL] core-version"
    },
    {
      "code": "module_failed",
      "module": "benchmark-crypto",
      "task": ":benchmark-crypto:desktopTest",
      "message": "[FAIL] benchmark-crypto"
    },
    {
      "code": "module_failed",
      "module": "benchmark-infra",
      "task": ":benchmark-infra:desktopTest",
      "message": "[FAIL] benchmark-infra"
    },
    {
      "code": "module_failed",
      "module": "benchmark-io",
      "task": ":benchmark-io:desktopTest",
      "message": "[FAIL] benchmark-io"
    },
    {
      "code": "module_failed",
      "module": "benchmark-network",
      "task": ":benchmark-network:desktopTest",
      "message": "[FAIL] benchmark-network"
    },
    {
      "code": "module_failed",
      "module": "benchmark-sdk",
      "task": ":benchmark-sdk:desktopTest",
      "message": "[FAIL] benchmark-sdk"
    },
    {
      "code": "module_failed",
      "module": "benchmark-storage",
      "task": ":benchmark-storage:desktopTest",
      "message": "[FAIL] benchmark-storage"
    },
    {
      "code": "module_failed",
      "module": "core-audit",
      "task": ":core-audit:desktopTest",
      "message": "[FAIL] core-audit"
    },
    {
      "code": "module_failed",
      "module": "core-auth-biometric",
      "task": ":core-auth-biometric:desktopTest",
      "message": "[FAIL] core-auth-biometric"
    },
    {
      "code": "module_failed",
      "module": "core-backend-api",
      "task": ":core-backend-api:desktopTest",
      "message": "[FAIL] core-backend-api"
    },
    {
      "code": "module_failed",
      "module": "core-billing-api",
      "task": ":core-billing-api:desktopTest",
      "message": "[FAIL] core-billing-api"
    },
    {
      "code": "module_failed",
      "module": "core-common",
      "task": ":core-common:desktopTest",
      "message": "[FAIL] core-common"
    },
    {
      "code": "module_failed",
      "module": "core-designsystem-foundation",
      "task": ":core-designsystem-foundation:desktopTest",
      "message": "[FAIL] core-designsystem-foundation"
    },
    {
      "code": "module_failed",
      "module": "core-di-anvil",
      "task": ":core-di-anvil:desktopTest",
      "message": "[FAIL] core-di-anvil"
    },
    {
      "code": "module_failed",
      "module": "core-domain",
      "task": ":core-domain:desktopTest",
      "message": "[FAIL] core-domain"
    },
    {
      "code": "module_failed",
      "module": "core-encryption",
      "task": ":core-encryption:desktopTest",
      "message": "[FAIL] core-encryption"
    },
    {
      "code": "module_failed",
      "module": "core-encryption-envelope",
      "task": ":core-encryption-envelope:desktopTest",
      "message": "[FAIL] core-encryption-envelope"
    },
    {
      "code": "module_failed",
      "module": "core-encryption-envelope-api",
      "task": ":core-encryption-envelope-api:desktopTest",
      "message": "[FAIL] core-encryption-envelope-api"
    },
    {
      "code": "module_failed",
      "module": "core-error",
      "task": ":core-error:desktopTest",
      "message": "[FAIL] core-error"
    },
    {
      "code": "module_failed",
      "module": "core-error-audit",
      "task": ":core-error-audit:desktopTest",
      "message": "[FAIL] core-error-audit"
    },
    {
      "code": "module_failed",
      "module": "core-error-backend",
      "task": ":core-error-backend:desktopTest",
      "message": "[FAIL] core-error-backend"
    },
    {
      "code": "module_failed",
      "module": "core-error-billing",
      "task": ":core-error-billing:desktopTest",
      "message": "[FAIL] core-error-billing"
    },
    {
      "code": "module_failed",
      "module": "core-error-biometric",
      "task": ":core-error-biometric:desktopTest",
      "message": "[FAIL] core-error-biometric"
    },
    {
      "code": "module_failed",
      "module": "core-error-encryption",
      "task": ":core-error-encryption:desktopTest",
      "message": "[FAIL] core-error-encryption"
    },
    {
      "code": "module_failed",
      "module": "core-error-firebase",
      "task": ":core-error-firebase:desktopTest",
      "message": "[FAIL] core-error-firebase"
    },
    {
      "code": "module_failed",
      "module": "core-error-gdpr",
      "task": ":core-error-gdpr:desktopTest",
      "message": "[FAIL] core-error-gdpr"
    },
    {
      "code": "module_failed",
      "module": "core-error-io",
      "task": ":core-error-io:desktopTest",
      "message": "[FAIL] core-error-io"
    },
    {
      "code": "module_failed",
      "module": "core-error-json",
      "task": ":core-error-json:desktopTest",
      "message": "[FAIL] core-error-json"
    },
    {
      "code": "module_failed",
      "module": "core-error-network",
      "task": ":core-error-network:desktopTest",
      "message": "[FAIL] core-error-network"
    },
    {
      "code": "module_failed",
      "module": "core-error-oauth",
      "task": ":core-error-oauth:desktopTest",
      "message": "[FAIL] core-error-oauth"
    },
    {
      "code": "module_failed",
      "module": "core-error-sdk",
      "task": ":core-error-sdk:desktopTest",
      "message": "[FAIL] core-error-sdk"
    },
    {
      "code": "module_failed",
      "module": "core-error-storage",
      "task": ":core-error-storage:desktopTest",
      "message": "[FAIL] core-error-storage"
    },
    {
      "code": "module_failed",
      "module": "core-error-storage-mmkv",
      "task": ":core-error-storage-mmkv:desktopTest",
      "message": "[FAIL] core-error-storage-mmkv"
    },
    {
      "code": "module_failed",
      "module": "core-firebase-api",
      "task": ":core-firebase-api:desktopTest",
      "message": "[FAIL] core-firebase-api"
    },
    {
      "code": "module_failed",
      "module": "core-firebase-native",
      "task": ":core-firebase-native:desktopTest",
      "message": "[FAIL] core-firebase-native"
    },
    {
      "code": "module_failed",
      "module": "core-firebase-rest",
      "task": ":core-firebase-rest:desktopTest",
      "message": "[FAIL] core-firebase-rest"
    },
    {
      "code": "module_failed",
      "module": "core-gdpr",
      "task": ":core-gdpr:desktopTest",
      "message": "[FAIL] core-gdpr"
    },
    {
      "code": "module_failed",
      "module": "core-io-api",
      "task": ":core-io-api:desktopTest",
      "message": "[FAIL] core-io-api"
    },
    {
      "code": "module_failed",
      "module": "core-io-kotlinxio",
      "task": ":core-io-kotlinxio:desktopTest",
      "message": "[FAIL] core-io-kotlinxio"
    },
    {
      "code": "module_failed",
      "module": "core-io-okio",
      "task": ":core-io-okio:desktopTest",
      "message": "[FAIL] core-io-okio"
    },
    {
      "code": "module_failed",
      "module": "core-io-watcher",
      "task": ":core-io-watcher:desktopTest",
      "message": "[FAIL] core-io-watcher"
    },
    {
      "code": "module_failed",
      "module": "core-json-api",
      "task": ":core-json-api:desktopTest",
      "message": "[FAIL] core-json-api"
    },
    {
      "code": "module_failed",
      "module": "core-json-kotlinx",
      "task": ":core-json-kotlinx:desktopTest",
      "message": "[FAIL] core-json-kotlinx"
    },
    {
      "code": "module_failed",
      "module": "core-logging",
      "task": ":core-logging:desktopTest",
      "message": "[FAIL] core-logging"
    },
    {
      "code": "module_failed",
      "module": "core-network-api",
      "task": ":core-network-api:desktopTest",
      "message": "[FAIL] core-network-api"
    },
    {
      "code": "module_failed",
      "module": "core-network-ktor",
      "task": ":core-network-ktor:desktopTest",
      "message": "[FAIL] core-network-ktor"
    },
    {
      "code": "module_failed",
      "module": "core-network-retrofit",
      "task": ":core-network-retrofit:desktopTest",
      "message": "[FAIL] core-network-retrofit"
    },
    {
      "code": "module_failed",
      "module": "core-oauth-1a",
      "task": ":core-oauth-1a:desktopTest",
      "message": "[FAIL] core-oauth-1a"
    },
    {
      "code": "module_failed",
      "module": "core-oauth-api",
      "task": ":core-oauth-api:desktopTest",
      "message": "[FAIL] core-oauth-api"
    },
    {
      "code": "module_failed",
      "module": "core-oauth-browser",
      "task": ":core-oauth-browser:desktopTest",
      "message": "[FAIL] core-oauth-browser"
    },
    {
      "code": "module_failed",
      "module": "core-oauth-native",
      "task": ":core-oauth-native:desktopTest",
      "message": "[FAIL] core-oauth-native"
    },
    {
      "code": "module_failed",
      "module": "core-result",
      "task": ":core-result:desktopTest",
      "message": "[FAIL] core-result"
    },
    {
      "code": "module_failed",
      "module": "core-sdk",
      "task": ":core-sdk:desktopTest",
      "message": "[FAIL] core-sdk"
    },
    {
      "code": "module_failed",
      "module": "core-security-keys",
      "task": ":core-security-keys:desktopTest",
      "message": "[FAIL] core-security-keys"
    },
    {
      "code": "module_failed",
      "module": "core-storage-api",
      "task": ":core-storage-api:desktopTest",
      "message": "[FAIL] core-storage-api"
    },
    {
      "code": "module_failed",
      "module": "core-storage-cache",
      "task": ":core-storage-cache:desktopTest",
      "message": "[FAIL] core-storage-cache"
    },
    {
      "code": "module_failed",
      "module": "core-storage-datastore",
      "task": ":core-storage-datastore:desktopTest",
      "message": "[FAIL] core-storage-datastore"
    },
    {
      "code": "module_failed",
      "module": "core-storage-encryption",
      "task": ":core-storage-encryption:desktopTest",
      "message": "[FAIL] core-storage-encryption"
    },
    {
      "code": "module_failed",
      "module": "core-storage-mmkv",
      "task": ":core-storage-mmkv:desktopTest",
      "message": "[FAIL] core-storage-mmkv"
    },
    {
      "code": "module_failed",
      "module": "core-storage-secure",
      "task": ":core-storage-secure:desktopTest",
      "message": "[FAIL] core-storage-secure"
    },
    {
      "code": "module_failed",
      "module": "core-storage-settings",
      "task": ":core-storage-settings:desktopTest",
      "message": "[FAIL] core-storage-settings"
    },
    {
      "code": "module_failed",
      "module": "core-storage-sql",
      "task": ":core-storage-sql:desktopTest",
      "message": "[FAIL] core-storage-sql"
    },
    {
      "code": "module_failed",
      "module": "core-storage-sql-cipher",
      "task": ":core-storage-sql-cipher:desktopTest",
      "message": "[FAIL] core-storage-sql-cipher"
    },
    {
      "code": "module_failed",
      "module": "core-subscription",
      "task": ":core-subscription:desktopTest",
      "message": "[FAIL] core-subscription"
    },
    {
      "code": "module_failed",
      "module": "core-system",
      "task": ":core-system:desktopTest",
      "message": "[FAIL] core-system"
    },
    {
      "code": "module_failed",
      "module": "core-system-api",
      "task": ":core-system-api:desktopTest",
      "message": "[FAIL] core-system-api"
    },
    {
      "code": "module_failed",
      "module": "core-testing",
      "task": ":core-testing:desktopTest",
      "message": "[FAIL] core-testing"
    },
    {
      "code": "module_failed",
      "module": "core-version",
      "task": ":core-version:desktopTest",
      "message": "[FAIL] core-version"
    },
    {
      "code": "module_failed",
      "module": "benchmark-storage",
      "task": ":benchmark-storage:connectedAndroidDeviceTest",
      "message": "[FAIL] benchmark-storage"
    },
    {
      "code": "unsupported_class_version",
      "message": "UnsupportedClassVersionError at ClassLoader.java:-2"
    }
  ],
  "skipped": [
    {
      "module": "benchmark-crypto",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "benchmark-infra",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "benchmark-io",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "benchmark-network",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "benchmark-sdk",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "benchmark-storage",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-audit",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-auth-biometric",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-backend-api",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-billing-api",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-common",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-designsystem-foundation",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-di-anvil",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-domain",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-encryption",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-encryption-envelope",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-encryption-envelope-api",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-error",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-error-audit",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-error-backend",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-error-billing",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-error-biometric",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-error-encryption",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-error-firebase",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-error-gdpr",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-error-io",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-error-json",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-error-network",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-error-oauth",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-error-sdk",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-error-storage",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-error-storage-mmkv",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-firebase-api",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-firebase-native",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-firebase-rest",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-gdpr",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-io-api",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-io-kotlinxio",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-io-okio",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-io-watcher",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-json-api",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-json-kotlinx",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-logging",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-network-api",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-network-ktor",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-network-retrofit",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-oauth-1a",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "core-oauth-api",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-oauth-browser",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "core-oauth-native",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-result",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-sdk",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-security-keys",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-storage-api",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-storage-cache",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-storage-datastore",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-storage-encryption",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-storage-mmkv",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-storage-secure",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-storage-settings",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-storage-sql",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-storage-sql-cipher",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-subscription",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-system",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-system-api",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-testing",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core-version",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "detekt-rules-l1",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "konsist-guard",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "core-oauth-1a",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "core-oauth-browser",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "detekt-rules-l1",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "konsist-guard",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    }
  ],
  "warnings": [
    {
      "code": "no_test_modules_for_leg",
      "message": "Leg 'androidUnit': No modules support the requested --test-type=androidUnit",
      "test_type": "androidUnit"
    }
  ],
  "parallel": {
    "test_type": "all",
    "max_workers": 0,
    "timeout_s": 900,
    "legs": [
      {
        "test_type": "common",
        "exit_code": 1,
        "execution": {
          "fresh": 40,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 29,
          "no_evidence": 0
        }
      },
      {
        "test_type": "desktop",
        "exit_code": 1,
        "execution": {
          "fresh": 42,
          "up_to_date": 1,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 26,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidUnit",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidInstrumented",
        "exit_code": 1,
        "execution": {
          "fresh": 3,
          "up_to_date": 62,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      }
    ]
  }
}
```

### Confetti-main — RED-repo

Path: `C:/Users/34645/AndroidStudioProjects/OFFICIAL_PROJECTS/Confetti-main/Confetti-main`
Category: INTERESTING
Spawn exit: 1
Reason: module_failed discriminator (1 module(s), 133 testcases ran)

Envelope excerpt:
```json
{
  "exit_code": 1,
  "tests": {
    "total": 6,
    "passed": 5,
    "failed": 1,
    "skipped": 0,
    "individual_total": 133
  },
  "errors": [
    {
      "code": "module_failed",
      "module": "wearApp",
      "task": ":wearApp:testDebugUnitTest",
      "message": "[FAIL] wearApp"
    },
    {
      "code": "unsupported_class_version",
      "message": "UnsupportedClassVersionError at BookmarksTest.kt:43"
    }
  ],
  "skipped": [
    {
      "module": "backend",
      "reason": "no test source set"
    },
    {
      "module": "backend:datastore",
      "reason": "no test source set"
    },
    {
      "module": "backend:service-graphql",
      "reason": "no test source set"
    },
    {
      "module": "backend:terraform",
      "reason": "no test source set"
    },
    {
      "module": "common:car",
      "reason": "no test source set"
    },
    {
      "module": "compose-desktop",
      "reason": "no test source set"
    },
    {
      "module": "compose-web",
      "reason": "no test source set"
    },
    {
      "module": "landing-page",
      "reason": "no test source set"
    },
    {
      "module": "proto",
      "reason": "no test source set"
    },
    {
      "module": "androidApp",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "wearApp",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "androidApp",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "wearApp",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "backend:service-import",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "shared",
      "reason": "no androidUnitTest source set (--test-type=androidUnit)"
    },
    {
      "module": "androidApp",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "backend:service-import",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "shared",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "wearApp",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    }
  ],
  "warnings": [
    {
      "code": "no_test_modules_for_leg",
      "message": "Leg 'androidInstrumented': No modules support the requested --test-type=androidInstrumented",
      "test_type": "androidInstrumented"
    }
  ],
  "parallel": {
    "test_type": "all",
    "max_workers": 0,
    "timeout_s": 900,
    "legs": [
      {
        "test_type": "common",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 2,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "desktop",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 2,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidUnit",
        "exit_code": 1,
        "execution": {
          "fresh": 1,
          "up_to_date": 1,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidInstrumented",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      }
    ]
  }
}
```

### DroidconKotlin-main — SKIP

Path: `C:/Users/34645/AndroidStudioProjects/OFFICIAL_PROJECTS/DroidconKotlin-main/DroidconKotlin-main`
Category: INTERESTING
Spawn exit: 3
Reason: all errors are no_test_modules (legitimately empty)

Envelope excerpt:
```json
{
  "exit_code": 3,
  "tests": {
    "total": 0,
    "passed": 0,
    "failed": 0,
    "skipped": 0,
    "individual_total": 0
  },
  "errors": [
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=all",
      "test_type": "all"
    }
  ],
  "skipped": [
    {
      "module": "android",
      "reason": "no test source set"
    },
    {
      "module": "ios",
      "reason": "no test source set"
    },
    {
      "module": "shared",
      "reason": "no test source set"
    },
    {
      "module": "shared-ui",
      "reason": "no test source set"
    }
  ],
  "warnings": []
}
```

### KMedia-main — SKIP

Path: `C:/Users/34645/AndroidStudioProjects/OFFICIAL_PROJECTS/KMedia-main/KMedia-main`
Category: INTERESTING
Spawn exit: 3
Reason: all errors are no_test_modules (legitimately empty)

Envelope excerpt:
```json
{
  "exit_code": 3,
  "tests": {
    "total": 0,
    "passed": 0,
    "failed": 0,
    "skipped": 0,
    "individual_total": 0
  },
  "errors": [
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=all",
      "test_type": "all"
    }
  ],
  "skipped": [
    {
      "module": "kmedia-sample",
      "reason": "no test source set"
    },
    {
      "module": "shared",
      "reason": "no test source set"
    }
  ],
  "warnings": []
}
```

### kmp-production-sample-master — SKIP

Path: `C:/Users/34645/AndroidStudioProjects/OFFICIAL_PROJECTS/kmp-production-sample-master/kmp-production-sample-master`
Category: INTERESTING
Spawn exit: 3
Reason: all errors are no_test_modules (legitimately empty)

Envelope excerpt:
```json
{
  "exit_code": 3,
  "tests": {
    "total": 0,
    "passed": 0,
    "failed": 0,
    "skipped": 0,
    "individual_total": 0
  },
  "errors": [
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=all",
      "test_type": "all"
    }
  ],
  "skipped": [
    {
      "module": "composeApp",
      "reason": "no test source set"
    },
    {
      "module": "shared",
      "reason": "no test source set"
    }
  ],
  "warnings": []
}
```

### nav3-recipes — RED-repo

Path: `C:/Users/34645/AndroidStudioProjects/OFFICIAL_PROJECTS/nav3-recipes`
Category: INTERESTING
Spawn exit: 1
Reason: cascade-isolation retry fired on all cascade legs [androidUnit] — modules independently broken at evaluation phase (not orchestrator bug). 1 module_failed, 0 testcases ran in OTHER legs.

Envelope excerpt:
```json
{
  "exit_code": 1,
  "tests": {
    "total": 2,
    "passed": 1,
    "failed": 1,
    "skipped": 0,
    "individual_total": 0
  },
  "errors": [
    {
      "code": "module_failed",
      "module": "app",
      "task": ":app:testDebugUnitTest",
      "message": "[FAIL] app"
    }
  ],
  "skipped": [
    {
      "module": "advanceddeeplinkapp",
      "reason": "no test source set"
    },
    {
      "module": "common",
      "reason": "no test source set"
    },
    {
      "module": "app",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "app",
      "reason": "no desktop target (--test-type=desktop)"
    }
  ],
  "warnings": [
    {
      "code": "no_test_modules_for_leg",
      "message": "Leg 'common': No modules support the requested --test-type=common",
      "test_type": "common"
    },
    {
      "code": "no_test_modules_for_leg",
      "message": "Leg 'desktop': No modules support the requested --test-type=desktop",
      "test_type": "desktop"
    }
  ],
  "parallel": {
    "test_type": "all",
    "max_workers": 0,
    "timeout_s": 900,
    "legs": [
      {
        "test_type": "common",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "desktop",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidUnit",
        "exit_code": 1,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 1
        }
      },
      {
        "test_type": "androidInstrumented",
        "exit_code": 0,
        "execution": {
          "fresh": 1,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      }
    ]
  }
}
```

### Nav3Guide-scenes — SKIP

Path: `C:/Users/34645/AndroidStudioProjects/OFFICIAL_PROJECTS/Nav3Guide-scenes`
Category: INTERESTING
Spawn exit: 3
Reason: all errors are no_test_modules (legitimately empty)

Envelope excerpt:
```json
{
  "exit_code": 3,
  "tests": {
    "total": 0,
    "passed": 0,
    "failed": 0,
    "skipped": 0,
    "individual_total": 0
  },
  "errors": [
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=all",
      "test_type": "all"
    }
  ],
  "skipped": [
    {
      "module": "composeApp",
      "reason": "no test source set"
    }
  ],
  "warnings": []
}
```

### nowinandroid — RED-repo

Path: `C:/Users/34645/AndroidStudioProjects/OFFICIAL_PROJECTS/nowinandroid`
Category: INTERESTING
Spawn exit: 3
Reason: module_failed discriminator (2 module(s), 8 testcases ran)

Envelope excerpt:
```json
{
  "exit_code": 3,
  "tests": {
    "total": 2,
    "passed": 0,
    "failed": 2,
    "skipped": 0,
    "individual_total": 8
  },
  "errors": [
    {
      "code": "module_failed",
      "module": "lint",
      "task": ":lint:test",
      "message": "[FAIL] lint"
    },
    {
      "code": "module_failed",
      "module": "lint",
      "task": ":lint:test",
      "message": "[FAIL] lint"
    },
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=androidUnit",
      "test_type": "androidUnit"
    },
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=androidInstrumented",
      "test_type": "androidInstrumented"
    }
  ],
  "skipped": [
    {
      "module": "app-nia-catalog",
      "reason": "no test source set"
    },
    {
      "module": "benchmarks",
      "reason": "no test source set"
    },
    {
      "module": "core:analytics",
      "reason": "no test source set"
    },
    {
      "module": "core:data-test",
      "reason": "no test source set"
    },
    {
      "module": "core:datastore-proto",
      "reason": "no test source set"
    },
    {
      "module": "core:datastore-test",
      "reason": "no test source set"
    },
    {
      "module": "core:model",
      "reason": "no test source set"
    },
    {
      "module": "core:notifications",
      "reason": "no test source set"
    },
    {
      "module": "core:screenshot-testing",
      "reason": "no test source set"
    },
    {
      "module": "core:testing",
      "reason": "no test source set"
    },
    {
      "module": "feature:bookmarks:api",
      "reason": "no test source set"
    },
    {
      "module": "feature:foryou:api",
      "reason": "no test source set"
    },
    {
      "module": "feature:interests:api",
      "reason": "no test source set"
    },
    {
      "module": "feature:search:api",
      "reason": "no test source set"
    },
    {
      "module": "feature:topic:api",
      "reason": "no test source set"
    },
    {
      "module": "sync:sync-test",
      "reason": "no test source set"
    },
    {
      "module": "ui-test-hilt-manifest",
      "reason": "no test source set"
    },
    {
      "module": "app",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:common",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:data",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:database",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:datastore",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:designsystem",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:domain",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:navigation",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:network",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:ui",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:bookmarks:impl",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:foryou:impl",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:interests:impl",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:search:impl",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:settings:impl",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:topic:impl",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "sync:work",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "app",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:common",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:data",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:database",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:datastore",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:designsystem",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:domain",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:navigation",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:network",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:ui",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:bookmarks:impl",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:foryou:impl",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:interests:impl",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:search:impl",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:settings:impl",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:topic:impl",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "sync:work",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "app",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "core:common",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "core:data",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "core:database",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "core:datastore",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "core:designsystem",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "core:domain",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "core:navigation",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "core:network",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "core:ui",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "feature:bookmarks:impl",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "feature:foryou:impl",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "feature:interests:impl",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "feature:search:impl",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "feature:settings:impl",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "feature:topic:impl",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "lint",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "sync:work",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "app",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "core:common",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "core:data",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "core:database",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "core:datastore",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "core:designsystem",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "core:domain",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "core:navigation",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "core:network",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "core:ui",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:bookmarks:impl",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:foryou:impl",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:interests:impl",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:search:impl",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:settings:impl",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:topic:impl",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "lint",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "sync:work",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    }
  ],
  "warnings": [],
  "parallel": {
    "test_type": "all",
    "max_workers": 0,
    "timeout_s": 900,
    "legs": [
      {
        "test_type": "common",
        "exit_code": 1,
        "execution": {
          "fresh": 1,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "desktop",
        "exit_code": 1,
        "execution": {
          "fresh": 1,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidUnit",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidInstrumented",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      }
    ]
  }
}
```

### NYTimes-KMP-main — SKIP

Path: `C:/Users/34645/AndroidStudioProjects/OFFICIAL_PROJECTS/NYTimes-KMP-main/NYTimes-KMP-main`
Category: INTERESTING
Spawn exit: 3
Reason: all errors are no_test_modules (legitimately empty)

Envelope excerpt:
```json
{
  "exit_code": 3,
  "tests": {
    "total": 0,
    "passed": 0,
    "failed": 0,
    "skipped": 0,
    "individual_total": 0
  },
  "errors": [
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=all",
      "test_type": "all"
    }
  ],
  "skipped": [
    {
      "module": "app",
      "reason": "no test source set"
    },
    {
      "module": "app:android",
      "reason": "no test source set"
    },
    {
      "module": "app:desktop",
      "reason": "no test source set"
    },
    {
      "module": "app:wear",
      "reason": "no test source set"
    },
    {
      "module": "app:web",
      "reason": "no test source set"
    }
  ],
  "warnings": []
}
```

### AndroidCommonDoc-build-logic — SKIP

Path: `C:/Users/34645/AndroidStudioProjects/AndroidCommonDoc/build-logic`
Category: NEW
Spawn exit: 3
Reason: all errors are no_test_modules (legitimately empty)

Envelope excerpt:
```json
{
  "exit_code": 3,
  "tests": {
    "total": 0,
    "passed": 0,
    "failed": 0,
    "skipped": 0,
    "individual_total": 0
  },
  "errors": [
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=all",
      "test_type": "all"
    }
  ],
  "skipped": [],
  "warnings": []
}
```

### AndroidCommonDoc-detekt-rules — SKIP

Path: `C:/Users/34645/AndroidStudioProjects/AndroidCommonDoc/detekt-rules`
Category: NEW
Spawn exit: 3
Reason: all errors are no_test_modules (legitimately empty)

Envelope excerpt:
```json
{
  "exit_code": 3,
  "tests": {
    "total": 0,
    "passed": 0,
    "failed": 0,
    "skipped": 0,
    "individual_total": 0
  },
  "errors": [
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=all",
      "test_type": "all"
    }
  ],
  "skipped": [],
  "warnings": []
}
```

### AndroidCommonDoc-konsist-tests — SKIP

Path: `C:/Users/34645/AndroidStudioProjects/AndroidCommonDoc/konsist-tests`
Category: NEW
Spawn exit: 3
Reason: all errors are no_test_modules (legitimately empty)

Envelope excerpt:
```json
{
  "exit_code": 3,
  "tests": {
    "total": 0,
    "passed": 0,
    "failed": 0,
    "skipped": 0,
    "individual_total": 0
  },
  "errors": [
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=all",
      "test_type": "all"
    }
  ],
  "skipped": [],
  "warnings": []
}
```

### kmp-test-runner-gradle-plugin — SKIP

Path: `C:/Users/34645/AndroidStudioProjects/kmp-test-runner/gradle-plugin`
Category: NEW
Spawn exit: 3
Reason: all errors are no_test_modules (legitimately empty)

Envelope excerpt:
```json
{
  "exit_code": 3,
  "tests": {
    "total": 0,
    "passed": 0,
    "failed": 0,
    "skipped": 0,
    "individual_total": 0
  },
  "errors": [
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=all",
      "test_type": "all"
    }
  ],
  "skipped": [],
  "warnings": []
}
```

### WakeTheCave — RED-repo

Path: `C:/Users/34645/AndroidStudioProjects/WakeTheCave/WakeTheCave`
Category: NEW
Spawn exit: 1
Reason: cascade-isolation retry fired on all cascade legs [common, desktop, androidUnit, androidInstrumented] — modules independently broken at evaluation phase (not orchestrator bug). 60 module_failed, 0 testcases ran in OTHER legs.

Envelope excerpt:
```json
{
  "exit_code": 1,
  "tests": {
    "total": 60,
    "passed": 0,
    "failed": 60,
    "skipped": 0,
    "individual_total": 0
  },
  "errors": [
    {
      "code": "module_failed",
      "module": "core:auth:api",
      "task": ":core:auth:api:desktopTest",
      "message": "[FAIL] core:auth:api"
    },
    {
      "code": "module_failed",
      "module": "core:auth:impl",
      "task": ":core:auth:impl:desktopTest",
      "message": "[FAIL] core:auth:impl"
    },
    {
      "code": "module_failed",
      "module": "core:common",
      "task": ":core:common:desktopTest",
      "message": "[FAIL] core:common"
    },
    {
      "code": "module_failed",
      "module": "core:data",
      "task": ":core:data:desktopTest",
      "message": "[FAIL] core:data"
    },
    {
      "code": "module_failed",
      "module": "core:database",
      "task": ":core:database:desktopTest",
      "message": "[FAIL] core:database"
    },
    {
      "code": "module_failed",
      "module": "core:designsystem",
      "task": ":core:designsystem:desktopTest",
      "message": "[FAIL] core:designsystem"
    },
    {
      "code": "module_failed",
      "module": "core:domain",
      "task": ":core:domain:desktopTest",
      "message": "[FAIL] core:domain"
    },
    {
      "code": "module_failed",
      "module": "core:logging",
      "task": ":core:logging:desktopTest",
      "message": "[FAIL] core:logging"
    },
    {
      "code": "module_failed",
      "module": "core:model",
      "task": ":core:model:desktopTest",
      "message": "[FAIL] core:model"
    },
    {
      "code": "module_failed",
      "module": "core:navigation",
      "task": ":core:navigation:desktopTest",
      "message": "[FAIL] core:navigation"
    },
    {
      "code": "module_failed",
      "module": "core:network",
      "task": ":core:network:desktopTest",
      "message": "[FAIL] core:network"
    },
    {
      "code": "module_failed",
      "module": "core:storage:api",
      "task": ":core:storage:api:desktopTest",
      "message": "[FAIL] core:storage:api"
    },
    {
      "code": "module_failed",
      "module": "core:storage:impl",
      "task": ":core:storage:impl:desktopTest",
      "message": "[FAIL] core:storage:impl"
    },
    {
      "code": "module_failed",
      "module": "core:testing",
      "task": ":core:testing:desktopTest",
      "message": "[FAIL] core:testing"
    },
    {
      "code": "module_failed",
      "module": "feature:auth",
      "task": ":feature:auth:desktopTest",
      "message": "[FAIL] feature:auth"
    },
    {
      "code": "module_failed",
      "module": "feature:auth-api",
      "task": ":feature:auth-api:desktopTest",
      "message": "[FAIL] feature:auth-api"
    },
    {
      "code": "module_failed",
      "module": "feature:common",
      "task": ":feature:common:desktopTest",
      "message": "[FAIL] feature:common"
    },
    {
      "code": "module_failed",
      "module": "feature:devices",
      "task": ":feature:devices:desktopTest",
      "message": "[FAIL] feature:devices"
    },
    {
      "code": "module_failed",
      "module": "feature:devices-api",
      "task": ":feature:devices-api:desktopTest",
      "message": "[FAIL] feature:devices-api"
    },
    {
      "code": "module_failed",
      "module": "feature:home",
      "task": ":feature:home:desktopTest",
      "message": "[FAIL] feature:home"
    },
    {
      "code": "module_failed",
      "module": "feature:home-api",
      "task": ":feature:home-api:desktopTest",
      "message": "[FAIL] feature:home-api"
    },
    {
      "code": "module_failed",
      "module": "feature:onboarding",
      "task": ":feature:onboarding:desktopTest",
      "message": "[FAIL] feature:onboarding"
    },
    {
      "code": "module_failed",
      "module": "feature:onboarding-api",
      "task": ":feature:onboarding-api:desktopTest",
      "message": "[FAIL] feature:onboarding-api"
    },
    {
      "code": "module_failed",
      "module": "feature:presets",
      "task": ":feature:presets:desktopTest",
      "message": "[FAIL] feature:presets"
    },
    {
      "code": "module_failed",
      "module": "feature:presets-api",
      "task": ":feature:presets-api:desktopTest",
      "message": "[FAIL] feature:presets-api"
    },
    {
      "code": "module_failed",
      "module": "feature:settings",
      "task": ":feature:settings:desktopTest",
      "message": "[FAIL] feature:settings"
    },
    {
      "code": "module_failed",
      "module": "feature:settings-api",
      "task": ":feature:settings-api:desktopTest",
      "message": "[FAIL] feature:settings-api"
    },
    {
      "code": "module_failed",
      "module": "integration:hue:data:impl",
      "task": ":integration:hue:data:impl:desktopTest",
      "message": "[FAIL] integration:hue:data:impl"
    },
    {
      "code": "module_failed",
      "module": "integration:wol:data:impl",
      "task": ":integration:wol:data:impl:desktopTest",
      "message": "[FAIL] integration:wol:data:impl"
    },
    {
      "code": "module_failed",
      "module": "core:auth:api",
      "task": ":core:auth:api:desktopTest",
      "message": "[FAIL] core:auth:api"
    },
    {
      "code": "module_failed",
      "module": "core:auth:impl",
      "task": ":core:auth:impl:desktopTest",
      "message": "[FAIL] core:auth:impl"
    },
    {
      "code": "module_failed",
      "module": "core:common",
      "task": ":core:common:desktopTest",
      "message": "[FAIL] core:common"
    },
    {
      "code": "module_failed",
      "module": "core:data",
      "task": ":core:data:desktopTest",
      "message": "[FAIL] core:data"
    },
    {
      "code": "module_failed",
      "module": "core:database",
      "task": ":core:database:desktopTest",
      "message": "[FAIL] core:database"
    },
    {
      "code": "module_failed",
      "module": "core:designsystem",
      "task": ":core:designsystem:desktopTest",
      "message": "[FAIL] core:designsystem"
    },
    {
      "code": "module_failed",
      "module": "core:domain",
      "task": ":core:domain:desktopTest",
      "message": "[FAIL] core:domain"
    },
    {
      "code": "module_failed",
      "module": "core:logging",
      "task": ":core:logging:desktopTest",
      "message": "[FAIL] core:logging"
    },
    {
      "code": "module_failed",
      "module": "core:model",
      "task": ":core:model:desktopTest",
      "message": "[FAIL] core:model"
    },
    {
      "code": "module_failed",
      "module": "core:navigation",
      "task": ":core:navigation:desktopTest",
      "message": "[FAIL] core:navigation"
    },
    {
      "code": "module_failed",
      "module": "core:network",
      "task": ":core:network:desktopTest",
      "message": "[FAIL] core:network"
    },
    {
      "code": "module_failed",
      "module": "core:storage:api",
      "task": ":core:storage:api:desktopTest",
      "message": "[FAIL] core:storage:api"
    },
    {
      "code": "module_failed",
      "module": "core:storage:impl",
      "task": ":core:storage:impl:desktopTest",
      "message": "[FAIL] core:storage:impl"
    },
    {
      "code": "module_failed",
      "module": "core:testing",
      "task": ":core:testing:desktopTest",
      "message": "[FAIL] core:testing"
    },
    {
      "code": "module_failed",
      "module": "feature:auth",
      "task": ":feature:auth:desktopTest",
      "message": "[FAIL] feature:auth"
    },
    {
      "code": "module_failed",
      "module": "feature:auth-api",
      "task": ":feature:auth-api:desktopTest",
      "message": "[FAIL] feature:auth-api"
    },
    {
      "code": "module_failed",
      "module": "feature:common",
      "task": ":feature:common:desktopTest",
      "message": "[FAIL] feature:common"
    },
    {
      "code": "module_failed",
      "module": "feature:devices",
      "task": ":feature:devices:desktopTest",
      "message": "[FAIL] feature:devices"
    },
    {
      "code": "module_failed",
      "module": "feature:devices-api",
      "task": ":feature:devices-api:desktopTest",
      "message": "[FAIL] feature:devices-api"
    },
    {
      "code": "module_failed",
      "module": "feature:home",
      "task": ":feature:home:desktopTest",
      "message": "[FAIL] feature:home"
    },
    {
      "code": "module_failed",
      "module": "feature:home-api",
      "task": ":feature:home-api:desktopTest",
      "message": "[FAIL] feature:home-api"
    },
    {
      "code": "module_failed",
      "module": "feature:onboarding",
      "task": ":feature:onboarding:desktopTest",
      "message": "[FAIL] feature:onboarding"
    },
    {
      "code": "module_failed",
      "module": "feature:onboarding-api",
      "task": ":feature:onboarding-api:desktopTest",
      "message": "[FAIL] feature:onboarding-api"
    },
    {
      "code": "module_failed",
      "module": "feature:presets",
      "task": ":feature:presets:desktopTest",
      "message": "[FAIL] feature:presets"
    },
    {
      "code": "module_failed",
      "module": "feature:presets-api",
      "task": ":feature:presets-api:desktopTest",
      "message": "[FAIL] feature:presets-api"
    },
    {
      "code": "module_failed",
      "module": "feature:settings",
      "task": ":feature:settings:desktopTest",
      "message": "[FAIL] feature:settings"
    },
    {
      "code": "module_failed",
      "module": "feature:settings-api",
      "task": ":feature:settings-api:desktopTest",
      "message": "[FAIL] feature:settings-api"
    },
    {
      "code": "module_failed",
      "module": "integration:hue:data:impl",
      "task": ":integration:hue:data:impl:desktopTest",
      "message": "[FAIL] integration:hue:data:impl"
    },
    {
      "code": "module_failed",
      "module": "integration:wol:data:impl",
      "task": ":integration:wol:data:impl:desktopTest",
      "message": "[FAIL] integration:wol:data:impl"
    },
    {
      "code": "module_failed",
      "module": "androidApp",
      "task": ":androidApp:testDebugUnitTest",
      "message": "[FAIL] androidApp"
    },
    {
      "code": "module_failed",
      "module": "androidApp",
      "task": ":androidApp:connectedDebugAndroidTest",
      "message": "[FAIL] androidApp"
    }
  ],
  "skipped": [
    {
      "module": "composeApp",
      "reason": "no test source set"
    },
    {
      "module": "core:test-assertions",
      "reason": "no test source set"
    },
    {
      "module": "feature:auth-ui",
      "reason": "no test source set"
    },
    {
      "module": "feature:devices-ui",
      "reason": "no test source set"
    },
    {
      "module": "feature:home-ui",
      "reason": "no test source set"
    },
    {
      "module": "feature:onboarding-ui",
      "reason": "no test source set"
    },
    {
      "module": "feature:presets-ui",
      "reason": "no test source set"
    },
    {
      "module": "feature:settings-ui",
      "reason": "no test source set"
    },
    {
      "module": "integration:hue:data:api",
      "reason": "no test source set"
    },
    {
      "module": "integration:hue:ui:api",
      "reason": "no test source set"
    },
    {
      "module": "integration:hue:ui:impl",
      "reason": "no test source set"
    },
    {
      "module": "integration:mqtt-api",
      "reason": "no test source set"
    },
    {
      "module": "integration:wol:data:api",
      "reason": "no test source set"
    },
    {
      "module": "integration:wol:ui:api",
      "reason": "no test source set"
    },
    {
      "module": "integration:wol:ui:impl",
      "reason": "no test source set"
    },
    {
      "module": "androidApp",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "androidApp",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:auth:api",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:auth:impl",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:common",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:data",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:database",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:designsystem",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:domain",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:logging",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:model",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:navigation",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:network",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:storage:api",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:storage:impl",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:testing",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:auth",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:auth-api",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:common",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:devices",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:devices-api",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:home",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:home-api",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:onboarding",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:onboarding-api",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:presets",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:presets-api",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:settings",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:settings-api",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "integration:hue:data:impl",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "integration:wol:data:impl",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:auth:api",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:auth:impl",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:common",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:data",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:database",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:designsystem",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:domain",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:logging",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:model",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:navigation",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:network",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:storage:api",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:storage:impl",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:testing",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:auth",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:auth-api",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:common",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:devices",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:devices-api",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:home",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:home-api",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:onboarding",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:onboarding-api",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:presets",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:presets-api",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:settings",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:settings-api",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "integration:hue:data:impl",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "integration:wol:data:impl",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    }
  ],
  "warnings": [],
  "parallel": {
    "test_type": "all",
    "max_workers": 0,
    "timeout_s": 900,
    "legs": [
      {
        "test_type": "common",
        "exit_code": 1,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 29
        }
      },
      {
        "test_type": "desktop",
        "exit_code": 1,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 29
        }
      },
      {
        "test_type": "androidUnit",
        "exit_code": 1,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 1
        }
      },
      {
        "test_type": "androidInstrumented",
        "exit_code": 1,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 1
        }
      }
    ]
  }
}
```

### WakeTheCave_clean — RED-repo

Path: `C:/Users/34645/AndroidStudioProjects/WakeTheCave/WakeTheCave_clean`
Category: NEW
Spawn exit: 1
Reason: cascade-isolation retry fired on all cascade legs [common, desktop, androidUnit, androidInstrumented] — modules independently broken at evaluation phase (not orchestrator bug). 47 module_failed, 0 testcases ran in OTHER legs.

Envelope excerpt:
```json
{
  "exit_code": 1,
  "tests": {
    "total": 47,
    "passed": 0,
    "failed": 47,
    "skipped": 0,
    "individual_total": 0
  },
  "errors": [
    {
      "code": "module_failed",
      "module": "core:auth:api",
      "task": ":core:auth:api:desktopTest",
      "message": "[FAIL] core:auth:api"
    },
    {
      "code": "module_failed",
      "module": "core:common",
      "task": ":core:common:desktopTest",
      "message": "[FAIL] core:common"
    },
    {
      "code": "module_failed",
      "module": "core:data",
      "task": ":core:data:desktopTest",
      "message": "[FAIL] core:data"
    },
    {
      "code": "module_failed",
      "module": "core:database",
      "task": ":core:database:desktopTest",
      "message": "[FAIL] core:database"
    },
    {
      "code": "module_failed",
      "module": "core:domain",
      "task": ":core:domain:desktopTest",
      "message": "[FAIL] core:domain"
    },
    {
      "code": "module_failed",
      "module": "core:logging",
      "task": ":core:logging:desktopTest",
      "message": "[FAIL] core:logging"
    },
    {
      "code": "module_failed",
      "module": "core:model",
      "task": ":core:model:desktopTest",
      "message": "[FAIL] core:model"
    },
    {
      "code": "module_failed",
      "module": "core:navigation",
      "task": ":core:navigation:desktopTest",
      "message": "[FAIL] core:navigation"
    },
    {
      "code": "module_failed",
      "module": "core:network",
      "task": ":core:network:desktopTest",
      "message": "[FAIL] core:network"
    },
    {
      "code": "module_failed",
      "module": "core:storage:api",
      "task": ":core:storage:api:desktopTest",
      "message": "[FAIL] core:storage:api"
    },
    {
      "code": "module_failed",
      "module": "core:storage:impl",
      "task": ":core:storage:impl:desktopTest",
      "message": "[FAIL] core:storage:impl"
    },
    {
      "code": "module_failed",
      "module": "core:testing",
      "task": ":core:testing:desktopTest",
      "message": "[FAIL] core:testing"
    },
    {
      "code": "module_failed",
      "module": "core:auth:api",
      "task": ":core:auth:api:desktopTest",
      "message": "[FAIL] core:auth:api"
    },
    {
      "code": "module_failed",
      "module": "core:common",
      "task": ":core:common:desktopTest",
      "message": "[FAIL] core:common"
    },
    {
      "code": "module_failed",
      "module": "core:data",
      "task": ":core:data:desktopTest",
      "message": "[FAIL] core:data"
    },
    {
      "code": "module_failed",
      "module": "core:database",
      "task": ":core:database:desktopTest",
      "message": "[FAIL] core:database"
    },
    {
      "code": "module_failed",
      "module": "core:domain",
      "task": ":core:domain:desktopTest",
      "message": "[FAIL] core:domain"
    },
    {
      "code": "module_failed",
      "module": "core:logging",
      "task": ":core:logging:desktopTest",
      "message": "[FAIL] core:logging"
    },
    {
      "code": "module_failed",
      "module": "core:model",
      "task": ":core:model:desktopTest",
      "message": "[FAIL] core:model"
    },
    {
      "code": "module_failed",
      "module": "core:navigation",
      "task": ":core:navigation:desktopTest",
      "message": "[FAIL] core:navigation"
    },
    {
      "code": "module_failed",
      "module": "core:network",
      "task": ":core:network:desktopTest",
      "message": "[FAIL] core:network"
    },
    {
      "code": "module_failed",
      "module": "core:storage:api",
      "task": ":core:storage:api:desktopTest",
      "message": "[FAIL] core:storage:api"
    },
    {
      "code": "module_failed",
      "module": "core:storage:impl",
      "task": ":core:storage:impl:desktopTest",
      "message": "[FAIL] core:storage:impl"
    },
    {
      "code": "module_failed",
      "module": "core:testing",
      "task": ":core:testing:desktopTest",
      "message": "[FAIL] core:testing"
    },
    {
      "code": "module_failed",
      "module": "app",
      "task": ":app:testDebugUnitTest",
      "message": "[FAIL] app"
    },
    {
      "code": "module_failed",
      "module": "core:auth:impl",
      "task": ":core:auth:impl:testDebugUnitTest",
      "message": "[FAIL] core:auth:impl"
    },
    {
      "code": "module_failed",
      "module": "core:designsystem",
      "task": ":core:designsystem:testDebugUnitTest",
      "message": "[FAIL] core:designsystem"
    },
    {
      "code": "module_failed",
      "module": "feature:auth",
      "task": ":feature:auth:testDebugUnitTest",
      "message": "[FAIL] feature:auth"
    },
    {
      "code": "module_failed",
      "module": "feature:common",
      "task": ":feature:common:testDebugUnitTest",
      "message": "[FAIL] feature:common"
    },
    {
      "code": "module_failed",
      "module": "feature:devices",
      "task": ":feature:devices:testDebugUnitTest",
      "message": "[FAIL] feature:devices"
    },
    {
      "code": "module_failed",
      "module": "feature:home",
      "task": ":feature:home:testDebugUnitTest",
      "message": "[FAIL] feature:home"
    },
    {
      "code": "module_failed",
      "module": "feature:home-api",
      "task": ":feature:home-api:testDebugUnitTest",
      "message": "[FAIL] feature:home-api"
    },
    {
      "code": "module_failed",
      "module": "feature:onboarding",
      "task": ":feature:onboarding:testDebugUnitTest",
      "message": "[FAIL] feature:onboarding"
    },
    {
      "code": "module_failed",
      "module": "feature:presets",
      "task": ":feature:presets:testDebugUnitTest",
      "message": "[FAIL] feature:presets"
    },
    {
      "code": "module_failed",
      "module": "feature:presets-api",
      "task": ":feature:presets-api:testDebugUnitTest",
      "message": "[FAIL] feature:presets-api"
    },
    {
      "code": "module_failed",
      "module": "feature:settings-api",
      "task": ":feature:settings-api:testDebugUnitTest",
      "message": "[FAIL] feature:settings-api"
    },
    {
      "code": "module_failed",
      "module": "integration:hue:data:api",
      "task": ":integration:hue:data:api:testDebugUnitTest",
      "message": "[FAIL] integration:hue:data:api"
    },
    {
      "code": "module_failed",
      "module": "integration:hue:data:impl",
      "task": ":integration:hue:data:impl:testDebugUnitTest",
      "message": "[FAIL] integration:hue:data:impl"
    },
    {
      "code": "module_failed",
      "module": "integration:hue:ui:impl",
      "task": ":integration:hue:ui:impl:testDebugUnitTest",
      "message": "[FAIL] integration:hue:ui:impl"
    },
    {
      "code": "module_failed",
      "module": "integration:wol:data:api",
      "task": ":integration:wol:data:api:testDebugUnitTest",
      "message": "[FAIL] integration:wol:data:api"
    },
    {
      "code": "module_failed",
      "module": "integration:wol:data:impl",
      "task": ":integration:wol:data:impl:testDebugUnitTest",
      "message": "[FAIL] integration:wol:data:impl"
    },
    {
      "code": "module_failed",
      "module": "app",
      "task": ":app:connectedDebugAndroidTest",
      "message": "[FAIL] app"
    },
    {
      "code": "module_failed",
      "module": "core:auth:impl",
      "task": ":core:auth:impl:connectedDebugAndroidTest",
      "message": "[FAIL] core:auth:impl"
    },
    {
      "code": "module_failed",
      "module": "core:designsystem",
      "task": ":core:designsystem:connectedDebugAndroidTest",
      "message": "[FAIL] core:designsystem"
    },
    {
      "code": "module_failed",
      "module": "feature:auth",
      "task": ":feature:auth:connectedDebugAndroidTest",
      "message": "[FAIL] feature:auth"
    },
    {
      "code": "module_failed",
      "module": "feature:onboarding",
      "task": ":feature:onboarding:connectedDebugAndroidTest",
      "message": "[FAIL] feature:onboarding"
    },
    {
      "code": "module_failed",
      "module": "feature:settings",
      "task": ":feature:settings:connectedDebugAndroidTest",
      "message": "[FAIL] feature:settings"
    }
  ],
  "skipped": [
    {
      "module": "integration:hue:ui:api",
      "reason": "no test source set"
    },
    {
      "module": "integration:mqtt-api",
      "reason": "no test source set"
    },
    {
      "module": "integration:wol:ui:api",
      "reason": "no test source set"
    },
    {
      "module": "integration:wol:ui:impl",
      "reason": "no test source set"
    },
    {
      "module": "app",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:auth:impl",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:designsystem",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:auth",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:auth-api",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:common",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:devices",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:devices-api",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:home",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:home-api",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:onboarding",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:onboarding-api",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:presets",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:presets-api",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:settings",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:settings-api",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "integration:hue:data:api",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "integration:hue:data:impl",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "integration:hue:ui:impl",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "integration:wol:data:api",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "integration:wol:data:impl",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "app",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:auth:impl",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:designsystem",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:auth",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:auth-api",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:common",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:devices",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:devices-api",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:home",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:home-api",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:onboarding",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:onboarding-api",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:presets",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:presets-api",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:settings",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:settings-api",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "integration:hue:data:api",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "integration:hue:data:impl",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "integration:hue:ui:impl",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "integration:wol:data:api",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "integration:wol:data:impl",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:auth:api",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:common",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:data",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:database",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:domain",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:logging",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:model",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:navigation",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:network",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:storage:api",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:storage:impl",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "core:testing",
      "reason": "no androidUnitTest source set (withHostTestBuilder{} missing) (--test-type=androidUnit)"
    },
    {
      "module": "feature:auth-api",
      "reason": "no androidUnitTest source set (--test-type=androidUnit)"
    },
    {
      "module": "feature:devices-api",
      "reason": "no androidUnitTest source set (--test-type=androidUnit)"
    },
    {
      "module": "feature:onboarding-api",
      "reason": "no androidUnitTest source set (--test-type=androidUnit)"
    },
    {
      "module": "feature:settings",
      "reason": "no androidUnitTest source set (--test-type=androidUnit)"
    },
    {
      "module": "core:auth:api",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:common",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:data",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:database",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:domain",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:logging",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:model",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:navigation",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:network",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:storage:api",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:storage:impl",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core:testing",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:auth-api",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:common",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:devices",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:devices-api",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:home",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:home-api",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:onboarding-api",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:presets",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:presets-api",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:settings-api",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "integration:hue:data:api",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "integration:hue:data:impl",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "integration:hue:ui:impl",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "integration:wol:data:api",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "integration:wol:data:impl",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    }
  ],
  "warnings": [],
  "parallel": {
    "test_type": "all",
    "max_workers": 0,
    "timeout_s": 900,
    "legs": [
      {
        "test_type": "common",
        "exit_code": 1,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 12
        }
      },
      {
        "test_type": "desktop",
        "exit_code": 1,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 12
        }
      },
      {
        "test_type": "androidUnit",
        "exit_code": 1,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 17
        }
      },
      {
        "test_type": "androidInstrumented",
        "exit_code": 1,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 6
        }
      }
    ]
  }
}
```

### WakeTheCave_ref — RED-repo

Path: `C:/Users/34645/AndroidStudioProjects/WakeTheCave/WakeTheCave_ref`
Category: NEW
Spawn exit: 3
Reason: cascade-isolation retry fired on all cascade legs [androidUnit, androidInstrumented] — modules independently broken at evaluation phase (not orchestrator bug). 19 module_failed, 0 testcases ran in OTHER legs.

Envelope excerpt:
```json
{
  "exit_code": 3,
  "tests": {
    "total": 19,
    "passed": 0,
    "failed": 19,
    "skipped": 0,
    "individual_total": 0
  },
  "errors": [
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=common",
      "test_type": "common"
    },
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=desktop",
      "test_type": "desktop"
    },
    {
      "code": "module_failed",
      "module": "app",
      "task": ":app:testDebugUnitTest",
      "message": "[FAIL] app"
    },
    {
      "code": "module_failed",
      "module": "core:designsystem",
      "task": ":core:designsystem:testDebugUnitTest",
      "message": "[FAIL] core:designsystem"
    },
    {
      "code": "module_failed",
      "module": "core:domain",
      "task": ":core:domain:testDebugUnitTest",
      "message": "[FAIL] core:domain"
    },
    {
      "code": "module_failed",
      "module": "core:network",
      "task": ":core:network:testDebugUnitTest",
      "message": "[FAIL] core:network"
    },
    {
      "code": "module_failed",
      "module": "core:storage:impl",
      "task": ":core:storage:impl:testDebugUnitTest",
      "message": "[FAIL] core:storage:impl"
    },
    {
      "code": "module_failed",
      "module": "feature:auth",
      "task": ":feature:auth:testDebugUnitTest",
      "message": "[FAIL] feature:auth"
    },
    {
      "code": "module_failed",
      "module": "feature:home",
      "task": ":feature:home:testDebugUnitTest",
      "message": "[FAIL] feature:home"
    },
    {
      "code": "module_failed",
      "module": "feature:presets",
      "task": ":feature:presets:testDebugUnitTest",
      "message": "[FAIL] feature:presets"
    },
    {
      "code": "module_failed",
      "module": "feature:settings",
      "task": ":feature:settings:testDebugUnitTest",
      "message": "[FAIL] feature:settings"
    },
    {
      "code": "module_failed",
      "module": "app",
      "task": ":app:connectedDebugAndroidTest",
      "message": "[FAIL] app"
    },
    {
      "code": "module_failed",
      "module": "core:auth:impl",
      "task": ":core:auth:impl:connectedDebugAndroidTest",
      "message": "[FAIL] core:auth:impl"
    },
    {
      "code": "module_failed",
      "module": "core:data",
      "task": ":core:data:connectedDebugAndroidTest",
      "message": "[FAIL] core:data"
    },
    {
      "code": "module_failed",
      "module": "core:database",
      "task": ":core:database:connectedDebugAndroidTest",
      "message": "[FAIL] core:database"
    },
    {
      "code": "module_failed",
      "module": "core:designsystem",
      "task": ":core:designsystem:connectedDebugAndroidTest",
      "message": "[FAIL] core:designsystem"
    },
    {
      "code": "module_failed",
      "module": "core:storage:impl",
      "task": ":core:storage:impl:connectedDebugAndroidTest",
      "message": "[FAIL] core:storage:impl"
    },
    {
      "code": "module_failed",
      "module": "feature:auth",
      "task": ":feature:auth:connectedDebugAndroidTest",
      "message": "[FAIL] feature:auth"
    },
    {
      "code": "module_failed",
      "module": "feature:devices",
      "task": ":feature:devices:connectedDebugAndroidTest",
      "message": "[FAIL] feature:devices"
    },
    {
      "code": "module_failed",
      "module": "feature:onboarding",
      "task": ":feature:onboarding:connectedDebugAndroidTest",
      "message": "[FAIL] feature:onboarding"
    },
    {
      "code": "module_failed",
      "module": "feature:settings",
      "task": ":feature:settings:connectedDebugAndroidTest",
      "message": "[FAIL] feature:settings"
    }
  ],
  "skipped": [
    {
      "module": "core:storage:api",
      "reason": "no test source set"
    },
    {
      "module": "feature:auth-api",
      "reason": "no test source set"
    },
    {
      "module": "feature:devices-api",
      "reason": "no test source set"
    },
    {
      "module": "feature:onboarding-api",
      "reason": "no test source set"
    },
    {
      "module": "integration:hue-api",
      "reason": "no test source set"
    },
    {
      "module": "integration:hue-impl",
      "reason": "no test source set"
    },
    {
      "module": "integration:mqtt-api",
      "reason": "no test source set"
    },
    {
      "module": "integration:mqtt-impl",
      "reason": "no test source set"
    },
    {
      "module": "integration:wol-api",
      "reason": "no test source set"
    },
    {
      "module": "integration:wol-impl",
      "reason": "no test source set"
    },
    {
      "module": "app",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:auth:api",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:auth:impl",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:data",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:database",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:designsystem",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:domain",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:logging",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:model",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:navigation",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:network",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:storage:impl",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core:testing",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:auth",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:devices",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:home",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:onboarding",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:presets",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:settings",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "app",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:auth:api",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:auth:impl",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:data",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:database",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:designsystem",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:domain",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:logging",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:model",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:navigation",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:network",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:storage:impl",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:testing",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:auth",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:devices",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:home",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:onboarding",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:presets",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:settings",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core:auth:api",
      "reason": "no androidUnitTest source set (--test-type=androidUnit)"
    },
    {
      "module": "core:auth:impl",
      "reason": "no androidUnitTest source set (--test-type=androidUnit)"
    },
    {
      "module": "core:data",
      "reason": "no androidUnitTest source set (--test-type=androidUnit)"
    },
    {
      "module": "core:database",
      "reason": "no androidUnitTest source set (--test-type=androidUnit)"
    },
    {
      "module": "core:logging",
      "reason": "no androidUnitTest source set (--test-type=androidUnit)"
    },
    {
      "module": "core:model",
      "reason": "no androidUnitTest source set (--test-type=androidUnit)"
    },
    {
      "module": "core:navigation",
      "reason": "no androidUnitTest source set (--test-type=androidUnit)"
    },
    {
      "module": "core:testing",
      "reason": "no androidUnitTest source set (--test-type=androidUnit)"
    },
    {
      "module": "feature:devices",
      "reason": "no androidUnitTest source set (--test-type=androidUnit)"
    },
    {
      "module": "feature:onboarding",
      "reason": "no androidUnitTest source set (--test-type=androidUnit)"
    },
    {
      "module": "core:auth:api",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "core:domain",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "core:logging",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "core:model",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "core:navigation",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "core:network",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "core:testing",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:home",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:presets",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    }
  ],
  "warnings": [],
  "parallel": {
    "test_type": "all",
    "max_workers": 0,
    "timeout_s": 900,
    "legs": [
      {
        "test_type": "common",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "desktop",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidUnit",
        "exit_code": 1,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 9
        }
      },
      {
        "test_type": "androidInstrumented",
        "exit_code": 1,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 10
        }
      }
    ]
  }
}
```

### androidify-main — SKIP

Path: `C:/Users/34645/AndroidStudioProjects/OFFICIAL_PROJECTS/androidify-main/androidify-main`
Category: NEW
Spawn exit: 3
Reason: all errors are no_test_modules (legitimately empty)

Envelope excerpt:
```json
{
  "exit_code": 3,
  "tests": {
    "total": 0,
    "passed": 0,
    "failed": 0,
    "skipped": 0,
    "individual_total": 0
  },
  "errors": [
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=common",
      "test_type": "common"
    },
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=desktop",
      "test_type": "desktop"
    },
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=androidUnit",
      "test_type": "androidUnit"
    },
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=androidInstrumented",
      "test_type": "androidInstrumented"
    }
  ],
  "skipped": [
    {
      "module": "app",
      "reason": "no test source set"
    },
    {
      "module": "benchmark",
      "reason": "no test source set"
    },
    {
      "module": "core:network",
      "reason": "no test source set"
    },
    {
      "module": "core:testing",
      "reason": "no test source set"
    },
    {
      "module": "core:theme",
      "reason": "no test source set"
    },
    {
      "module": "core:util",
      "reason": "no test source set"
    },
    {
      "module": "core:xr",
      "reason": "no test source set"
    },
    {
      "module": "wear",
      "reason": "no test source set"
    },
    {
      "module": "wear:common",
      "reason": "no test source set"
    },
    {
      "module": "wear:watchface",
      "reason": "no test source set"
    },
    {
      "module": "data",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:camera",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:creation",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:home",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "feature:results",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "watchface",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "data",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:camera",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:creation",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:home",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "feature:results",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "watchface",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "data",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "feature:camera",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "feature:creation",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "feature:home",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "feature:results",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "watchface",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "data",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:camera",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:creation",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:home",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:results",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "watchface",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    }
  ],
  "warnings": [],
  "parallel": {
    "test_type": "all",
    "max_workers": 0,
    "timeout_s": 900,
    "legs": [
      {
        "test_type": "common",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "desktop",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidUnit",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidInstrumented",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      }
    ]
  }
}
```

### KaMPKit-main — SKIP

Path: `C:/Users/34645/AndroidStudioProjects/OFFICIAL_PROJECTS/KaMPKit-main/KaMPKit-main`
Category: NEW
Spawn exit: 3
Reason: all errors are no_test_modules (legitimately empty)

Envelope excerpt:
```json
{
  "exit_code": 3,
  "tests": {
    "total": 0,
    "passed": 0,
    "failed": 0,
    "skipped": 0,
    "individual_total": 0
  },
  "errors": [
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=common",
      "test_type": "common"
    },
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=desktop",
      "test_type": "desktop"
    },
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=androidUnit",
      "test_type": "androidUnit"
    },
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=androidInstrumented",
      "test_type": "androidInstrumented"
    }
  ],
  "skipped": [
    {
      "module": "app",
      "reason": "no test source set"
    },
    {
      "module": "shared",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "shared",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "shared",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "shared",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    }
  ],
  "warnings": [],
  "parallel": {
    "test_type": "all",
    "max_workers": 0,
    "timeout_s": 900,
    "legs": [
      {
        "test_type": "common",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "desktop",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidUnit",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidInstrumented",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      }
    ]
  }
}
```

### kmp-basic-sample-master — SKIP

Path: `C:/Users/34645/AndroidStudioProjects/OFFICIAL_PROJECTS/kmp-basic-sample-master/kmp-basic-sample-master`
Category: NEW
Spawn exit: 3
Reason: all errors are no_test_modules (legitimately empty)

Envelope excerpt:
```json
{
  "exit_code": 3,
  "tests": {
    "total": 0,
    "passed": 0,
    "failed": 0,
    "skipped": 0,
    "individual_total": 0
  },
  "errors": [
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=common",
      "test_type": "common"
    },
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=desktop",
      "test_type": "desktop"
    },
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=androidUnit",
      "test_type": "androidUnit"
    },
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=androidInstrumented",
      "test_type": "androidInstrumented"
    }
  ],
  "skipped": [
    {
      "module": "composeApp",
      "reason": "no test source set"
    },
    {
      "module": "shared",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "shared",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "shared",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "shared",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    }
  ],
  "warnings": [],
  "parallel": {
    "test_type": "all",
    "max_workers": 0,
    "timeout_s": 900,
    "legs": [
      {
        "test_type": "common",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "desktop",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidUnit",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidInstrumented",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      }
    ]
  }
}
```

### kotlinconf-app-main — RED-repo

Path: `C:/Users/34645/AndroidStudioProjects/OFFICIAL_PROJECTS/kotlinconf-app-main/kotlinconf-app-main`
Category: NEW
Spawn exit: 1
Reason: module_failed discriminator (2 module(s), 14 testcases ran)

Envelope excerpt:
```json
{
  "exit_code": 1,
  "tests": {
    "total": 4,
    "passed": 2,
    "failed": 2,
    "skipped": 0,
    "individual_total": 14
  },
  "errors": [
    {
      "code": "module_failed",
      "module": "backend",
      "task": ":backend:test",
      "message": "[FAIL] backend"
    },
    {
      "code": "module_failed",
      "module": "backend",
      "task": ":backend:test",
      "message": "[FAIL] backend"
    }
  ],
  "skipped": [
    {
      "module": "androidApp",
      "reason": "no test source set"
    },
    {
      "module": "core",
      "reason": "no test source set"
    },
    {
      "module": "ui-components",
      "reason": "no test source set"
    },
    {
      "module": "backend",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "shared",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "backend",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "shared",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    }
  ],
  "warnings": [
    {
      "code": "no_test_modules_for_leg",
      "message": "Leg 'androidUnit': No modules support the requested --test-type=androidUnit",
      "test_type": "androidUnit"
    },
    {
      "code": "no_test_modules_for_leg",
      "message": "Leg 'androidInstrumented': No modules support the requested --test-type=androidInstrumented",
      "test_type": "androidInstrumented"
    }
  ],
  "parallel": {
    "test_type": "all",
    "max_workers": 0,
    "timeout_s": 900,
    "legs": [
      {
        "test_type": "common",
        "exit_code": 1,
        "execution": {
          "fresh": 1,
          "up_to_date": 1,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "desktop",
        "exit_code": 1,
        "execution": {
          "fresh": 1,
          "up_to_date": 1,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidUnit",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidInstrumented",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      }
    ]
  }
}
```

### Nav3Guide-master — SKIP

Path: `C:/Users/34645/AndroidStudioProjects/OFFICIAL_PROJECTS/Nav3Guide-master/Nav3Guide-master`
Category: NEW
Spawn exit: 3
Reason: all errors are no_test_modules (legitimately empty)

Envelope excerpt:
```json
{
  "exit_code": 3,
  "tests": {
    "total": 0,
    "passed": 0,
    "failed": 0,
    "skipped": 0,
    "individual_total": 0
  },
  "errors": [
    {
      "code": "no_test_modules",
      "message": "No modules support the requested --test-type=all",
      "test_type": "all"
    }
  ],
  "skipped": [
    {
      "module": "composeApp",
      "reason": "no test source set"
    }
  ],
  "warnings": []
}
```

### PeopleInSpace-main — RED-repo

Path: `C:/Users/34645/AndroidStudioProjects/OFFICIAL_PROJECTS/PeopleInSpace-main/PeopleInSpace-main`
Category: NEW
Spawn exit: 1
Reason: module_failed discriminator (1 module(s), 16 testcases ran)

Envelope excerpt:
```json
{
  "exit_code": 1,
  "tests": {
    "total": 4,
    "passed": 3,
    "failed": 1,
    "skipped": 0,
    "individual_total": 16
  },
  "errors": [
    {
      "code": "module_failed",
      "module": "wearApp",
      "task": ":wearApp:connectedDebugAndroidTest",
      "message": "[FAIL] wearApp"
    }
  ],
  "skipped": [
    {
      "module": "backend",
      "reason": "no test source set"
    },
    {
      "module": "compose-desktop",
      "reason": "no test source set"
    },
    {
      "module": "compose-web",
      "reason": "no test source set"
    },
    {
      "module": "mcp-server",
      "reason": "no test source set"
    },
    {
      "module": "app",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "wearApp",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "app",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "wearApp",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "app",
      "reason": "no androidUnitTest source set (--test-type=androidUnit)"
    },
    {
      "module": "common",
      "reason": "no androidUnitTest source set (--test-type=androidUnit)"
    },
    {
      "module": "wearApp",
      "reason": "no androidUnitTest source set (--test-type=androidUnit)"
    },
    {
      "module": "common",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    }
  ],
  "warnings": [
    {
      "code": "no_test_modules_for_leg",
      "message": "Leg 'androidUnit': No modules support the requested --test-type=androidUnit",
      "test_type": "androidUnit"
    }
  ],
  "parallel": {
    "test_type": "all",
    "max_workers": 0,
    "timeout_s": 900,
    "legs": [
      {
        "test_type": "common",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 1,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "desktop",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 1,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidUnit",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidInstrumented",
        "exit_code": 1,
        "execution": {
          "fresh": 2,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      }
    ]
  }
}
```

## Retrospective vs pass-8 baseline

Per-project regression check on the full 30-project matrix. Pass-8 results frozen 2026-05-04 (post-PR6 actuals from WIDE-SMOKE-PASS-8.md); pass-9 must match (or improve on Bug A/D repros). DELTA flags surface every flip — improvements (RED-repo → GREEN/SKIP on Bug A/D repros) and regressions (GREEN/SKIP → RED-orchestrator*) alike.

| Project | Pass-8 bucket | Pass-9 bucket | Notes |
|---|---|---|---|
| android-challenge | GREEN | GREEN | see `.smoke/pass-9/android-challenge.err` |
| DawSync | RED-repo | RED-repo | see `.smoke/pass-9/DawSync.err` |
| dipatternsdemo | RED-repo | RED-repo | see `.smoke/pass-9/dipatternsdemo.err` |
| dokka-markdown-plugin | SKIP | SKIP | see `.smoke/pass-9/dokka-markdown-plugin.err` |
| gyg | RED-repo | RED-repo | see `.smoke/pass-9/gyg.err` |
| OmniSound | RED-repo | RED-repo | see `.smoke/pass-9/OmniSound.err` |
| shared-kmp-libs | RED-repo | RED-repo | see `.smoke/pass-9/shared-kmp-libs.err` |
| TaskFlow | GREEN | GREEN | see `.smoke/pass-9/TaskFlow.err` |
| Confetti-main | RED-repo | RED-repo | see `.smoke/pass-9/Confetti-main.err` |
| DroidconKotlin-main | SKIP | SKIP | see `.smoke/pass-9/DroidconKotlin-main.err` |
| KMedia-main | SKIP | SKIP | see `.smoke/pass-9/KMedia-main.err` |
| kmp-production-sample-master | SKIP | SKIP | see `.smoke/pass-9/kmp-production-sample-master.err` |
| nav3-recipes | RED-repo | RED-repo | see `.smoke/pass-9/nav3-recipes.err` |
| Nav3Guide-scenes | SKIP | SKIP | see `.smoke/pass-9/Nav3Guide-scenes.err` |
| nowinandroid | RED-repo | RED-repo | see `.smoke/pass-9/nowinandroid.err` |
| NYTimes-KMP-main | SKIP | SKIP | see `.smoke/pass-9/NYTimes-KMP-main.err` |
| AndroidCommonDoc-build-logic | SKIP | SKIP | see `.smoke/pass-9/AndroidCommonDoc-build-logic.err` |
| AndroidCommonDoc-detekt-rules | SKIP | SKIP | see `.smoke/pass-9/AndroidCommonDoc-detekt-rules.err` |
| AndroidCommonDoc-konsist-tests | SKIP | SKIP | see `.smoke/pass-9/AndroidCommonDoc-konsist-tests.err` |
| kmp-test-runner-gradle-plugin | SKIP | SKIP | see `.smoke/pass-9/kmp-test-runner-gradle-plugin.err` |
| WakeTheCave | RED-repo | RED-repo | see `.smoke/pass-9/WakeTheCave.err` |
| WakeTheCave_clean | RED-repo | RED-repo | see `.smoke/pass-9/WakeTheCave_clean.err` |
| WakeTheCave_ref | RED-repo | RED-repo | see `.smoke/pass-9/WakeTheCave_ref.err` |
| FileKit-main | RED-repo | GREEN ✅ IMPROVEMENT | see `.smoke/pass-9/FileKit-main.err` |
| androidify-main | SKIP | SKIP | see `.smoke/pass-9/androidify-main.err` |
| KaMPKit-main | SKIP | SKIP | see `.smoke/pass-9/KaMPKit-main.err` |
| kmp-basic-sample-master | SKIP | SKIP | see `.smoke/pass-9/kmp-basic-sample-master.err` |
| kotlinconf-app-main | GREEN | RED-repo ⚠️ DELTA | see `.smoke/pass-9/kotlinconf-app-main.err` |
| Nav3Guide-master | SKIP | SKIP | see `.smoke/pass-9/Nav3Guide-master.err` |
| PeopleInSpace-main | RED-repo | RED-repo | see `.smoke/pass-9/PeopleInSpace-main.err` |

## Per-project artifacts

Forensic captures live in `.smoke/pass-9/` (gitignored — same `.smoke/` rule as pass-7/pass-8):

- `<safe-name>.out` — stdout (envelope between sentinel markers)
- `<safe-name>.err` — stderr (orchestrator log + gradle stderr)
- `<safe-name>.json` — extracted JSON envelope (only when emitted)
- `<safe-name>.meta.json` — run metadata (bucket, errorCodes, exit) for `--reclassify`
