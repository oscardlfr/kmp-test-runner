# Wide-smoke pass-7 — v0.8.0 release-validation baseline

Generated: 2026-05-03T22:24:21.283Z

Orchestrator HEAD: `0910615` (v0.7.0 + PR1+PR2+PR3 of v0.8.0 ramp).

## Key findings

1. **8 cascade-isolation cases** — orchestrator bug, not real test failures. PR #116's retry path did NOT fire even when its documented conditions matched (`legExit !== 0 && taskList.length > 1 && !anyTaskMentioned`). Affected: DawSync, dipatternsdemo, OmniSound, nav3-recipes, WakeTheCave, WakeTheCave_clean, WakeTheCave_ref, FileKit-main. **Raises PR5 priority.**

2. **5 legitimate RED-repo cases** — actual project test failures, out of scope for this PR. Affected: gyg, shared-kmp-libs, Confetti-main, nowinandroid, PeopleInSpace-main.

3. **3 GREEN** — full sweep through orchestrator + JDK auto-select + tests passing: android-challenge, TaskFlow, kotlinconf-app-main.

4. **0 RED-orchestrator (other)** — every non-cascade orchestrator path is healthy post-PR1+PR2+PR3.

5. Discriminator hits worth flagging:
   - `unsupported_class_version` on Confetti-main despite PR3's AGP-aware JDK auto-select (BACKLOG candidate).
   - `task_not_found` paired with `module_failed` on 4 projects (DawSync, dipatternsdemo, shared-kmp-libs, FileKit-main) — orchestrator dispatching a task name the project doesn't expose (project model overreach; BACKLOG candidate).

## Bucket counts

| Bucket | Count |
|---|---|
| GREEN | 3 |
| SKIP | 14 |
| RED-repo | 5 |
| RED-orchestrator-cascade | 8 |
| RED-orchestrator | 0 |
| MISSING | 0 |
| **Total** | **30** |

## Summary table

| Project | Category | Bucket | Duration | Exit | Discriminators | Notes |
|---|---|---|---|---|---|---|
| android-challenge | PR3 | GREEN | 1m 12s | 0 | – | 1 testcases ran |
| DawSync | PR3 | RED-orchestrator-cascade | 4m 31s | 1 | module_failed×48, task_not_found | cascade-isolation signature: legs [common, desktop, androidUnit, androidInstrumented] dispatched 48 tasks, gradle never mentioned any (no_evidence). Retry path from PR #116 didn't fire. 16564 testcases ran in OTHER legs. |
| dipatternsdemo | PR3 | RED-orchestrator-cascade | 46s | 1 | module_failed×3, task_not_found | cascade-isolation signature: legs [androidUnit, androidInstrumented] dispatched 3 tasks, gradle never mentioned any (no_evidence). Retry path from PR #116 didn't fire. 68 testcases ran in OTHER legs. |
| dokka-markdown-plugin | PR3 | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| gyg | PR3 | RED-repo | 1m 47s | 3 | no_test_modules×2, module_failed×2 | module_failed discriminator (2 module(s), 30 testcases ran) |
| OmniSound | PR3 | RED-orchestrator-cascade | 1m 10s | 1 | module_failed×14 | cascade-isolation signature: legs [common, desktop] dispatched 14 tasks, gradle never mentioned any (no_evidence). Retry path from PR #116 didn't fire. 3630 testcases ran in OTHER legs. |
| shared-kmp-libs | PR3 | RED-repo | 10m 28s | 1 | module_failed×66, task_not_found | MIXED: cascade in [androidUnit] + real failures in [androidInstrumented] (66 module_failed, 7750 testcases ran) |
| TaskFlow | PR3 | GREEN | 1m 15s | 0 | – | 1 testcases ran |
| Confetti-main | INTERESTING | RED-repo | 2m 22s | 1 | module_failed, unsupported_class_version | module_failed discriminator (1 module(s), 133 testcases ran) |
| DroidconKotlin-main | INTERESTING | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| KMedia-main | INTERESTING | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| kmp-production-sample-master | INTERESTING | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| nav3-recipes | INTERESTING | RED-orchestrator-cascade | 1m 46s | 1 | module_failed | cascade-isolation signature: legs [androidUnit] dispatched 1 tasks, gradle never mentioned any (no_evidence). Retry path from PR #116 didn't fire. 0 testcases ran in OTHER legs. |
| Nav3Guide-scenes | INTERESTING | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| nowinandroid | INTERESTING | RED-repo | 38s | 3 | module_failed×2, no_test_modules×2 | module_failed discriminator (2 module(s), 8 testcases ran) |
| NYTimes-KMP-main | INTERESTING | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| AndroidCommonDoc-build-logic | NEW | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| AndroidCommonDoc-detekt-rules | NEW | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| AndroidCommonDoc-konsist-tests | NEW | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| kmp-test-runner-gradle-plugin | NEW | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| WakeTheCave | NEW | RED-orchestrator-cascade | 1m 58s | 1 | module_failed×118 | cascade-isolation signature: legs [common, desktop, androidUnit, androidInstrumented] dispatched 118 tasks, gradle never mentioned any (no_evidence). Retry path from PR #116 didn't fire. 0 testcases ran in OTHER legs. |
| WakeTheCave_clean | NEW | RED-orchestrator-cascade | 1m 20s | 1 | module_failed×90 | cascade-isolation signature: legs [common, desktop, androidUnit, androidInstrumented] dispatched 90 tasks, gradle never mentioned any (no_evidence). Retry path from PR #116 didn't fire. 0 testcases ran in OTHER legs. |
| WakeTheCave_ref | NEW | RED-orchestrator-cascade | 38s | 3 | no_test_modules×2, module_failed×38 | cascade-isolation signature: legs [androidUnit, androidInstrumented] dispatched 38 tasks, gradle never mentioned any (no_evidence). Retry path from PR #116 didn't fire. 0 testcases ran in OTHER legs. |
| FileKit-main | NEW | RED-orchestrator-cascade | 42s | 1 | module_failed×4, task_not_found | cascade-isolation signature: legs [androidUnit, androidInstrumented] dispatched 4 tasks, gradle never mentioned any (no_evidence). Retry path from PR #116 didn't fire. 56 testcases ran in OTHER legs. |
| androidify-main | NEW | SKIP | 2s | 3 | no_test_modules×4 | all errors are no_test_modules (legitimately empty) |
| KaMPKit-main | NEW | SKIP | 1s | 3 | no_test_modules×4 | all errors are no_test_modules (legitimately empty) |
| kmp-basic-sample-master | NEW | SKIP | 1s | 3 | no_test_modules×4 | all errors are no_test_modules (legitimately empty) |
| kotlinconf-app-main | NEW | GREEN | 20s | 0 | – | 14 testcases ran |
| Nav3Guide-master | NEW | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| PeopleInSpace-main | NEW | RED-repo | 3m 41s | 1 | module_failed×2 | module_failed discriminator (2 module(s), 24 testcases ran) |

## Per-project envelopes (non-GREEN)

### DawSync — RED-orchestrator-cascade

