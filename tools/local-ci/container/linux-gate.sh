#!/usr/bin/env bash
set -euo pipefail

source /usr/local/lib/kmp-local-ci/prepare-source.sh
prepare_source
cd "${KMP_LOCAL_CI_WORK_ROOT}"

mkdir -p "${NPM_CONFIG_CACHE}" "${GRADLE_USER_HOME}" /tmp/kmp-local-ci-home
export HOME=/tmp/kmp-local-ci-home

echo "[local-ci] Linux lane: Node $(node --version), Java $(${JAVA_HOME}/bin/java -version 2>&1 | head -1)"

npm ci
node tools/check-line-endings.mjs
node tools/sync-versions.js --check
node tools/validate-required-checks.mjs --schema-only
actionlint -shellcheck=
node tools/decouple-audit.mjs
node tools/check-bundle-size.mjs
node tools/validate-plugin.mjs

npm audit --omit=dev --audit-level=high
if ! npm audit --audit-level=high; then
    echo "[local-ci] informational: dev-toolchain audit reported advisories" >&2
fi

shellcheck --severity=warning --external-sources --exclude=SC2034,SC2053,SC2069 \
    scripts/sh/*.sh scripts/sh/lib/*.sh scripts/install.sh scripts/uninstall.sh \
    .skills/kmp-test-runner/scripts/*.sh

bats tests/bats/ tests/installer/ tests/skill-scripts/
npx vitest run --coverage

(cd gradle-plugin && ./gradlew --no-daemon test)

artifact_version="$(node -p "require('./package.json').version")"
artifact_dir=/tmp/kmp-local-ci-artifacts
rm -rf "${artifact_dir}"
bash scripts/build-artifact.sh "${artifact_version}" "${artifact_dir}"
LOCAL_ARCHIVE="${artifact_dir}/kmp-test-runner-${artifact_version}-linux.tar.gz" \
ARTIFACT_VER="${artifact_version}" \
    bats tests/installer/install.bats --filter E2E

npx -y skills-ref@0.1.5 validate .skills/kmp-test-runner/

echo "[local-ci] Linux Node 24/JDK 17 lane passed"
