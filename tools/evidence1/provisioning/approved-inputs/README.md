# Approved Evidence1 inputs

Only reviewed, path-free input manifests belong here. A private input lock is accepted only when its manifest is tracked at the current repository `HEAD`, byte-identical to that Git blob, clean in the worktree, and marked `approval_status: "approved"`.

Each production manifest must pin the Microsoft ISO identity and inspected Windows image metadata, plus the upstream and normalized identities of every toolchain artifact. Candidate manifests are not approved inputs and must stay outside this directory until their sources, signatures/checksums, normalization procedure, and hashes have been reviewed.

No ISO, executable, archive, credential, private path, download token, or raw command output may be committed here.
