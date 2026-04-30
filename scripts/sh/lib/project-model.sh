#!/usr/bin/env bash
# =============================================================================
# project-model.sh — bash readers over the ProjectModel JSON (v0.5.1 Phase 4).
#
# Source this file and call:
#   pm_get_jdk_requirement "$PROJECT_ROOT"
#   pm_get_unit_test_task "$PROJECT_ROOT" "$module_name"
#   pm_get_device_test_task "$PROJECT_ROOT" "$module_name"
#   pm_get_coverage_task "$PROJECT_ROOT" "$module_name"
#   pm_module_type "$PROJECT_ROOT" "$module_name"
#   pm_module_has_tests "$PROJECT_ROOT" "$module_name"
#
# Each reader echoes the requested value and exits 0. If the model JSON is
# absent or unreadable, it echoes an empty string and exits 0 — the caller
# falls back to its existing legacy detection. NEVER returns nonzero on
# legitimate "model missing" — fail-soft is the contract.
#
# Model layout: <project>/.kmp-test-runner-cache/model-<sha>.json (sha is the
# same content-keyed SHA1 used by gradle-tasks-probe.sh).
#
# Parser: python3 (universal availability across CI runners + local dev). jq
# is optional — not all environments have it, python3 ships everywhere.
# =============================================================================

# Sourced helpers — gradle-tasks-probe owns the cache-key algorithm and we
# reuse it verbatim here so model and probe agree on the current SHA.
_pm_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./gradle-tasks-probe.sh
source "$_pm_lib_dir/gradle-tasks-probe.sh"

# Internal: locate the model file for the current project state. Echoes the
# absolute path on success; echoes nothing + returns 1 when the model file
# does not exist for the current cacheKey.
_pm_locate_model_file() {
    local project_root="$1"
    [[ -z "$project_root" || ! -d "$project_root" ]] && return 1
    local cache_key
    cache_key="$(_kmp_compute_cache_key "$project_root" 2>/dev/null)" || return 1
    [[ -z "$cache_key" ]] && return 1
    local model_file="$project_root/.kmp-test-runner-cache/model-${cache_key}.json"
    [[ -s "$model_file" ]] || return 1
    echo "$model_file"
    return 0
}

# Internal: extract a JSON value via python3. The python script reads the
# model file path (argv[1]) and a fetcher token (argv[2]) plus optional
# per-fetcher args (argv[3+]). Bash quoting is irrelevant — every argv slot
# is passed to python verbatim. Echoes the resolved value (empty on failure).
#   _pm_json_get <model_file> <fetcher> [args...]
_pm_json_get() {
    local model_file="$1"
    shift
    [[ -s "$model_file" ]] || return 1
    command -v python3 >/dev/null 2>&1 || return 1
    python3 - "$model_file" "$@" <<'PY' 2>/dev/null
import json, sys
try:
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        data = json.load(f)
except Exception:
    sys.exit(0)
fetcher = sys.argv[2] if len(sys.argv) > 2 else ''
args = sys.argv[3:]
out = None
try:
    if fetcher == 'jdk_min':
        out = data.get('jdkRequirement', {}).get('min')
    elif fetcher == 'module_field':
        # args = [module, field1, field2, ...]
        node = data.get('modules', {}).get(args[0])
        if node is None:
            sys.exit(0)
        for k in args[1:]:
            node = node.get(k) if isinstance(node, dict) else None
            if node is None:
                sys.exit(0)
        out = node
    elif fetcher == 'module_has_tests':
        node = data.get('modules', {}).get(args[0], {}).get('sourceSets', {})
        if not isinstance(node, dict):
            sys.exit(0)
        out = 'true' if any(bool(v) for v in node.values()) else 'false'
except Exception:
    sys.exit(0)
if out is None:
    sys.exit(0)
if isinstance(out, bool):
    print('true' if out else 'false')
else:
    print(out)
PY
}

# Normalize a module name to the `:foo` form used as a key in model.modules.
_pm_norm_module() {
    local m="$1"
    [[ "$m" != :* ]] && m=":${m}"
    echo "$m"
}

# Public: echo the project's required JDK major version (the `min` field of
# jdkRequirement, which is actually the MAX of all signals — strictest
# requirement). Empty when no signal detected or model missing.
pm_get_jdk_requirement() {
    local project_root="$1"
    local model_file
    model_file="$(_pm_locate_model_file "$project_root")" || { echo ""; return 0; }
    _pm_json_get "$model_file" jdk_min
}

# Public: echo the resolved unit test task for a module. Module name may be
# given as `:foo` or `foo` — both work. Empty when model is missing or no
# candidate matched.
pm_get_unit_test_task() {
    local project_root="$1"
    local module
    module="$(_pm_norm_module "$2")"
    local model_file
    model_file="$(_pm_locate_model_file "$project_root")" || { echo ""; return 0; }
    _pm_json_get "$model_file" module_field "$module" resolved unitTestTask
}

# Public: echo the resolved device-test task (e.g. androidConnectedCheck) for
# a module. Empty when model missing or candidate not in probe cache.
pm_get_device_test_task() {
    local project_root="$1"
    local module
    module="$(_pm_norm_module "$2")"
    local model_file
    model_file="$(_pm_locate_model_file "$project_root")" || { echo ""; return 0; }
    _pm_json_get "$model_file" module_field "$module" resolved deviceTestTask
}

# Public: echo the resolved coverage task (e.g. koverXmlReport,
# jacocoTestReport) for a module. Empty when model missing or no plugin
# applied per-module.
pm_get_coverage_task() {
    local project_root="$1"
    local module
    module="$(_pm_norm_module "$2")"
    local model_file
    model_file="$(_pm_locate_model_file "$project_root")" || { echo ""; return 0; }
    _pm_json_get "$model_file" module_field "$module" resolved coverageTask
}

# Public: echo the resolved web (JS / Wasm) test task for a module — usually
# `jsTest` or `wasmJsTest` (v0.6 Bug 3). Empty when the module has no
# JS/Wasm targets, when the model is missing, or when the probe didn't see
# the candidate task. Parallel to `pm_get_device_test_task` for Android —
# scripts opt in by reading this when they want web-side test invocation.
pm_get_web_test_task() {
    local project_root="$1"
    local module
    module="$(_pm_norm_module "$2")"
    local model_file
    model_file="$(_pm_locate_model_file "$project_root")" || { echo ""; return 0; }
    _pm_json_get "$model_file" module_field "$module" resolved webTestTask
}

# Public: echo the module type (`kmp` | `android` | `jvm` | `unknown`).
# Empty when model is missing.
pm_module_type() {
    local project_root="$1"
    local module
    module="$(_pm_norm_module "$2")"
    local model_file
    model_file="$(_pm_locate_model_file "$project_root")" || { echo ""; return 0; }
    _pm_json_get "$model_file" module_field "$module" type
}

# Public: echo `true` / `false` based on whether the module has at least one
# test source set (any of the 9 standard test directories under src/). Empty
# when model is missing.
pm_module_has_tests() {
    local project_root="$1"
    local module
    module="$(_pm_norm_module "$2")"
    local model_file
    model_file="$(_pm_locate_model_file "$project_root")" || { echo ""; return 0; }
    _pm_json_get "$model_file" module_has_tests "$module"
}
