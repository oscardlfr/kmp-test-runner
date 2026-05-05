# Wide-smoke pass-9 (mac) — `--test-type macos`

Generated: 2026-05-05T12:00:58.221Z

Test type: `macos`
Workspace: `/Volumes/XcodeOscar/kmp-test-workspace`
Orchestrator HEAD: `89e3cba`

Goal: validate `macosArm64Test` per-module dispatch + envelope shape on real macOS hardware. Windows cannot exercise this codepath.

## Bucket counts

| Bucket | Count |
|---|---|
| GREEN | 0 |
| SKIP | 3 |
| RED-repo | 1 |
| RED-orchestrator-cascade | 0 |
| RED-orchestrator | 0 |
| MISSING | 0 |
| **Total** | **4** |

## Summary table

| Project | Category | Bucket | Duration | Exit | Discriminators | Notes |
|---|---|---|---|---|---|---|
| Confetti | INTERESTING | SKIP | 1s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| KaMPKit | NEW | SKIP | 0s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| PeopleInSpace | NEW | SKIP | 0s | 3 | no_test_modules | all errors are no_test_modules (legitimately empty) |
| shared-kmp-libs | PR3 | RED-repo | 3m 30s | 1 | module_failed | module_failed discriminator (1 module(s), 2722 testcases ran) |

## Per-project envelopes (non-GREEN)

### Confetti — SKIP

Path: `/Volumes/XcodeOscar/kmp-test-workspace/Confetti`
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
      "message": "No modules support the requested --test-type=macos",
      "test_type": "macos"
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
      "reason": "no macos target (--test-type=macos)"
    },
    {
      "module": "backend:service-import",
      "reason": "no macos target (--test-type=macos)"
    },
    {
      "module": "shared",
      "reason": "no macos target (--test-type=macos)"
    },
    {
      "module": "wearApp",
      "reason": "no macos target (--test-type=macos)"
    }
  ],
  "warnings": [],
  "parallel": {
    "test_type": "macos",
    "max_workers": 1,
    "timeout_s": 900,
    "legs": [
      {
        "test_type": "macos",
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

### KaMPKit — SKIP

Path: `/Volumes/XcodeOscar/kmp-test-workspace/KaMPKit`
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
      "message": "No modules support the requested --test-type=macos",
      "test_type": "macos"
    }
  ],
  "skipped": [
    {
      "module": "app",
      "reason": "no test source set"
    },
    {
      "module": "shared",
      "reason": "no macos target (--test-type=macos)"
    }
  ],
  "warnings": [],
  "parallel": {
    "test_type": "macos",
    "max_workers": 1,
    "timeout_s": 900,
    "legs": [
      {
        "test_type": "macos",
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

### PeopleInSpace — SKIP

Path: `/Volumes/XcodeOscar/kmp-test-workspace/PeopleInSpace`
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
      "message": "No modules support the requested --test-type=macos",
      "test_type": "macos"
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
      "reason": "no macos target (--test-type=macos)"
    },
    {
      "module": "common",
      "reason": "no macos target (--test-type=macos)"
    },
    {
      "module": "wearApp",
      "reason": "no macos target (--test-type=macos)"
    }
  ],
  "warnings": [],
  "parallel": {
    "test_type": "macos",
    "max_workers": 1,
    "timeout_s": 900,
    "legs": [
      {
        "test_type": "macos",
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

Path: `/Volumes/XcodeOscar/kmp-test-workspace/shared-kmp-libs`
Category: PR3
Spawn exit: 1
Reason: module_failed discriminator (1 module(s), 2722 testcases ran)

Envelope excerpt:
```json
{
  "exit_code": 1,
  "tests": {
    "total": 62,
    "passed": 61,
    "failed": 1,
    "skipped": 0,
    "individual_total": 2722
  },
  "errors": [
    {
      "code": "module_failed",
      "module": "benchmark-storage",
      "task": ":benchmark-storage:macosArm64Test",
      "message": "[FAIL] benchmark-storage"
    }
  ],
  "skipped": [
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
  "warnings": [],
  "parallel": {
    "test_type": "macos",
    "max_workers": 1,
    "timeout_s": 900,
    "legs": [
      {
        "test_type": "macos",
        "exit_code": 1,
        "execution": {
          "fresh": 0,
          "up_to_date": 54,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 7,
          "failed": 1,
          "no_evidence": 0
        }
      }
    ]
  }
}
```

## Per-project artifacts

Forensic captures live in `.smoke/pass-9-mac-macos/` (gitignored — same `.smoke/` rule as pass-7/8/9):

- `<safe-name>.out` — stdout (envelope between sentinel markers)
- `<safe-name>.err` — stderr (orchestrator log + gradle stderr)
- `<safe-name>.json` — extracted JSON envelope (only when emitted)
- `<safe-name>.meta.json` — run metadata for `--reclassify`
