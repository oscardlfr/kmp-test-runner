#!/usr/bin/env bash
# audit-append.sh — Zero-overhead audit log append helper.
#
# Usage:
#   source "$SCRIPT_DIR/lib/audit-append.sh"
#   audit_append "$PROJECT_ROOT" "coverage" "pass" \
#     '"coverage_pct":84.2,"modules_total":7,"modules_passed":7,"modules_at_100":3,"missed_lines":142,"duration_s":187'
#
# The audit log lives at: <project>/.androidcommondoc/audit-log.jsonl
# Recommended .gitattributes: .androidcommondoc/audit-log.jsonl merge=union
#
# This function is intentionally minimal — one echo, no subshells, no pipes.
# The agent NEVER reads this file; only the MCP audit-report tool aggregates it.

audit_append() {
    local project_root="$1"
    local event="$2"
    local result="$3"      # pass | warn | fail
    local extra_fields="$4" # pre-formatted JSON fields, no surrounding braces

    local audit_dir="$project_root/.androidcommondoc"
    local log_file="$audit_dir/audit-log.jsonl"

    mkdir -p "$audit_dir" 2>/dev/null || return 0

    local ts
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "unknown")"

    local branch=""
    branch="$(git -C "$project_root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"

    local commit=""
    commit="$(git -C "$project_root" rev-parse --short HEAD 2>/dev/null || echo "")"

    local project_name
    project_name="$(basename "$project_root")"

    # Detect layer from l0-manifest.json if present
    local layer=""
    if [[ -f "$project_root/l0-manifest.json" ]]; then
        layer="$(python3 -c "import json,sys; d=json.load(open('$project_root/l0-manifest.json')); print(d.get('layer',''))" 2>/dev/null || echo "")"
    fi

    local line='{"ts":"'"$ts"'","event":"'"$event"'","result":"'"$result"'","project":"'"$project_name"'","layer":"'"$layer"'","branch":"'"$branch"'","commit":"'"$commit"'"'
    if [[ -n "$extra_fields" ]]; then
        line="${line},${extra_fields}"
    fi
    line="${line}}"

    echo "$line" >> "$log_file"
}
