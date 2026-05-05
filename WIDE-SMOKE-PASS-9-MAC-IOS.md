# Wide-smoke pass-9 (mac) — `--test-type ios`

Generated: 2026-05-05T12:00:58.115Z

Test type: `ios`
Workspace: `/Volumes/XcodeOscar/kmp-test-workspace`
Orchestrator HEAD: `89e3cba`

Goal: validate `iosSimulatorArm64Test` dispatch + iOS Simulator boot orchestration on real macOS hardware. Windows cannot exercise this codepath.

## Bucket counts

| Bucket | Count |
|---|---|
| GREEN | 3 |
| SKIP | 1 |
| RED-repo | 0 |
| RED-orchestrator-cascade | 0 |
| RED-orchestrator | 0 |
| MISSING | 0 |
| **Total** | **4** |

## Summary table

| Project | Category | Bucket | Duration | Exit | Discriminators | Notes |
|---|---|---|---|---|---|---|
| Confetti | INTERESTING | SKIP | 23s | 0 | – | exit 0, no testcases (skip reasons: no test source set \| no ios target (--test-type=ios)) |
| KaMPKit | NEW | GREEN | 16s | 0 | – | 24 testcases ran |
| PeopleInSpace | NEW | GREEN | 12s | 0 | – | 8 testcases ran |
| shared-kmp-libs | PR3 | GREEN | 14s | 0 | – | 2720 testcases ran |

## Per-project envelopes (non-GREEN)

### Confetti — SKIP

Path: `/Volumes/XcodeOscar/kmp-test-workspace/Confetti`
Category: INTERESTING
Spawn exit: 0
Reason: exit 0, no testcases (skip reasons: no test source set | no ios target (--test-type=ios))

Envelope excerpt:
```json
{
  "exit_code": 0,
  "tests": {
    "total": 1,
    "passed": 1,
    "failed": 0,
    "skipped": 0,
    "individual_total": 0
  },
  "errors": [],
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
      "reason": "no ios target (--test-type=ios)"
    },
    {
      "module": "backend:service-import",
      "reason": "no ios target (--test-type=ios)"
    },
    {
      "module": "wearApp",
      "reason": "no ios target (--test-type=ios)"
    }
  ],
  "warnings": [],
  "parallel": {
    "test_type": "ios",
    "max_workers": 1,
    "timeout_s": 900,
    "legs": [
      {
        "test_type": "ios",
        "exit_code": 0,
        "execution": {
          "fresh": 0,
          "up_to_date": 0,
          "from_cache": 0,
          "no_source": 0,
          "skipped_by_gradle": 1,
          "failed": 0,
          "no_evidence": 0
        }
      }
    ]
  }
}
```

## Per-project artifacts

Forensic captures live in `.smoke/pass-9-mac-ios/` (gitignored — same `.smoke/` rule as pass-7/8/9):

- `<safe-name>.out` — stdout (envelope between sentinel markers)
- `<safe-name>.err` — stderr (orchestrator log + gradle stderr)
- `<safe-name>.json` — extracted JSON envelope (only when emitted)
- `<safe-name>.meta.json` — run metadata for `--reclassify`