Path: `C:/Users/34645/AndroidStudioProjects/DawSync`
Category: PR3
Spawn exit: 1
Reason: cascade-isolation signature: legs [common, desktop, androidUnit, androidInstrumented] dispatched 48 tasks, gradle never mentioned any (no_evidence). Retry path from PR #116 didn't fire. 16564 testcases ran in OTHER legs.

Envelope excerpt:
```json
{
  "exit_code": 1,
  "tests": {
    "total": 80,
    "passed": 32,
    "failed": 48,
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
    },
    {
      "code": "module_failed",
      "module": "benchmark",
      "task": ":benchmark:testDebugUnitTest",
      "message": "[FAIL] benchmark"
    },
    {
      "code": "module_failed",
      "module": "core:audio",
      "task": ":core:audio:testDebugUnitTest",
      "message": "[FAIL] core:audio"
    },
    {
      "code": "module_failed",
      "module": "core:data",
      "task": ":core:data:testDebugUnitTest",
      "message": "[FAIL] core:data"
    },
    {
      "code": "module_failed",
      "module": "core:database",
      "task": ":core:database:testDebugUnitTest",
      "message": "[FAIL] core:database"
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
      "module": "core:media-session",
      "task": ":core:media-session:testDebugUnitTest",
      "message": "[FAIL] core:media-session"
    },
    {
      "code": "module_failed",
      "module": "core:model",
      "task": ":core:model:testDebugUnitTest",
      "message": "[FAIL] core:model"
    },
    {
      "code": "module_failed",
      "module": "core:navigation",
      "task": ":core:navigation:testDebugUnitTest",
      "message": "[FAIL] core:navigation"
    },
    {
      "code": "module_failed",
      "module": "feature:action-history",
      "task": ":feature:action-history:testDebugUnitTest",
      "message": "[FAIL] feature:action-history"
    },
    {
      "code": "module_failed",
      "module": "feature:activity-log",
      "task": ":feature:activity-log:testDebugUnitTest",
      "message": "[FAIL] feature:activity-log"
    },
    {
      "code": "module_failed",
      "module": "feature:analytics",
      "task": ":feature:analytics:testDebugUnitTest",
      "message": "[FAIL] feature:analytics"
    },
    {
      "code": "module_failed",
      "module": "feature:onboarding",
      "task": ":feature:onboarding:testDebugUnitTest",
      "message": "[FAIL] feature:onboarding"
    },
    {
      "code": "module_failed",
      "module": "feature:projects",
      "task": ":feature:projects:testDebugUnitTest",
      "message": "[FAIL] feature:projects"
    },
    {
      "code": "module_failed",
      "module": "feature:sessions",
      "task": ":feature:sessions:testDebugUnitTest",
      "message": "[FAIL] feature:sessions"
    },
    {
      "code": "module_failed",
      "module": "feature:settings",
      "task": ":feature:settings:testDebugUnitTest",
      "message": "[FAIL] feature:settings"
    },
    {
      "code": "module_failed",
      "module": "feature:snapshot-list",
      "task": ":feature:snapshot-list:testDebugUnitTest",
      "message": "[FAIL] feature:snapshot-list"
    },
    {
      "code": "module_failed",
      "module": "feature:sync-status",
      "task": ":feature:sync-status:testDebugUnitTest",
      "message": "[FAIL] feature:sync-status"
    },
    {
      "code": "module_failed",
      "module": "feature:workspace-management",
      "task": ":feature:workspace-management:testDebugUnitTest",
      "message": "[FAIL] feature:workspace-management"
    },
    {
      "code": "module_failed",
      "module": "benchmark",
      "task": ":benchmark:connectedDebugAndroidTest",
      "message": "[FAIL] benchmark"
    },
    {
      "code": "module_failed",
      "module": "core:audio",
      "task": ":core:audio:connectedDebugAndroidTest",
      "message": "[FAIL] core:audio"
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
      "module": "core:domain",
      "task": ":core:domain:connectedDebugAndroidTest",
      "message": "[FAIL] core:domain"
    },
    {
      "code": "module_failed",
      "module": "core:media-session",
      "task": ":core:media-session:connectedDebugAndroidTest",
      "message": "[FAIL] core:media-session"
    },
    {
      "code": "module_failed",
      "module": "core:model",
      "task": ":core:model:connectedDebugAndroidTest",
      "message": "[FAIL] core:model"
    },
    {
      "code": "module_failed",
      "module": "core:navigation",
      "task": ":core:navigation:connectedDebugAndroidTest",
      "message": "[FAIL] core:navigation"
    },
    {
      "code": "module_failed",
      "module": "feature:action-history",
      "task": ":feature:action-history:connectedDebugAndroidTest",
      "message": "[FAIL] feature:action-history"
    },
    {
      "code": "module_failed",
      "module": "feature:activity-log",
      "task": ":feature:activity-log:connectedDebugAndroidTest",
      "message": "[FAIL] feature:activity-log"
    },
    {
      "code": "module_failed",
      "module": "feature:analytics",
      "task": ":feature:analytics:connectedDebugAndroidTest",
      "message": "[FAIL] feature:analytics"
    },
    {
      "code": "module_failed",
      "module": "feature:onboarding",
      "task": ":feature:onboarding:connectedDebugAndroidTest",
      "message": "[FAIL] feature:onboarding"
    },
    {
      "code": "module_failed",
      "module": "feature:projects",
      "task": ":feature:projects:connectedDebugAndroidTest",
      "message": "[FAIL] feature:projects"
    },
    {
      "code": "module_failed",
      "module": "feature:sessions",
      "task": ":feature:sessions:connectedDebugAndroidTest",
      "message": "[FAIL] feature:sessions"
    },
    {
      "code": "module_failed",
      "module": "feature:settings",
      "task": ":feature:settings:connectedDebugAndroidTest",
      "message": "[FAIL] feature:settings"
    },
    {
      "code": "module_failed",
      "module": "feature:snapshot-list",
      "task": ":feature:snapshot-list:connectedDebugAndroidTest",
      "message": "[FAIL] feature:snapshot-list"
    },
    {
      "code": "module_failed",
      "module": "feature:sync-status",
      "task": ":feature:sync-status:connectedDebugAndroidTest",
      "message": "[FAIL] feature:sync-status"
    },
    {
      "code": "module_failed",
      "module": "feature:workspace-management",
      "task": ":feature:workspace-management:connectedDebugAndroidTest",
      "message": "[FAIL] feature:workspace-management"
    },
    {
      "code": "task_not_found",
      "message": "Cannot locate tasks that match ':benchmark:testDebugUnitTest' as task 'testDebugUnitTest' not found in project ':benchmark'."
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
      "module": "desktopApp",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "konsist-guard",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "desktopApp",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "konsist-guard",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
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
        "exit_code": 1,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 19
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
          "no_evidence": 19
        }
      }
    ]
  }
}
```

### dipatternsdemo — RED-orchestrator-cascade

Path: `C:/Users/34645/AndroidStudioProjects/dipatternsdemo`
Category: PR3
Spawn exit: 1
Reason: cascade-isolation signature: legs [androidUnit, androidInstrumented] dispatched 3 tasks, gradle never mentioned any (no_evidence). Retry path from PR #116 didn't fire. 68 testcases ran in OTHER legs.

