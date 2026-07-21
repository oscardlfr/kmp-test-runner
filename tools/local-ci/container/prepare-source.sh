#!/usr/bin/env bash
set -euo pipefail

prepare_source() {
    local source_archive="${KMP_LOCAL_CI_ARCHIVE:-/source.tar}"
    local source_bundle="${KMP_LOCAL_CI_BUNDLE:-/source.bundle}"
    local staging_root="${KMP_LOCAL_CI_STAGING:-/tmp/kmp-local-ci-source}"
    local work_root="${KMP_LOCAL_CI_WORK:-/workspace}"

    if [[ ! -s "${source_archive}" ]]; then
        echo "[local-ci] source archive not found or empty: ${source_archive}" >&2
        return 2
    fi
    if [[ ! -s "${source_bundle}" ]]; then
        echo "[local-ci] source bundle not found or empty: ${source_bundle}" >&2
        return 2
    fi

    rm -rf "${staging_root}" "${work_root}"
    git clone -q "${source_bundle}" "${staging_root}"
    find "${staging_root}" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +

    # The checkout and Git-derived manifest are mounted read-only. Copy only those files into
    # an ephemeral directory so test writes cannot mutate the host and ignored local evidence
    # never enters the container.
    tar -C "${staging_root}" --no-same-owner -xf "${source_archive}"

    if [[ ! -f "${staging_root}/package.json" ]]; then
        echo "[local-ci] package.json missing from source archive" >&2
        return 2
    fi

    # DrvFs reports broad executable bits and a Windows checkout may contain CRLF. Re-indexing
    # with autocrlf=input creates canonical blobs; cloning them on Linux reapplies eol attributes
    # exactly as a hosted Linux checkout would.
    #
    # This shebang-sniff intentionally IGNORES the real git-tracked mode -- it derives its own,
    # then the git add -A below re-stages from THAT, overwriting whatever the source repo actually
    # had committed. A tool that wants to verify the TRUE tracked executable bit (e.g.
    # tools/check-executable-fixtures.mjs) must run against a real checkout (windows-gate.ps1, or
    # CI's own actions/checkout) -- running it in THIS container after this point would always see
    # the heuristic's own correction, never the bug it exists to catch.
    find "${staging_root}" -type f -exec chmod 0644 {} +
    while IFS= read -r -d '' file; do
        if [[ "$(head -c 2 "${file}")" == '#!' ]]; then
            chmod 0755 "${file}"
        fi
    done < <(find "${staging_root}" -type f -print0)

    git -C "${staging_root}" config user.name "kmp local ci"
    git -C "${staging_root}" config user.email "local-ci@example.invalid"
    git -C "${staging_root}" config core.autocrlf input
    git -C "${staging_root}" add -A
    git -C "${staging_root}" commit --allow-empty -qm "test: local ci snapshot"

    git clone -q --no-hardlinks "${staging_root}" "${work_root}"
    git -C "${work_root}" remote remove origin
    git -C "${work_root}" remote add origin https://github.com/oscardlfr/kmp-test-runner.git

    export KMP_LOCAL_CI_WORK_ROOT="${work_root}"
}
