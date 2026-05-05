# Wide-smoke pass-9 (mac) — `--test-type all`

Generated: 2026-05-04T19:59:47.361Z

Test type: `all`
Workspace: `/Volumes/XcodeOscar/kmp-test-workspace`
Orchestrator HEAD: `0cd5432`

Goal: Mac-side parity check vs Windows pass-8 baseline (PR #129 sweep). The 4 Mac-reproducible projects must match their Windows-side bucket (or improve via the fix-PR-A/D/B/C cumulative). Any flip from `GREEN/SKIP → RED-orchestrator*` blocks v0.8.0.

## Bucket counts

| Bucket | Count |
|---|---|
| GREEN | 0 |
| SKIP | 0 |
| RED-repo | 1 |
| RED-orchestrator-cascade | 0 |
| RED-orchestrator | 0 |
| MISSING | 0 |
| **Total** | **1** |

## Summary table

| Project | Category | Bucket | Duration | Exit | Discriminators | Notes |
|---|---|---|---|---|---|---|
| shared-kmp-libs | PR3 | RED-repo | 6m 45s | 1 | module_failed×2 | module_failed discriminator (2 module(s), 13192 testcases ran) |

## Mac↔Win parity (vs Windows pass-8 baseline)

| Project | Win name (pass-8) | Win bucket | Mac bucket | Δ |
|---|---|---|---|---|
| shared-kmp-libs | shared-kmp-libs | RED-repo | RED-repo | ✓ |

## Per-project envelopes (non-GREEN)

### shared-kmp-libs — RED-repo

Path: `/Volumes/XcodeOscar/kmp-test-workspace/shared-kmp-libs`
Category: PR3
Spawn exit: 1
Reason: module_failed discriminator (2 module(s), 13192 testcases ran)

Envelope excerpt:
```json
{
  "exit_code": 1,
  "tests": {
    "total": 323,
    "passed": 321,
    "failed": 2,
    "skipped": 0,
    "individual_total": 13192
  },
  "errors": [
    {
      "code": "module_failed",
      "module": "benchmark-storage",
      "task": ":benchmark-storage:connectedAndroidDeviceTest",
      "message": "[FAIL] benchmark-storage"
    },
    {
      "code": "module_failed",
      "module": "benchmark-storage",
      "task": ":benchmark-storage:macosArm64Test",
      "message": "[FAIL] benchmark-storage"
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
    },
    {
      "module": "benchmark-crypto",
      "reason": "no ios target (--test-type=ios)"
    },
    {
      "module": "benchmark-io",
      "reason": "no ios target (--test-type=ios)"
    },
    {
      "module": "benchmark-network",
      "reason": "no ios target (--test-type=ios)"
    },
    {
      "module": "benchmark-sdk",
      "reason": "no ios target (--test-type=ios)"
    },
    {
      "module": "benchmark-storage",
      "reason": "no ios target (--test-type=ios)"
    },
    {
      "module": "core-firebase-native",
      "reason": "no ios target (--test-type=ios)"
    },
    {
      "module": "core-network-retrofit",
      "reason": "no ios target (--test-type=ios)"
    },
    {
      "module": "core-oauth-1a",
      "reason": "no ios target (--test-type=ios)"
    },
    {
      "module": "core-oauth-browser",
      "reason": "no ios target (--test-type=ios)"
    },
    {
      "module": "detekt-rules-l1",
      "reason": "no ios target (--test-type=ios)"
    },
    {
      "module": "konsist-guard",
      "reason": "no ios target (--test-type=ios)"
    },
    {
      "module": "core-firebase-native",
      "reason": "no macos target (--test-type=macos)"
    },
    {
      "module": "core-network-retrofit",
      "reason": "no macos target (--test-type=macos)"
    },
    {
      "module": "core-oauth-1a",
      "reason": "no macos target (--test-type=macos)"
    },
    {
      "module": "core-oauth-browser",
      "reason": "no macos target (--test-type=macos)"
    },
    {
      "module": "core-oauth-native",
      "reason": "no macos target (--test-type=macos)"
    },
    {
      "module": "detekt-rules-l1",
      "reason": "no macos target (--test-type=macos)"
    },
    {
      "module": "konsist-guard",
      "reason": "no macos target (--test-type=macos)"
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
    "max_workers": 1,
    "timeout_s": 1500,
    "legs": [
      {
        "test_type": "common",
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
      },
      {
        "test_type": "ios",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 53,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 5,
          "failed": 0,
          "no_evidence": 0
        }
      },
      {
        "test_type": "macos",
        "exit_code": 1,
        "execution": {
          "fresh": 1,
          "up_to_date": 54,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 7,
          "failed": 0,
          "no_evidence": 0
        }
      }
    ]
  }
}
```

## Per-project artifacts

Forensic captures live in `.smoke/pass-9-mac-all/` (gitignored — same `.smoke/` rule as pass-7/8/9):

- `<safe-name>.out` — stdout (envelope between sentinel markers)
- `<safe-name>.err` — stderr (orchestrator log + gradle stderr)
- `<safe-name>.json` — extracted JSON envelope (only when emitted)
- `<safe-name>.meta.json` — run metadata for `--reclassify`