Envelope excerpt:
```json
{
  "exit_code": 1,
  "tests": {
    "total": 6,
    "passed": 3,
    "failed": 3,
    "skipped": 0,
    "individual_total": 68
  },
  "errors": [
    {
      "code": "module_failed",
      "module": "benchmark",
      "task": ":benchmark:testDebugUnitTest",
      "message": "[FAIL] benchmark"
    },
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
      "message": "Cannot locate tasks that match ':benchmark:testDebugUnitTest' as task 'testDebugUnitTest' not found in project ':benchmark'."
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
          "up_to_date": 1,
          "from_cache": 0,
          "no_source": 1,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 1
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

### OmniSound — RED-orchestrator-cascade

Path: `C:/Users/34645/AndroidStudioProjects/OmniSound`
Category: PR3
Spawn exit: 1
Reason: cascade-isolation signature: legs [common, desktop] dispatched 14 tasks, gradle never mentioned any (no_evidence). Retry path from PR #116 didn't fire. 3630 testcases ran in OTHER legs.

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
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "core-database",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "core-designsystem",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "core-domain",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "core-model",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "feature-bandcamp",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "feature-discogs",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "feature-duplicates",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "feature-local-library",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "feature-soundcloud",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "feature-youtube",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
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
Reason: MIXED: cascade in [androidUnit] + real failures in [androidInstrumented] (66 module_failed, 7750 testcases ran)

Envelope excerpt:
```json
{
  "exit_code": 1,
  "tests": {
    "total": 268,
    "passed": 202,
    "failed": 66,
    "skipped": 0,
    "individual_total": 7750
  },
  "errors": [
    {
      "code": "module_failed",
      "module": "benchmark-crypto",
      "task": ":benchmark-crypto:testDebugUnitTest",
      "message": "[FAIL] benchmark-crypto"
    },
    {
      "code": "module_failed",
      "module": "benchmark-infra",
      "task": ":benchmark-infra:testDebugUnitTest",
      "message": "[FAIL] benchmark-infra"
    },
    {
      "code": "module_failed",
      "module": "benchmark-io",
      "task": ":benchmark-io:testDebugUnitTest",
      "message": "[FAIL] benchmark-io"
    },
    {
      "code": "module_failed",
      "module": "benchmark-network",
      "task": ":benchmark-network:testDebugUnitTest",
      "message": "[FAIL] benchmark-network"
    },
    {
      "code": "module_failed",
      "module": "benchmark-sdk",
      "task": ":benchmark-sdk:testDebugUnitTest",
      "message": "[FAIL] benchmark-sdk"
    },
    {
      "code": "module_failed",
      "module": "benchmark-storage",
      "task": ":benchmark-storage:testDebugUnitTest",
      "message": "[FAIL] benchmark-storage"
    },
    {
      "code": "module_failed",
      "module": "core-audit",
      "task": ":core-audit:testDebugUnitTest",
      "message": "[FAIL] core-audit"
    },
    {
      "code": "module_failed",
      "module": "core-auth-biometric",
      "task": ":core-auth-biometric:testDebugUnitTest",
      "message": "[FAIL] core-auth-biometric"
    },
    {
      "code": "module_failed",
      "module": "core-backend-api",
      "task": ":core-backend-api:testDebugUnitTest",
      "message": "[FAIL] core-backend-api"
    },
    {
      "code": "module_failed",
      "module": "core-billing-api",
      "task": ":core-billing-api:testDebugUnitTest",
      "message": "[FAIL] core-billing-api"
    },
    {
      "code": "module_failed",
      "module": "core-common",
      "task": ":core-common:testDebugUnitTest",
      "message": "[FAIL] core-common"
    },
    {
      "code": "module_failed",
      "module": "core-designsystem-foundation",
      "task": ":core-designsystem-foundation:testDebugUnitTest",
      "message": "[FAIL] core-designsystem-foundation"
    },
    {
      "code": "module_failed",
      "module": "core-di-anvil",
      "task": ":core-di-anvil:testDebugUnitTest",
      "message": "[FAIL] core-di-anvil"
    },
    {
      "code": "module_failed",
      "module": "core-domain",
      "task": ":core-domain:testDebugUnitTest",
      "message": "[FAIL] core-domain"
    },
    {
      "code": "module_failed",
      "module": "core-encryption",
      "task": ":core-encryption:testDebugUnitTest",
      "message": "[FAIL] core-encryption"
    },
    {
      "code": "module_failed",
      "module": "core-encryption-envelope",
      "task": ":core-encryption-envelope:testDebugUnitTest",
      "message": "[FAIL] core-encryption-envelope"
    },
    {
      "code": "module_failed",
      "module": "core-encryption-envelope-api",
      "task": ":core-encryption-envelope-api:testDebugUnitTest",
      "message": "[FAIL] core-encryption-envelope-api"
    },
    {
      "code": "module_failed",
      "module": "core-error",
      "task": ":core-error:testDebugUnitTest",
      "message": "[FAIL] core-error"
    },
    {
      "code": "module_failed",
      "module": "core-error-audit",
      "task": ":core-error-audit:testDebugUnitTest",
      "message": "[FAIL] core-error-audit"
    },
    {
      "code": "module_failed",
      "module": "core-error-backend",
      "task": ":core-error-backend:testDebugUnitTest",
      "message": "[FAIL] core-error-backend"
    },
    {
      "code": "module_failed",
      "module": "core-error-billing",
      "task": ":core-error-billing:testDebugUnitTest",
      "message": "[FAIL] core-error-billing"
    },
    {
      "code": "module_failed",
      "module": "core-error-biometric",
      "task": ":core-error-biometric:testDebugUnitTest",
      "message": "[FAIL] core-error-biometric"
    },
    {
      "code": "module_failed",
      "module": "core-error-encryption",
      "task": ":core-error-encryption:testDebugUnitTest",
      "message": "[FAIL] core-error-encryption"
    },
    {
      "code": "module_failed",
      "module": "core-error-firebase",
      "task": ":core-error-firebase:testDebugUnitTest",
      "message": "[FAIL] core-error-firebase"
    },
    {
      "code": "module_failed",
      "module": "core-error-gdpr",
      "task": ":core-error-gdpr:testDebugUnitTest",
      "message": "[FAIL] core-error-gdpr"
    },
    {
      "code": "module_failed",
      "module": "core-error-io",
      "task": ":core-error-io:testDebugUnitTest",
      "message": "[FAIL] core-error-io"
    },
    {
      "code": "module_failed",
      "module": "core-error-json",
      "task": ":core-error-json:testDebugUnitTest",
      "message": "[FAIL] core-error-json"
    },
    {
      "code": "module_failed",
      "module": "core-error-network",
      "task": ":core-error-network:testDebugUnitTest",
      "message": "[FAIL] core-error-network"
    },
    {
      "code": "module_failed",
      "module": "core-error-oauth",
      "task": ":core-error-oauth:testDebugUnitTest",
      "message": "[FAIL] core-error-oauth"
    },
    {
      "code": "module_failed",
      "module": "core-error-sdk",
      "task": ":core-error-sdk:testDebugUnitTest",
      "message": "[FAIL] core-error-sdk"
    },
    {
      "code": "module_failed",
      "module": "core-error-storage",
      "task": ":core-error-storage:testDebugUnitTest",
      "message": "[FAIL] core-error-storage"
    },
    {
      "code": "module_failed",
      "module": "core-error-storage-mmkv",
      "task": ":core-error-storage-mmkv:testDebugUnitTest",
      "message": "[FAIL] core-error-storage-mmkv"
    },
    {
      "code": "module_failed",
      "module": "core-firebase-api",
      "task": ":core-firebase-api:testDebugUnitTest",
      "message": "[FAIL] core-firebase-api"
    },
    {
      "code": "module_failed",
      "module": "core-firebase-native",
      "task": ":core-firebase-native:testDebugUnitTest",
      "message": "[FAIL] core-firebase-native"
    },
    {
      "code": "module_failed",
      "module": "core-firebase-rest",
      "task": ":core-firebase-rest:testDebugUnitTest",
      "message": "[FAIL] core-firebase-rest"
    },
    {
      "code": "module_failed",
      "module": "core-gdpr",
      "task": ":core-gdpr:testDebugUnitTest",
      "message": "[FAIL] core-gdpr"
    },
    {
      "code": "module_failed",
      "module": "core-io-api",
      "task": ":core-io-api:testDebugUnitTest",
      "message": "[FAIL] core-io-api"
    },
    {
      "code": "module_failed",
      "module": "core-io-kotlinxio",
      "task": ":core-io-kotlinxio:testDebugUnitTest",
      "message": "[FAIL] core-io-kotlinxio"
    },
    {
      "code": "module_failed",
      "module": "core-io-okio",
      "task": ":core-io-okio:testDebugUnitTest",
      "message": "[FAIL] core-io-okio"
    },
    {
      "code": "module_failed",
      "module": "core-io-watcher",
      "task": ":core-io-watcher:testDebugUnitTest",
      "message": "[FAIL] core-io-watcher"
    },
    {
      "code": "module_failed",
      "module": "core-json-api",
      "task": ":core-json-api:testDebugUnitTest",
      "message": "[FAIL] core-json-api"
    },
    {
      "code": "module_failed",
      "module": "core-json-kotlinx",
      "task": ":core-json-kotlinx:testDebugUnitTest",
      "message": "[FAIL] core-json-kotlinx"
    },
    {
      "code": "module_failed",
      "module": "core-logging",
      "task": ":core-logging:testDebugUnitTest",
      "message": "[FAIL] core-logging"
    },
    {
      "code": "module_failed",
      "module": "core-network-api",
      "task": ":core-network-api:testDebugUnitTest",
      "message": "[FAIL] core-network-api"
    },
    {
      "code": "module_failed",
      "module": "core-network-ktor",
      "task": ":core-network-ktor:testDebugUnitTest",
      "message": "[FAIL] core-network-ktor"
    },
    {
      "code": "module_failed",
      "module": "core-network-retrofit",
      "task": ":core-network-retrofit:testDebugUnitTest",
      "message": "[FAIL] core-network-retrofit"
    },
    {
      "code": "module_failed",
      "module": "core-oauth-api",
      "task": ":core-oauth-api:testDebugUnitTest",
      "message": "[FAIL] core-oauth-api"
    },
    {
      "code": "module_failed",
      "module": "core-oauth-native",
      "task": ":core-oauth-native:testDebugUnitTest",
      "message": "[FAIL] core-oauth-native"
    },
    {
      "code": "module_failed",
      "module": "core-result",
      "task": ":core-result:testDebugUnitTest",
      "message": "[FAIL] core-result"
    },
    {
      "code": "module_failed",
      "module": "core-sdk",
      "task": ":core-sdk:testDebugUnitTest",
      "message": "[FAIL] core-sdk"
    },
    {
      "code": "module_failed",
      "module": "core-security-keys",
      "task": ":core-security-keys:testDebugUnitTest",
      "message": "[FAIL] core-security-keys"
    },
    {
      "code": "module_failed",
      "module": "core-storage-api",
      "task": ":core-storage-api:testDebugUnitTest",
      "message": "[FAIL] core-storage-api"
    },
    {
      "code": "module_failed",
      "module": "core-storage-cache",
      "task": ":core-storage-cache:testDebugUnitTest",
      "message": "[FAIL] core-storage-cache"
    },
    {
      "code": "module_failed",
      "module": "core-storage-datastore",
      "task": ":core-storage-datastore:testDebugUnitTest",
      "message": "[FAIL] core-storage-datastore"
    },
    {
      "code": "module_failed",
      "module": "core-storage-encryption",
      "task": ":core-storage-encryption:testDebugUnitTest",
      "message": "[FAIL] core-storage-encryption"
    },
    {
      "code": "module_failed",
      "module": "core-storage-mmkv",
      "task": ":core-storage-mmkv:testDebugUnitTest",
      "message": "[FAIL] core-storage-mmkv"
    },
    {
      "code": "module_failed",
      "module": "core-storage-secure",
      "task": ":core-storage-secure:testDebugUnitTest",
      "message": "[FAIL] core-storage-secure"
    },
    {
      "code": "module_failed",
      "module": "core-storage-settings",
      "task": ":core-storage-settings:testDebugUnitTest",
      "message": "[FAIL] core-storage-settings"
    },
    {
      "code": "module_failed",
      "module": "core-storage-sql",
      "task": ":core-storage-sql:testDebugUnitTest",
      "message": "[FAIL] core-storage-sql"
    },
    {
      "code": "module_failed",
      "module": "core-storage-sql-cipher",
      "task": ":core-storage-sql-cipher:testDebugUnitTest",
      "message": "[FAIL] core-storage-sql-cipher"
    },
    {
      "code": "module_failed",
      "module": "core-subscription",
      "task": ":core-subscription:testDebugUnitTest",
      "message": "[FAIL] core-subscription"
    },
    {
      "code": "module_failed",
      "module": "core-system",
      "task": ":core-system:testDebugUnitTest",
      "message": "[FAIL] core-system"
    },
    {
      "code": "module_failed",
      "module": "core-system-api",
      "task": ":core-system-api:testDebugUnitTest",
      "message": "[FAIL] core-system-api"
    },
    {
      "code": "module_failed",
      "module": "core-testing",
      "task": ":core-testing:testDebugUnitTest",
      "message": "[FAIL] core-testing"
    },
    {
      "code": "module_failed",
      "module": "core-version",
      "task": ":core-version:testDebugUnitTest",
      "message": "[FAIL] core-version"
    },
    {
      "code": "module_failed",
      "module": "benchmark-storage",
      "task": ":benchmark-storage:connectedAndroidDeviceTest",
      "message": "[FAIL] benchmark-storage"
    },
    {
      "code": "task_not_found",
      "message": "Cannot locate tasks that match ':benchmark-crypto:testDebugUnitTest' as task 'testDebugUnitTest' not found in project ':benchmark-crypto'."
    }
  ],
  "skipped": [
    {
      "module": "core-oauth-1a",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "core-oauth-browser",
      "reason": "no androidUnit target (--test-type=androidUnit)"
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
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "core-oauth-browser",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "detekt-rules-l1",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "konsist-guard",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
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
          "fresh": 11,
          "up_to_date": 0,
          "from_cache": 58,
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
          "up_to_date": 68,
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
          "no_evidence": 65
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
    "total": 10,
    "passed": 9,
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
      "module": "backend:service-import",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
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
          "no_source": 1,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "androidInstrumented",
        "exit_code": 0,
        "execution": {
          "fresh": 3,
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

### nav3-recipes — RED-orchestrator-cascade

Path: `C:/Users/34645/AndroidStudioProjects/OFFICIAL_PROJECTS/nav3-recipes`
Category: INTERESTING
Spawn exit: 1
Reason: cascade-isolation signature: legs [androidUnit] dispatched 1 tasks, gradle never mentioned any (no_evidence). Retry path from PR #116 didn't fire. 0 testcases ran in OTHER legs.

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
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "core:common",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "core:data",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "core:database",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "core:datastore",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "core:designsystem",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "core:domain",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "core:navigation",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "core:network",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "core:ui",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:bookmarks:impl",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:foryou:impl",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:interests:impl",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:search:impl",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:settings:impl",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:topic:impl",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "lint",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "sync:work",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
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

### WakeTheCave — RED-orchestrator-cascade

Path: `C:/Users/34645/AndroidStudioProjects/WakeTheCave/WakeTheCave`
Category: NEW
Spawn exit: 1
Reason: cascade-isolation signature: legs [common, desktop, androidUnit, androidInstrumented] dispatched 118 tasks, gradle never mentioned any (no_evidence). Retry path from PR #116 didn't fire. 0 testcases ran in OTHER legs.

Envelope excerpt:
```json
{
  "exit_code": 1,
  "tests": {
    "total": 118,
    "passed": 0,
    "failed": 118,
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
      "module": "core:auth:api",
      "task": ":core:auth:api:testDebugUnitTest",
      "message": "[FAIL] core:auth:api"
    },
    {
      "code": "module_failed",
      "module": "core:auth:impl",
      "task": ":core:auth:impl:testDebugUnitTest",
      "message": "[FAIL] core:auth:impl"
    },
    {
      "code": "module_failed",
      "module": "core:common",
      "task": ":core:common:testDebugUnitTest",
      "message": "[FAIL] core:common"
    },
    {
      "code": "module_failed",
      "module": "core:data",
      "task": ":core:data:testDebugUnitTest",
      "message": "[FAIL] core:data"
    },
    {
      "code": "module_failed",
      "module": "core:database",
      "task": ":core:database:testDebugUnitTest",
      "message": "[FAIL] core:database"
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
      "module": "core:logging",
      "task": ":core:logging:testDebugUnitTest",
      "message": "[FAIL] core:logging"
    },
    {
      "code": "module_failed",
      "module": "core:model",
      "task": ":core:model:testDebugUnitTest",
      "message": "[FAIL] core:model"
    },
    {
      "code": "module_failed",
      "module": "core:navigation",
      "task": ":core:navigation:testDebugUnitTest",
      "message": "[FAIL] core:navigation"
    },
    {
      "code": "module_failed",
      "module": "core:network",
      "task": ":core:network:testDebugUnitTest",
      "message": "[FAIL] core:network"
    },
    {
      "code": "module_failed",
      "module": "core:storage:api",
      "task": ":core:storage:api:testDebugUnitTest",
      "message": "[FAIL] core:storage:api"
    },
    {
      "code": "module_failed",
      "module": "core:storage:impl",
      "task": ":core:storage:impl:testDebugUnitTest",
      "message": "[FAIL] core:storage:impl"
    },
    {
      "code": "module_failed",
      "module": "core:testing",
      "task": ":core:testing:testDebugUnitTest",
      "message": "[FAIL] core:testing"
    },
    {
      "code": "module_failed",
      "module": "feature:auth",
      "task": ":feature:auth:testDebugUnitTest",
      "message": "[FAIL] feature:auth"
    },
    {
      "code": "module_failed",
      "module": "feature:auth-api",
      "task": ":feature:auth-api:testDebugUnitTest",
      "message": "[FAIL] feature:auth-api"
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
      "module": "feature:devices-api",
      "task": ":feature:devices-api:testDebugUnitTest",
      "message": "[FAIL] feature:devices-api"
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
      "module": "feature:onboarding-api",
      "task": ":feature:onboarding-api:testDebugUnitTest",
      "message": "[FAIL] feature:onboarding-api"
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
      "module": "feature:settings",
      "task": ":feature:settings:testDebugUnitTest",
      "message": "[FAIL] feature:settings"
    },
    {
      "code": "module_failed",
      "module": "feature:settings-api",
      "task": ":feature:settings-api:testDebugUnitTest",
      "message": "[FAIL] feature:settings-api"
    },
    {
      "code": "module_failed",
      "module": "integration:hue:data:impl",
      "task": ":integration:hue:data:impl:testDebugUnitTest",
      "message": "[FAIL] integration:hue:data:impl"
    },
    {
      "code": "module_failed",
      "module": "integration:wol:data:impl",
      "task": ":integration:wol:data:impl:testDebugUnitTest",
      "message": "[FAIL] integration:wol:data:impl"
    },
    {
      "code": "module_failed",
      "module": "androidApp",
      "task": ":androidApp:connectedDebugAndroidTest",
      "message": "[FAIL] androidApp"
    },
    {
      "code": "module_failed",
      "module": "core:auth:api",
      "task": ":core:auth:api:connectedDebugAndroidTest",
      "message": "[FAIL] core:auth:api"
    },
    {
      "code": "module_failed",
      "module": "core:auth:impl",
      "task": ":core:auth:impl:connectedDebugAndroidTest",
      "message": "[FAIL] core:auth:impl"
    },
    {
      "code": "module_failed",
      "module": "core:common",
      "task": ":core:common:connectedDebugAndroidTest",
      "message": "[FAIL] core:common"
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
      "module": "core:domain",
      "task": ":core:domain:connectedDebugAndroidTest",
      "message": "[FAIL] core:domain"
    },
    {
      "code": "module_failed",
      "module": "core:logging",
      "task": ":core:logging:connectedDebugAndroidTest",
      "message": "[FAIL] core:logging"
    },
    {
      "code": "module_failed",
      "module": "core:model",
      "task": ":core:model:connectedDebugAndroidTest",
      "message": "[FAIL] core:model"
    },
    {
      "code": "module_failed",
      "module": "core:navigation",
      "task": ":core:navigation:connectedDebugAndroidTest",
      "message": "[FAIL] core:navigation"
    },
    {
      "code": "module_failed",
      "module": "core:network",
      "task": ":core:network:connectedDebugAndroidTest",
      "message": "[FAIL] core:network"
    },
    {
      "code": "module_failed",
      "module": "core:storage:api",
      "task": ":core:storage:api:connectedDebugAndroidTest",
      "message": "[FAIL] core:storage:api"
    },
    {
      "code": "module_failed",
      "module": "core:storage:impl",
      "task": ":core:storage:impl:connectedDebugAndroidTest",
      "message": "[FAIL] core:storage:impl"
    },
    {
      "code": "module_failed",
      "module": "core:testing",
      "task": ":core:testing:connectedDebugAndroidTest",
      "message": "[FAIL] core:testing"
    },
    {
      "code": "module_failed",
      "module": "feature:auth",
      "task": ":feature:auth:connectedDebugAndroidTest",
      "message": "[FAIL] feature:auth"
    },
    {
      "code": "module_failed",
      "module": "feature:auth-api",
      "task": ":feature:auth-api:connectedDebugAndroidTest",
      "message": "[FAIL] feature:auth-api"
    },
    {
      "code": "module_failed",
      "module": "feature:common",
      "task": ":feature:common:connectedDebugAndroidTest",
      "message": "[FAIL] feature:common"
    },
    {
      "code": "module_failed",
      "module": "feature:devices",
      "task": ":feature:devices:connectedDebugAndroidTest",
      "message": "[FAIL] feature:devices"
    },
    {
      "code": "module_failed",
      "module": "feature:devices-api",
      "task": ":feature:devices-api:connectedDebugAndroidTest",
      "message": "[FAIL] feature:devices-api"
    },
    {
      "code": "module_failed",
      "module": "feature:home",
      "task": ":feature:home:connectedDebugAndroidTest",
      "message": "[FAIL] feature:home"
    },
    {
      "code": "module_failed",
      "module": "feature:home-api",
      "task": ":feature:home-api:connectedDebugAndroidTest",
      "message": "[FAIL] feature:home-api"
    },
    {
      "code": "module_failed",
      "module": "feature:onboarding",
      "task": ":feature:onboarding:connectedDebugAndroidTest",
      "message": "[FAIL] feature:onboarding"
    },
    {
      "code": "module_failed",
      "module": "feature:onboarding-api",
      "task": ":feature:onboarding-api:connectedDebugAndroidTest",
      "message": "[FAIL] feature:onboarding-api"
    },
    {
      "code": "module_failed",
      "module": "feature:presets",
      "task": ":feature:presets:connectedDebugAndroidTest",
      "message": "[FAIL] feature:presets"
    },
    {
      "code": "module_failed",
      "module": "feature:presets-api",
      "task": ":feature:presets-api:connectedDebugAndroidTest",
      "message": "[FAIL] feature:presets-api"
    },
    {
      "code": "module_failed",
      "module": "feature:settings",
      "task": ":feature:settings:connectedDebugAndroidTest",
      "message": "[FAIL] feature:settings"
    },
    {
      "code": "module_failed",
      "module": "feature:settings-api",
      "task": ":feature:settings-api:connectedDebugAndroidTest",
      "message": "[FAIL] feature:settings-api"
    },
    {
      "code": "module_failed",
      "module": "integration:hue:data:impl",
      "task": ":integration:hue:data:impl:connectedDebugAndroidTest",
      "message": "[FAIL] integration:hue:data:impl"
    },
    {
      "code": "module_failed",
      "module": "integration:wol:data:impl",
      "task": ":integration:wol:data:impl:connectedDebugAndroidTest",
      "message": "[FAIL] integration:wol:data:impl"
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
          "no_evidence": 30
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
          "no_evidence": 30
        }
      }
    ]
  }
}
```

### WakeTheCave_clean — RED-orchestrator-cascade

Path: `C:/Users/34645/AndroidStudioProjects/WakeTheCave/WakeTheCave_clean`
Category: NEW
Spawn exit: 1
Reason: cascade-isolation signature: legs [common, desktop, androidUnit, androidInstrumented] dispatched 90 tasks, gradle never mentioned any (no_evidence). Retry path from PR #116 didn't fire. 0 testcases ran in OTHER legs.

Envelope excerpt:
```json
{
  "exit_code": 1,
  "tests": {
    "total": 90,
    "passed": 0,
    "failed": 90,
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
      "module": "core:auth:api",
      "task": ":core:auth:api:testDebugUnitTest",
      "message": "[FAIL] core:auth:api"
    },
    {
      "code": "module_failed",
      "module": "core:auth:impl",
      "task": ":core:auth:impl:testDebugUnitTest",
      "message": "[FAIL] core:auth:impl"
    },
    {
      "code": "module_failed",
      "module": "core:common",
      "task": ":core:common:testDebugUnitTest",
      "message": "[FAIL] core:common"
    },
    {
      "code": "module_failed",
      "module": "core:data",
      "task": ":core:data:testDebugUnitTest",
      "message": "[FAIL] core:data"
    },
    {
      "code": "module_failed",
      "module": "core:database",
      "task": ":core:database:testDebugUnitTest",
      "message": "[FAIL] core:database"
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
      "module": "core:logging",
      "task": ":core:logging:testDebugUnitTest",
      "message": "[FAIL] core:logging"
    },
    {
      "code": "module_failed",
      "module": "core:model",
      "task": ":core:model:testDebugUnitTest",
      "message": "[FAIL] core:model"
    },
    {
      "code": "module_failed",
      "module": "core:navigation",
      "task": ":core:navigation:testDebugUnitTest",
      "message": "[FAIL] core:navigation"
    },
    {
      "code": "module_failed",
      "module": "core:network",
      "task": ":core:network:testDebugUnitTest",
      "message": "[FAIL] core:network"
    },
    {
      "code": "module_failed",
      "module": "core:storage:api",
      "task": ":core:storage:api:testDebugUnitTest",
      "message": "[FAIL] core:storage:api"
    },
    {
      "code": "module_failed",
      "module": "core:storage:impl",
      "task": ":core:storage:impl:testDebugUnitTest",
      "message": "[FAIL] core:storage:impl"
    },
    {
      "code": "module_failed",
      "module": "core:testing",
      "task": ":core:testing:testDebugUnitTest",
      "message": "[FAIL] core:testing"
    },
    {
      "code": "module_failed",
      "module": "feature:auth",
      "task": ":feature:auth:testDebugUnitTest",
      "message": "[FAIL] feature:auth"
    },
    {
      "code": "module_failed",
      "module": "feature:auth-api",
      "task": ":feature:auth-api:testDebugUnitTest",
      "message": "[FAIL] feature:auth-api"
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
      "module": "feature:devices-api",
      "task": ":feature:devices-api:testDebugUnitTest",
      "message": "[FAIL] feature:devices-api"
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
      "module": "feature:onboarding-api",
      "task": ":feature:onboarding-api:testDebugUnitTest",
      "message": "[FAIL] feature:onboarding-api"
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
      "module": "feature:settings",
      "task": ":feature:settings:testDebugUnitTest",
      "message": "[FAIL] feature:settings"
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
      "module": "core:auth:api",
      "task": ":core:auth:api:connectedDebugAndroidTest",
      "message": "[FAIL] core:auth:api"
    },
    {
      "code": "module_failed",
      "module": "core:auth:impl",
      "task": ":core:auth:impl:connectedDebugAndroidTest",
      "message": "[FAIL] core:auth:impl"
    },
    {
      "code": "module_failed",
      "module": "core:common",
      "task": ":core:common:connectedDebugAndroidTest",
      "message": "[FAIL] core:common"
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
      "module": "core:domain",
      "task": ":core:domain:connectedDebugAndroidTest",
      "message": "[FAIL] core:domain"
    },
    {
      "code": "module_failed",
      "module": "core:logging",
      "task": ":core:logging:connectedDebugAndroidTest",
      "message": "[FAIL] core:logging"
    },
    {
      "code": "module_failed",
      "module": "core:model",
      "task": ":core:model:connectedDebugAndroidTest",
      "message": "[FAIL] core:model"
    },
    {
      "code": "module_failed",
      "module": "core:navigation",
      "task": ":core:navigation:connectedDebugAndroidTest",
      "message": "[FAIL] core:navigation"
    },
    {
      "code": "module_failed",
      "module": "core:network",
      "task": ":core:network:connectedDebugAndroidTest",
      "message": "[FAIL] core:network"
    },
    {
      "code": "module_failed",
      "module": "core:storage:api",
      "task": ":core:storage:api:connectedDebugAndroidTest",
      "message": "[FAIL] core:storage:api"
    },
    {
      "code": "module_failed",
      "module": "core:storage:impl",
      "task": ":core:storage:impl:connectedDebugAndroidTest",
      "message": "[FAIL] core:storage:impl"
    },
    {
      "code": "module_failed",
      "module": "core:testing",
      "task": ":core:testing:connectedDebugAndroidTest",
      "message": "[FAIL] core:testing"
    },
    {
      "code": "module_failed",
      "module": "feature:auth",
      "task": ":feature:auth:connectedDebugAndroidTest",
      "message": "[FAIL] feature:auth"
    },
    {
      "code": "module_failed",
      "module": "feature:auth-api",
      "task": ":feature:auth-api:connectedDebugAndroidTest",
      "message": "[FAIL] feature:auth-api"
    },
    {
      "code": "module_failed",
      "module": "feature:common",
      "task": ":feature:common:connectedDebugAndroidTest",
      "message": "[FAIL] feature:common"
    },
    {
      "code": "module_failed",
      "module": "feature:devices",
      "task": ":feature:devices:connectedDebugAndroidTest",
      "message": "[FAIL] feature:devices"
    },
    {
      "code": "module_failed",
      "module": "feature:devices-api",
      "task": ":feature:devices-api:connectedDebugAndroidTest",
      "message": "[FAIL] feature:devices-api"
    },
    {
      "code": "module_failed",
      "module": "feature:home",
      "task": ":feature:home:connectedDebugAndroidTest",
      "message": "[FAIL] feature:home"
    },
    {
      "code": "module_failed",
      "module": "feature:home-api",
      "task": ":feature:home-api:connectedDebugAndroidTest",
      "message": "[FAIL] feature:home-api"
    },
    {
      "code": "module_failed",
      "module": "feature:onboarding",
      "task": ":feature:onboarding:connectedDebugAndroidTest",
      "message": "[FAIL] feature:onboarding"
    },
    {
      "code": "module_failed",
      "module": "feature:onboarding-api",
      "task": ":feature:onboarding-api:connectedDebugAndroidTest",
      "message": "[FAIL] feature:onboarding-api"
    },
    {
      "code": "module_failed",
      "module": "feature:presets",
      "task": ":feature:presets:connectedDebugAndroidTest",
      "message": "[FAIL] feature:presets"
    },
    {
      "code": "module_failed",
      "module": "feature:presets-api",
      "task": ":feature:presets-api:connectedDebugAndroidTest",
      "message": "[FAIL] feature:presets-api"
    },
    {
      "code": "module_failed",
      "module": "feature:settings",
      "task": ":feature:settings:connectedDebugAndroidTest",
      "message": "[FAIL] feature:settings"
    },
    {
      "code": "module_failed",
      "module": "feature:settings-api",
      "task": ":feature:settings-api:connectedDebugAndroidTest",
      "message": "[FAIL] feature:settings-api"
    },
    {
      "code": "module_failed",
      "module": "integration:hue:data:api",
      "task": ":integration:hue:data:api:connectedDebugAndroidTest",
      "message": "[FAIL] integration:hue:data:api"
    },
    {
      "code": "module_failed",
      "module": "integration:hue:data:impl",
      "task": ":integration:hue:data:impl:connectedDebugAndroidTest",
      "message": "[FAIL] integration:hue:data:impl"
    },
    {
      "code": "module_failed",
      "module": "integration:hue:ui:impl",
      "task": ":integration:hue:ui:impl:connectedDebugAndroidTest",
      "message": "[FAIL] integration:hue:ui:impl"
    },
    {
      "code": "module_failed",
      "module": "integration:wol:data:api",
      "task": ":integration:wol:data:api:connectedDebugAndroidTest",
      "message": "[FAIL] integration:wol:data:api"
    },
    {
      "code": "module_failed",
      "module": "integration:wol:data:impl",
      "task": ":integration:wol:data:impl:connectedDebugAndroidTest",
      "message": "[FAIL] integration:wol:data:impl"
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
          "no_evidence": 33
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
          "no_evidence": 33
        }
      }
    ]
  }
}
```

### WakeTheCave_ref — RED-orchestrator-cascade

Path: `C:/Users/34645/AndroidStudioProjects/WakeTheCave/WakeTheCave_ref`
Category: NEW
Spawn exit: 3
Reason: cascade-isolation signature: legs [androidUnit, androidInstrumented] dispatched 38 tasks, gradle never mentioned any (no_evidence). Retry path from PR #116 didn't fire. 0 testcases ran in OTHER legs.

Envelope excerpt:
```json
{
  "exit_code": 3,
  "tests": {
    "total": 38,
    "passed": 0,
    "failed": 38,
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
      "module": "core:auth:api",
      "task": ":core:auth:api:testDebugUnitTest",
      "message": "[FAIL] core:auth:api"
    },
    {
      "code": "module_failed",
      "module": "core:auth:impl",
      "task": ":core:auth:impl:testDebugUnitTest",
      "message": "[FAIL] core:auth:impl"
    },
    {
      "code": "module_failed",
      "module": "core:data",
      "task": ":core:data:testDebugUnitTest",
      "message": "[FAIL] core:data"
    },
    {
      "code": "module_failed",
      "module": "core:database",
      "task": ":core:database:testDebugUnitTest",
      "message": "[FAIL] core:database"
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
      "module": "core:logging",
      "task": ":core:logging:testDebugUnitTest",
      "message": "[FAIL] core:logging"
    },
    {
      "code": "module_failed",
      "module": "core:model",
      "task": ":core:model:testDebugUnitTest",
      "message": "[FAIL] core:model"
    },
    {
      "code": "module_failed",
      "module": "core:navigation",
      "task": ":core:navigation:testDebugUnitTest",
      "message": "[FAIL] core:navigation"
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
      "module": "core:testing",
      "task": ":core:testing:testDebugUnitTest",
      "message": "[FAIL] core:testing"
    },
    {
      "code": "module_failed",
      "module": "feature:auth",
      "task": ":feature:auth:testDebugUnitTest",
      "message": "[FAIL] feature:auth"
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
      "module": "core:auth:api",
      "task": ":core:auth:api:connectedDebugAndroidTest",
      "message": "[FAIL] core:auth:api"
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
      "module": "core:domain",
      "task": ":core:domain:connectedDebugAndroidTest",
      "message": "[FAIL] core:domain"
    },
    {
      "code": "module_failed",
      "module": "core:logging",
      "task": ":core:logging:connectedDebugAndroidTest",
      "message": "[FAIL] core:logging"
    },
    {
      "code": "module_failed",
      "module": "core:model",
      "task": ":core:model:connectedDebugAndroidTest",
      "message": "[FAIL] core:model"
    },
    {
      "code": "module_failed",
      "module": "core:navigation",
      "task": ":core:navigation:connectedDebugAndroidTest",
      "message": "[FAIL] core:navigation"
    },
    {
      "code": "module_failed",
      "module": "core:network",
      "task": ":core:network:connectedDebugAndroidTest",
      "message": "[FAIL] core:network"
    },
    {
      "code": "module_failed",
      "module": "core:storage:impl",
      "task": ":core:storage:impl:connectedDebugAndroidTest",
      "message": "[FAIL] core:storage:impl"
    },
    {
      "code": "module_failed",
      "module": "core:testing",
      "task": ":core:testing:connectedDebugAndroidTest",
      "message": "[FAIL] core:testing"
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
      "module": "feature:home",
      "task": ":feature:home:connectedDebugAndroidTest",
      "message": "[FAIL] feature:home"
    },
    {
      "code": "module_failed",
      "module": "feature:onboarding",
      "task": ":feature:onboarding:connectedDebugAndroidTest",
      "message": "[FAIL] feature:onboarding"
    },
    {
      "code": "module_failed",
      "module": "feature:presets",
      "task": ":feature:presets:connectedDebugAndroidTest",
      "message": "[FAIL] feature:presets"
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
          "no_evidence": 19
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
          "no_evidence": 19
        }
      }
    ]
  }
}
```

### FileKit-main — RED-orchestrator-cascade

Path: `C:/Users/34645/AndroidStudioProjects/Nueva carpeta/FileKit-main/FileKit-main`
Category: NEW
Spawn exit: 1
Reason: cascade-isolation signature: legs [androidUnit, androidInstrumented] dispatched 4 tasks, gradle never mentioned any (no_evidence). Retry path from PR #116 didn't fire. 56 testcases ran in OTHER legs.

Envelope excerpt:
```json
{
  "exit_code": 1,
  "tests": {
    "total": 8,
    "passed": 4,
    "failed": 4,
    "skipped": 0,
    "individual_total": 56
  },
  "errors": [
    {
      "code": "module_failed",
      "module": "filekit-dialogs",
      "task": ":filekit-dialogs:testDebugUnitTest",
      "message": "[FAIL] filekit-dialogs"
    },
    {
      "code": "module_failed",
      "module": "sample:shared",
      "task": ":sample:shared:testDebugUnitTest",
      "message": "[FAIL] sample:shared"
    },
    {
      "code": "module_failed",
      "module": "filekit-dialogs",
      "task": ":filekit-dialogs:connectedDebugAndroidTest",
      "message": "[FAIL] filekit-dialogs"
    },
    {
      "code": "module_failed",
      "module": "sample:shared",
      "task": ":sample:shared:connectedDebugAndroidTest",
      "message": "[FAIL] sample:shared"
    },
    {
      "code": "task_not_found",
      "message": "Cannot locate tasks that match ':filekit-dialogs:testDebugUnitTest' as task 'testDebugUnitTest' not found in project ':filekit-dialogs'."
    }
  ],
  "skipped": [
    {
      "module": "filekit-coil",
      "reason": "no test source set"
    },
    {
      "module": "filekit-dialogs-compose",
      "reason": "no test source set"
    },
    {
      "module": "sample:androidApp",
      "reason": "no test source set"
    },
    {
      "module": "sample:desktopApp",
      "reason": "no test source set"
    },
    {
      "module": "sample:webApp",
      "reason": "no test source set"
    },
    {
      "module": "sample:shared",
      "reason": "no common target (--test-type=common)"
    },
    {
      "module": "sample:shared",
      "reason": "no desktop target (--test-type=desktop)"
    },
    {
      "module": "filekit-core",
      "reason": "no androidUnit target (--test-type=androidUnit)"
    },
    {
      "module": "filekit-core",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
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
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 0,
          "failed": 0,
          "no_evidence": 2
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
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:camera",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:creation",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:home",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "feature:results",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
    },
    {
      "module": "watchface",
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
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
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
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
      "reason": "no androidInstrumented target (--test-type=androidInstrumented)"
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
Reason: module_failed discriminator (2 module(s), 24 testcases ran)

Envelope excerpt:
```json
{
  "exit_code": 1,
  "tests": {
    "total": 8,
    "passed": 6,
    "failed": 2,
    "skipped": 0,
    "individual_total": 24
  },
  "errors": [
    {
      "code": "module_failed",
      "module": "common",
      "task": ":common:testDebugUnitTest",
      "message": "[FAIL] common"
    },
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
        "exit_code": 1,
        "execution": {
          "fresh": 1,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 2,
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

## Retrospective vs PR3 sweep

PR3 listed 8 projects with preflightJdkCheck status. Re-validating each post-PR3:

| Project | PR3 expectation | PR4 result | Notes |
|---|---|---|---|
| android-challenge | JDK auto-select fires | GREEN | see `.smoke/pass-7/android-challenge.err` |
| DawSync | JDK auto-select fires | RED-orchestrator-cascade | see `.smoke/pass-7/DawSync.err` |
| dipatternsdemo | JDK auto-select fires | RED-orchestrator-cascade | see `.smoke/pass-7/dipatternsdemo.err` |
| dokka-markdown-plugin | JDK auto-select fires | SKIP | see `.smoke/pass-7/dokka-markdown-plugin.err` |
| gyg | JDK auto-select fires | RED-repo | see `.smoke/pass-7/gyg.err` |
| OmniSound | JDK auto-select fires | RED-orchestrator-cascade | see `.smoke/pass-7/OmniSound.err` |
| shared-kmp-libs | JDK auto-select fires | RED-repo | see `.smoke/pass-7/shared-kmp-libs.err` |
| TaskFlow | JDK auto-select fires | GREEN | see `.smoke/pass-7/TaskFlow.err` |

## Per-project artifacts

Forensic captures live in `.smoke/pass-7/` (gitignored — `.gitignore:22`):

- `<safe-name>.out` — stdout (envelope between sentinel markers)
- `<safe-name>.err` — stderr (orchestrator log + gradle stderr)
- `<safe-name>.json` — extracted JSON envelope (only when emitted)
