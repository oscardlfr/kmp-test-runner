# Troubleshooting — Windows

Windows-specific gotchas for running `kmp-test-runner` and its bundled tools.

## TLS interception — `UNABLE_TO_VERIFY_LEAF_SIGNATURE`

**Symptom.** On a Windows host behind corporate TLS interception (AV / proxy SSL
inspection), Node rejects the intercepted certificate because the bundled CA
bundle doesn't include the corporate root. The first outbound HTTPS call fails
with:

```
fetch failed
  cause: Error: unable to verify the first certificate
         code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
```

This affects any Node code in this repo that makes an external HTTPS request:

- `kmp-test update` — probes GitHub Releases (`lib/orchestrators/update-orchestrator.js`).
- `tools/measure-token-cost.js` — calls the Anthropic `count_tokens` endpoint.

It does **not** affect the core test/coverage flow (`gradlew` runs locally over
no TLS), so most users never hit it.

**Diagnosis.** Confirm it's the trust store and not the network:

```bash
node -e "fetch('https://api.anthropic.com/').then(() => console.log('OK')).catch(e => console.log('ERR:', e.cause?.code))"
```

`ERR: UNABLE_TO_VERIFY_LEAF_SIGNATURE` confirms the intercepted-cert case.

**Fix.** Tell Node to use the Windows system trust store (which the corporate AV
typically populates) via `--use-system-ca` (Node 22+):

```powershell
# PowerShell — current session
$env:NODE_OPTIONS = '--use-system-ca'

# PowerShell — persist for the user
[Environment]::SetEnvironmentVariable('NODE_OPTIONS', '--use-system-ca', 'User')
```

```bat
:: CMD — current session
set NODE_OPTIONS=--use-system-ca
```

Then re-run the command. If you're on Node < 22, upgrade Node (the flag is the
supported path; manually bundling the corporate root into `NODE_EXTRA_CA_CERTS`
is a fragile fallback).

## Line endings — bundled shell scripts

The repo pins `scripts/**/*.sh` (and `.skills/**/*.sh`) to LF via
[`.gitattributes`](../.gitattributes). If you clone with `core.autocrlf=true`
(the Windows git default) on a **stale** checkout that predates those pins,
`bash scripts/install.sh` may fail with `set: pipefail : invalid option name`
(a CRLF `\r` swallowed into the option name). The fix is a fresh checkout that
honors the pins — either re-clone, or force the affected scripts to be
re-created from the index:

```bash
find scripts -name '*.sh' -delete && git checkout -- scripts/
```

`git add --renormalize . && git checkout -- .` does **not** fix it once the
committed blobs are already LF: git treats the CRLF working copy as equivalent
to the LF index and skips the rewrite, so the working-tree CRLF persists.
