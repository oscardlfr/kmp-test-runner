#!/usr/bin/env bash
set -euo pipefail

source /usr/local/lib/kmp-local-ci/prepare-source.sh
prepare_source
cd "${KMP_LOCAL_CI_WORK_ROOT}"

mkdir -p "${NPM_CONFIG_CACHE}" /tmp/kmp-local-ci-home
export HOME=/tmp/kmp-local-ci-home

case "$(node --version)" in
    v18.*) ;;
    *) echo "[local-ci] expected Node 18, got $(node --version)" >&2; exit 2 ;;
esac

npm ci
npx vitest run

echo "[local-ci] Linux Node 18 compatibility lane passed"
