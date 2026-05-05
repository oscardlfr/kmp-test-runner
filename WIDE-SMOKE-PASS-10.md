# Wide-smoke pass-10 — final pre-tag Win-side gate (post-fix-PR-F-bis + fix-PR-G)

Generated: 2026-05-05T13:08:45.999Z

Orchestrator HEAD: `b7478bf` (v0.8.0 release-line tip — fix-PR-F-bis #134 `0ac68c7` + fix-PR-G #135 `89e3cba` + pass-9-mac evidence #136 `b7478bf` cumulative on top of pass-9). fix-PR-F-bis: testBuildType-aware deviceTestTask candidate chain in `resolveTasksFor` + AGP source-set+variant branch reordered BEFORE early-return in `pickGradleTaskFor`. fix-PR-G: `--test-filter` translated per task class on `parallel --test-type androidInstrumented` (AGP `AndroidConnectedTest` does NOT accept `--tests`).

Goal: zero regression vs pass-9 baseline (3 GREEN / 14 SKIP / 13 RED-repo / 0 cascade / 0 RED-orchestrator). dipatternsdemo + AGP-instrumented modules may shift bucket sub-distribution (probed-task path now honors `--variant`; `--test-filter` no longer crashes `connectedDebugAndroidTest` with `Unknown command-line option '--tests'`). Any flip from GREEN/SKIP → RED-orchestrator-cascade or RED-orchestrator blocks the v0.8.0 tag.

## Key findings

1. **0 cascade-isolation cases** — matches pass-9 baseline. PR5's execution-summary cascade signature continues to gate the retry path correctly post-fix-PR-F-bis + fix-PR-G.

2. **13 legitimate RED-repo cases** — actual project test failures, out of scope for the v0.8.0 release tag. Affected: DawSync, dipatternsdemo, gyg, OmniSound, shared-kmp-libs, Confetti-main, nav3-recipes, nowinandroid, WakeTheCave, WakeTheCave_clean, WakeTheCave_ref, kotlinconf-app-main, PeopleInSpace-main.

3. **3 GREEN** — full sweep through orchestrator + JDK auto-select + tests passing: android-challenge, TaskFlow, FileKit-main.

4. **0 RED-orchestrator (other)** — every non-cascade orchestrator path is healthy post-fix-PR-F-bis + fix-PR-G.

5. **fix-PR-F-bis + fix-PR-G surface verified**: testBuildType-aware deviceTestTask candidate chain (PR-F-bis: probed-task path honors `--variant`), `--test-filter` translation per task class (PR-G: AGP-canonical `-Pandroid.testInstrumentationRunnerArguments.{class,method}=`) — cumulative effect against the 30-project matrix.

## Bucket counts

| Bucket | Pass-9 baseline | Pass-10 actual | Δ |
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
| android-challenge | PR3 | GREEN | 36s | 0 | – | 1 testcases ran |
| DawSync | PR3 | RED-repo | 4m 30s | 1 | module_failed×10 | module_failed discriminator (10 module(s), 16564 testcases ran) |
| dipatternsdemo | PR3 | RED-repo | 47s | 1 | module_failed×2 | module_failed discriminator (2 module(s), 68 testcases ran) |
| dokka-markdown-plugin | PR3 | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| gyg | PR3 | RED-repo | 1m 22s | 3 | no_test_modules×2, module_failed×2 | module_failed discriminator (2 module(s), 30 testcases ran) |
| OmniSound | PR3 | RED-repo | 1m 0s | 1 | module_failed×14 | module_failed discriminator (14 module(s), 3630 testcases ran) |
| shared-kmp-libs | PR3 | RED-repo | 5m 6s | 1 | module_failed | module_failed discriminator (1 module(s), 7180 testcases ran) |
| TaskFlow | PR3 | GREEN | 31s | 0 | – | 1 testcases ran |
| Confetti-main | INTERESTING | RED-repo | 1m 4s | 1 | module_failed, unsupported_class_version | module_failed discriminator (1 module(s), 133 testcases ran) |
| DroidconKotlin-main | INTERESTING | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| KMedia-main | INTERESTING | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| kmp-production-sample-master | INTERESTING | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| nav3-recipes | INTERESTING | RED-repo | 57s | 1 | module_failed | cascade-isolation retry fired on all cascade legs [androidUnit] — modules independently broken at evaluation phase (not orchestrator bug). 1 module_failed, 0 testcases ran in OTHER legs. |
| Nav3Guide-scenes | INTERESTING | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| nowinandroid | INTERESTING | RED-repo | 26s | 3 | module_failed×2, no_test_modules×2 | module_failed discriminator (2 module(s), 8 testcases ran) |
| NYTimes-KMP-main | INTERESTING | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| AndroidCommonDoc-build-logic | NEW | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| AndroidCommonDoc-detekt-rules | NEW | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| AndroidCommonDoc-konsist-tests | NEW | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| kmp-test-runner-gradle-plugin | NEW | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| WakeTheCave | NEW | RED-repo | 1m 3s | 1 | module_failed×60 | cascade-isolation retry fired on all cascade legs [common, desktop, androidUnit, androidInstrumented] — modules independently broken at evaluation phase (not orchestrator bug). 60 module_failed, 0 testcases ran in OTHER legs. |
| WakeTheCave_clean | NEW | RED-repo | 40s | 1 | module_failed×47 | cascade-isolation retry fired on all cascade legs [common, desktop, androidUnit, androidInstrumented] — modules independently broken at evaluation phase (not orchestrator bug). 47 module_failed, 0 testcases ran in OTHER legs. |
| WakeTheCave_ref | NEW | RED-repo | 17s | 3 | no_test_modules×2, module_failed×19 | cascade-isolation retry fired on all cascade legs [androidUnit, androidInstrumented] — modules independently broken at evaluation phase (not orchestrator bug). 19 module_failed, 0 testcases ran in OTHER legs. |
| FileKit-main | NEW | GREEN | 9s | 0 | – | 56 testcases ran |
| androidify-main | NEW | SKIP | 1s | 3 | no_test_modules×4 | all errors are no_test_modules (legitimately empty) |
| KaMPKit-main | NEW | SKIP | 1s | 3 | no_test_modules×4 | all errors are no_test_modules (legitimately empty) |
| kmp-basic-sample-master | NEW | SKIP | 1s | 3 | no_test_modules×4 | all errors are no_test_modules (legitimately empty) |
| kotlinconf-app-main | NEW | RED-repo | 4m 32s | 1 | module_failed×2 | module_failed discriminator (2 module(s), 14 testcases ran) |
| Nav3Guide-master | NEW | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| PeopleInSpace-main | NEW | RED-repo | 1m 25s | 1 | module_failed | module_failed discriminator (1 module(s), 16 testcases ran) |

## Per-project envelopes (non-GREEN)

### DawSync — RED-repo

Path: `C:/Users/34645/AndroidStudioProjects/DawSync`
Category: PR3
Spawn exit: 1
Reason: module_failed discriminator (10 module(s), 16564 testcases ran)

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
          "fresh": 3,
          "up_to_date": 0,
          "from_cache": 13,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 5,
          "no_evidence": 0
        }
      },
      {
        "test_type": "desktop",
        "exit_code": 1,
        "execution": {
          "fresh": 3,
          "up_to_date": 0,
          "from_cache": 13,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 5,
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
Reason: module_failed discriminator (2 module(s), 68 testcases ran)

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
      "task": ":benchmark:connectedReleaseAndroidTest",
      "message": "[FAIL] benchmark"
    },
    {
      "code": "module_failed",
      "module": "sample-multimodule",
      "task": ":sample-multimodule:connectedDebugAndroidTest",
      "message": "[FAIL] sample-multimodule"
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
          "failed": 2,
          "no_evidence": 0
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
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 1,
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
          "failed": 1,
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
Reason: module_failed discriminator (14 module(s), 3630 testcases ran)

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
          "failed": 7,
          "no_evidence": 0
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
          "failed": 7,
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

### shared-kmp-libs — RED-repo

Path: `C:/Users/34645/AndroidStudioProjects/shared-kmp-libs`
Category: PR3
Spawn exit: 1
Reason: module_failed discriminator (1 module(s), 7180 testcases ran)

Envelope excerpt:
```json
{
  "exit_code": 1,
  "tests": {
    "total": 129,
    "passed": 128,
    "failed": 1,
    "skipped": 0,
    "individual_total": 7180
  },
  "errors": [
    {
      "code": "module_failed",
      "module": "benchmark-storage",
      "task": ":benchmark-storage:androidConnectedCheck",
      "message": "[FAIL] benchmark-storage"
    }
  ],
  "skipped": [
    {
      "module": "benchmark-infra",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core-encryption-envelope-api",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core-error-audit",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core-error-backend",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core-error-gdpr",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "core-result",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "benchmark-infra",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core-encryption-envelope-api",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core-error-audit",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core-error-backend",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core-error-gdpr",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "core-result",
      "reason": "no desktop target (--test-type=desktop)"
    },
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
      "module": "benchmark-crypto",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "benchmark-infra",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "benchmark-io",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-audit",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-auth-biometric",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-backend-api",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-billing-api",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-common",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-designsystem-foundation",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-di-anvil",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-domain",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-encryption",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-encryption-envelope",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-encryption-envelope-api",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-error",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-error-audit",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-error-backend",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-error-billing",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-error-biometric",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-error-encryption",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-error-firebase",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-error-gdpr",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-error-io",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-error-json",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-error-network",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-error-oauth",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-error-sdk",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-error-storage",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-error-storage-mmkv",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-firebase-api",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-firebase-native",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-firebase-rest",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-gdpr",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-io-api",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-io-kotlinxio",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-io-okio",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-io-watcher",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-json-api",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-json-kotlinx",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-logging",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-network-api",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-network-ktor",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-network-retrofit",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-oauth-1a",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "core-oauth-api",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-oauth-browser",
      "reason": "no androidInstrumentedTest source set (--test-type=androidInstrumented)"
    },
    {
      "module": "core-oauth-native",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-result",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-sdk",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-security-keys",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-storage-api",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-storage-cache",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-storage-datastore",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-storage-encryption",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-storage-mmkv",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-storage-secure",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-storage-settings",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-storage-sql",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-storage-sql-cipher",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-subscription",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-system",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-system-api",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-testing",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
    },
    {
      "module": "core-version",
      "reason": "no androidDeviceTest source set (withDeviceTestBuilder{} missing) (--test-type=androidInstrumented)"
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
        "exit_code": 0,
        "execution": {
          "fresh": 1,
          "up_to_date": 62,
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
          "fresh": 1,
          "up_to_date": 62,
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
          "failed": 1,
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
          "fresh": 0,
          "up_to_date": 1,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 1,
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
          "failed": 1,
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
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 1,
          "no_evidence": 0
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
          "failed": 1,
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
          "failed": 29,
          "no_evidence": 0
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
          "failed": 29,
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
          "failed": 1,
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
          "failed": 1,
          "no_evidence": 0
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
          "failed": 12,
          "no_evidence": 0
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
          "failed": 12,
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
          "failed": 17,
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
          "failed": 6,
          "no_evidence": 0
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
          "failed": 9,
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
          "failed": 10,
          "no_evidence": 0
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
          "fresh": 0,
          "up_to_date": 1,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 1,
          "no_evidence": 0
        }
      },
      {
        "test_type": "desktop",
        "exit_code": 1,
        "execution": {
          "fresh": 0,
          "up_to_date": 1,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 1,
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
          "fresh": 1,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 1,
          "no_evidence": 0
        }
      }
    ]
  }
}
```

## Retrospective vs pass-9 baseline

Per-project regression check on the full 30-project matrix. Pass-9 results frozen 2026-05-04 (post-fix-PR-A/D/B/C actuals from WIDE-SMOKE-PASS-9.md); pass-10 must match (or improve on dipatternsdemo / AGP-instrumented sub-distribution from fix-PR-F-bis + fix-PR-G effect). DELTA flags surface every flip — improvements (RED-repo → GREEN/SKIP) and regressions (GREEN/SKIP → RED-orchestrator*) alike.

| Project | Pass-9 bucket | Pass-10 bucket | Notes |
|---|---|---|---|
| android-challenge | GREEN | GREEN | see `.smoke/pass-10/android-challenge.err` |
| DawSync | RED-repo | RED-repo | see `.smoke/pass-10/DawSync.err` |
| dipatternsdemo | RED-repo | RED-repo | see `.smoke/pass-10/dipatternsdemo.err` |
| dokka-markdown-plugin | SKIP | SKIP | see `.smoke/pass-10/dokka-markdown-plugin.err` |
| gyg | RED-repo | RED-repo | see `.smoke/pass-10/gyg.err` |
| OmniSound | RED-repo | RED-repo | see `.smoke/pass-10/OmniSound.err` |
| shared-kmp-libs | RED-repo | RED-repo | see `.smoke/pass-10/shared-kmp-libs.err` |
| TaskFlow | GREEN | GREEN | see `.smoke/pass-10/TaskFlow.err` |
| Confetti-main | RED-repo | RED-repo | see `.smoke/pass-10/Confetti-main.err` |
| DroidconKotlin-main | SKIP | SKIP | see `.smoke/pass-10/DroidconKotlin-main.err` |
| KMedia-main | SKIP | SKIP | see `.smoke/pass-10/KMedia-main.err` |
| kmp-production-sample-master | SKIP | SKIP | see `.smoke/pass-10/kmp-production-sample-master.err` |
| nav3-recipes | RED-repo | RED-repo | see `.smoke/pass-10/nav3-recipes.err` |
| Nav3Guide-scenes | SKIP | SKIP | see `.smoke/pass-10/Nav3Guide-scenes.err` |
| nowinandroid | RED-repo | RED-repo | see `.smoke/pass-10/nowinandroid.err` |
| NYTimes-KMP-main | SKIP | SKIP | see `.smoke/pass-10/NYTimes-KMP-main.err` |
| AndroidCommonDoc-build-logic | SKIP | SKIP | see `.smoke/pass-10/AndroidCommonDoc-build-logic.err` |
| AndroidCommonDoc-detekt-rules | SKIP | SKIP | see `.smoke/pass-10/AndroidCommonDoc-detekt-rules.err` |
| AndroidCommonDoc-konsist-tests | SKIP | SKIP | see `.smoke/pass-10/AndroidCommonDoc-konsist-tests.err` |
| kmp-test-runner-gradle-plugin | SKIP | SKIP | see `.smoke/pass-10/kmp-test-runner-gradle-plugin.err` |
| WakeTheCave | RED-repo | RED-repo | see `.smoke/pass-10/WakeTheCave.err` |
| WakeTheCave_clean | RED-repo | RED-repo | see `.smoke/pass-10/WakeTheCave_clean.err` |
| WakeTheCave_ref | RED-repo | RED-repo | see `.smoke/pass-10/WakeTheCave_ref.err` |
| FileKit-main | GREEN | GREEN | see `.smoke/pass-10/FileKit-main.err` |
| androidify-main | SKIP | SKIP | see `.smoke/pass-10/androidify-main.err` |
| KaMPKit-main | SKIP | SKIP | see `.smoke/pass-10/KaMPKit-main.err` |
| kmp-basic-sample-master | SKIP | SKIP | see `.smoke/pass-10/kmp-basic-sample-master.err` |
| kotlinconf-app-main | RED-repo | RED-repo | see `.smoke/pass-10/kotlinconf-app-main.err` |
| Nav3Guide-master | SKIP | SKIP | see `.smoke/pass-10/Nav3Guide-master.err` |
| PeopleInSpace-main | RED-repo | RED-repo | see `.smoke/pass-10/PeopleInSpace-main.err` |

## Per-project artifacts

Forensic captures live in `.smoke/pass-10/` (gitignored — same `.smoke/` rule as pass-7/pass-8/pass-9):

- `<safe-name>.out` — stdout (envelope between sentinel markers)
- `<safe-name>.err` — stderr (orchestrator log + gradle stderr)
- `<safe-name>.json` — extracted JSON envelope (only when emitted)
- `<safe-name>.meta.json` — run metadata (bucket, errorCodes, exit) for `--reclassify`
