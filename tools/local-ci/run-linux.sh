#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
tooling_root="$(cd -- "${script_dir}/../.." && pwd)"
source_root="${1:-${tooling_root}}"
lane="${2:-all}"

case "${lane}" in
    all|node24|node18) ;;
    *) echo "[local-ci] unknown Linux lane: ${lane}" >&2; exit 2 ;;
esac

if ! command -v docker >/dev/null 2>&1; then
    echo "[local-ci] docker is required" >&2
    exit 2
fi

source_root="$(cd -- "${source_root}" && pwd)"
dockerfile="${tooling_root}/tools/local-ci/Dockerfile"
node24_image=kmp-test-runner-local-ci:node24
node18_image=kmp-test-runner-local-ci:node18

snapshot_meta="$(mktemp -d)"
raw_manifest="${snapshot_meta}/raw-manifest"
source_manifest="${snapshot_meta}/source-manifest"
source_archive="${snapshot_meta}/source.tar"
source_bundle="${snapshot_meta}/source.bundle"
cleanup() {
    rm -rf "${snapshot_meta}"
}
trap cleanup EXIT

# Include tracked files plus non-ignored local additions. This keeps caches,
# private captures, and unrelated machine state outside the container while
# still validating the exact uncommitted change under review.
if git -C "${source_root}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    source_git=(git -C "${source_root}")
elif [[ -f "${source_root}/.git" ]] && command -v wslpath >/dev/null 2>&1; then
    git_dir="$(sed -n 's/^gitdir: //p' "${source_root}/.git" | tr -d '\r')"
    if [[ "${git_dir}" =~ ^[A-Za-z]:[/\\] ]]; then
        git_dir="$(wslpath -u "${git_dir}")"
    fi
    source_git=(git --git-dir="${git_dir}" --work-tree="${source_root}")
else
    echo "[local-ci] cannot query the source worktree with git" >&2
    exit 2
fi

if ! "${source_git[@]}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "[local-ci] resolved source metadata is not a Git worktree" >&2
    exit 2
fi
"${source_git[@]}" ls-files --cached --others --exclude-standard -z >"${raw_manifest}"
"${source_git[@]}" bundle create "${source_bundle}" HEAD

while IFS= read -r -d '' rel; do
    [[ "${rel}" == "AGENTS.md" ]] && continue
    if [[ -f "${source_root}/${rel}" || -L "${source_root}/${rel}" ]]; then
        printf '%s\0' "${rel}" >>"${source_manifest}"
    fi
done <"${raw_manifest}"

if [[ ! -s "${source_manifest}" ]]; then
    echo "[local-ci] git source manifest is empty" >&2
    exit 2
fi

tar -C "${source_root}" \
    --null --files-from="${source_manifest}" \
    -cf "${source_archive}"

docker volume create kmp-local-ci-npm >/dev/null

if [[ "${lane}" == all || "${lane}" == node24 ]]; then
    docker build --target node24 -t "${node24_image}" -f "${dockerfile}" "${tooling_root}"
    docker volume create kmp-local-ci-gradle >/dev/null
    docker run --rm \
        --mount "type=bind,src=${source_archive},dst=/source.tar,readonly" \
        --mount "type=bind,src=${source_bundle},dst=/source.bundle,readonly" \
        --mount type=volume,src=kmp-local-ci-npm,dst=/cache/npm \
        --mount type=volume,src=kmp-local-ci-gradle,dst=/cache/gradle \
        "${node24_image}"
fi

if [[ "${lane}" == all || "${lane}" == node18 ]]; then
    docker build --target node18 -t "${node18_image}" -f "${dockerfile}" "${tooling_root}"
    docker run --rm \
        --mount "type=bind,src=${source_archive},dst=/source.tar,readonly" \
        --mount "type=bind,src=${source_bundle},dst=/source.bundle,readonly" \
        --mount type=volume,src=kmp-local-ci-npm,dst=/cache/npm \
        "${node18_image}"
fi
