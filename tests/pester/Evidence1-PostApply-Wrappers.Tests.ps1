#Requires -Modules Pester

BeforeAll {
  $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
  $script:AuditRoot = Join-Path $script:RepoRoot 'docs\audits'
  Import-Module (Join-Path $script:AuditRoot 'evidence1-host-windows-provisioning-chain.psm1') -Force
  Import-Module (Join-Path $script:AuditRoot 'evidence1-validation-ops.psm1') -Force
  $runnerPath = Join-Path $script:AuditRoot 'evidence1-host-elevated-runner.ps1'
  $tokens = $null; $errors = $null
  $runnerAst = [Management.Automation.Language.Parser]::ParseFile($runnerPath, [ref]$tokens, [ref]$errors)
  if ($errors.Count -ne 0) { throw 'elevated_runner_parse_failed' }
  foreach ($functionName in @('Get-E1ExactNamedArguments','Assert-E1CanonicalPostApplyRunnerArguments','Get-E1RedactedDisplayArguments')) {
    $definition = $runnerAst.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $functionName }, $true) | Select-Object -First 1
    if (-not $definition) { throw "elevated_runner_function_missing:$functionName" }
    . ([scriptblock]::Create($definition.Extent.Text))
  }
  $script:ProfileSha = 'a' * 64
  $script:InputLockSha = 'b' * 64
  $script:VmId = '11111111-2222-3333-4444-555555555555'
}

Describe 'Evidence1 post-apply receipt chain' {
  It 'accepts only the fixed E2E profile and rejects the product profile' {
    $e2e = Join-Path $script:RepoRoot 'tools\evidence1\provisioning\evidence1-windows-hyperv-e2e-v1.json'
    $product = Join-Path $script:RepoRoot 'tools\evidence1\provisioning\evidence1-windows-hyperv-v1.json'
    if (Test-Path -LiteralPath $e2e) { { Assert-E1CanonicalE2EProfile $e2e } | Should -Not -Throw }
    { Assert-E1CanonicalE2EProfile $product } | Should -Throw '*canonical_e2e_profile_invalid*'
  }

  It 'accepts only an isolated zero-inference Apply boundary' {
    $receipt = [pscustomobject]@{
      schema = 1; verdict = 'PASS'; mode = 'Apply'; reason_code = $null
      profile_id = 'evidence1-windows-hyperv-e2e-v1'; profile_sha256 = $script:ProfileSha
      input_lock_sha256 = $script:InputLockSha; vm_id = $script:VmId; vm_state = 'Off'
      network_used = $false; network_state = 'disconnected'; powershell_direct_ready = $true
      answer_files_absent = $true; autologon_values_absent = $true; auth_material_read = $false
      auth_material_copied = $false; private_paths_persisted = $false
      inference_sessions_consumed = 0; next_phase = 'verify-and-seal-post-os'
    }
    { Assert-E1CanonicalApplyReceipt $receipt $script:ProfileSha $script:InputLockSha $script:VmId } | Should -Not -Throw
    foreach ($mutation in @('network','inference','profile','vm')) {
      $candidate = $receipt | ConvertTo-Json | ConvertFrom-Json
      switch ($mutation) {
        'network' { $candidate.network_used = $true }
        'inference' { $candidate.inference_sessions_consumed = 1 }
        'profile' { $candidate.profile_id = 'evidence1-windows-hyperv-v1' }
        'vm' { $candidate.vm_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }
      }
      { Assert-E1CanonicalApplyReceipt $candidate $script:ProfileSha $script:InputLockSha $script:VmId } | Should -Throw '*apply_receipt_binding_mismatch*'
    }
  }

  It 'rejects missing, mistyped, or substituted receipt links' {
    $directory = Join-Path 'C:\kmp-eval\scratch' ('post-apply-chain-test-' + [guid]::NewGuid().ToString('N'))
    $priorPath = Join-Path $directory 'prior.json'; $corePath = Join-Path $directory 'core.json'
    try {
      New-Item -ItemType Directory -Path $directory | Out-Null
      [IO.File]::WriteAllText($priorPath, '{"stage":"prior"}', [Text.UTF8Encoding]::new($false))
      [IO.File]::WriteAllText($corePath, '{"stage":"core"}', [Text.UTF8Encoding]::new($false))
      $priorSha = Get-E1WindowsProvisioningSha256 $priorPath; $coreSha = Get-E1WindowsProvisioningSha256 $corePath
      $receipt = [pscustomobject]@{ receipt_chain = [pscustomobject]@{
        schema = 1; operation = 'toolchain-verify'; prior_receipt_sha256 = $priorSha; core_receipt_sha256 = $coreSha
      } }
      { Assert-E1WindowsProvisioningReceiptChain $receipt 'toolchain-verify' $priorSha $coreSha } | Should -Not -Throw
      foreach ($mutation in @('operation','prior','core','schema','expected')) {
        $candidate = $receipt | ConvertTo-Json | ConvertFrom-Json
        $expectedPrior = $priorSha
        switch ($mutation) {
          'operation' { $candidate.receipt_chain.operation = 'toolchain-bootstrap' }
          'prior' { $candidate.receipt_chain.prior_receipt_sha256 = 'not-a-hash' }
          'core' { $candidate.receipt_chain.core_receipt_sha256 = 'e' * 63 }
          'schema' { $candidate.receipt_chain.schema = 2 }
          'expected' { $expectedPrior = $coreSha }
        }
        { Assert-E1WindowsProvisioningReceiptChain $candidate 'toolchain-verify' $expectedPrior $coreSha } | Should -Throw '*receipt_chain_binding_mismatch*'
      }
    } finally {
      foreach ($path in @($priorPath,$corePath)) { if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force } }
      if (Test-Path -LiteralPath $directory -PathType Container) { Remove-Item -LiteralPath $directory -Force }
    }
  }

  It 'writes a collision-safe sanitized chained receipt under scratch' {
    $directory = Join-Path 'C:\kmp-eval\scratch' ('post-apply-contract-test-' + [guid]::NewGuid().ToString('N'))
    $path = Join-Path $directory 'receipt.json'
    $priorPath = Join-Path $directory 'prior.json'; $corePath = Join-Path $directory 'core.json'
    try {
      $core = [pscustomobject]@{ schema = 1; verdict = 'PASS'; inference_sessions_consumed = 0 }
      New-Item -ItemType Directory -Path $directory | Out-Null
      [IO.File]::WriteAllText($priorPath, '{"stage":"prior"}', [Text.UTF8Encoding]::new($false))
      [IO.File]::WriteAllText($corePath, ($core | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
      $actual = Write-E1WindowsProvisioningChainedReceipt $path $corePath $priorPath 'post-os-verify'
      $actual.path | Should -BeExactly $path
      Test-Path -LiteralPath $corePath -PathType Leaf | Should -BeTrue
      $receipt = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
      $receipt.receipt_chain.operation | Should -BeExactly 'post-os-verify'
      $receipt.network_used | Should -BeFalse
      $receipt.auth_material_read | Should -BeFalse
      $receipt.auth_material_copied | Should -BeFalse
      $receipt.private_paths_persisted | Should -BeFalse
      { Write-E1WindowsProvisioningChainedReceipt $path $corePath $priorPath 'post-os-verify' } | Should -Throw '*receipt_already_exists*'
    } finally {
      foreach ($item in @($path,$priorPath,$corePath)) { if (Test-Path -LiteralPath $item -PathType Leaf) { Remove-Item -LiteralPath $item -Force } }
      if (Test-Path -LiteralPath $directory -PathType Container) { Remove-Item -LiteralPath $directory -Force }
    }
  }

  It 'returns only the core exit code even when the core writes output' {
    $directory = Join-Path 'C:\kmp-eval\scratch' ('post-apply-core-test-' + [guid]::NewGuid().ToString('N'))
    $scriptPath = Join-Path $directory 'core.ps1'
    try {
      New-Item -ItemType Directory -Path $directory | Out-Null
      [IO.File]::WriteAllText($scriptPath, "Write-Output 'bounded-core-output'`nexit 7`n", [Text.UTF8Encoding]::new($false))
      $actual = Invoke-E1WindowsProvisioningCore $scriptPath @() 30
      $actual.GetType() | Should -Be ([int])
      $actual | Should -Be 7
    } finally {
      if (Test-Path -LiteralPath $scriptPath -PathType Leaf) { Remove-Item -LiteralPath $scriptPath -Force }
      if (Test-Path -LiteralPath $directory -PathType Container) { Remove-Item -LiteralPath $directory -Force }
    }
  }
}

Describe 'Evidence1 post-apply wrapper source contract' {
  It 'parses every wrapper in Windows PowerShell and contains no hard-power fallback' {
    foreach ($name in @(
      'evidence1-host-diagnose-windows-first-boot.ps1',
      'evidence1-host-post-os-canonical-windows.ps1',
      'evidence1-host-bootstrap-canonical-windows-toolchain.ps1',
      'evidence1-host-checkpoint-canonical-windows-toolchain.ps1'
    )) {
      $path = Join-Path $script:AuditRoot $name
      $tokens = $null; $errors = $null
      [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null
      $errors.Count | Should -Be 0
      (Get-Content -LiteralPath $path -Raw) | Should -Not -Match 'Stop-VM|-TurnOff|Connect-VMNetworkAdapter'
    }
  }
}

Describe 'Evidence1 elevated runner post-apply argv contract' {
  It 'accepts the exact canonical argv shapes' {
    $common = @('-InputLockPath','C:\kmp-eval\scratch\lock.json','-GuestCredentialPath','C:\kmp-eval\scratch\guest.xml')
    $diagnose = @('-InputLockPath','C:\kmp-eval\scratch\lock.json','-RecoveryReceiptPath','C:\kmp-eval\scratch\recovery.json','-ReceiptPath','C:\kmp-eval\scratch\diagnostic.json','-AuthorizationPhrase','authorize diagnose evidence1 recovered first boot without auth')
    $postStart = @('-Mode','StartAndVerify') + $common + @('-PriorReceiptPath','C:\kmp-eval\scratch\apply.json','-ReceiptPath','C:\kmp-eval\scratch\verify.json','-AuthorizationPhrase','authorize start evidence1 e2e post-os verification')
    $postSeal = @('-Mode','Seal') + $common + @('-PriorReceiptPath','C:\kmp-eval\scratch\verify.json','-PriorParentReceiptPath','C:\kmp-eval\scratch\apply.json','-ReceiptPath','C:\kmp-eval\scratch\seal.json','-AuthorizationPhrase','authorize seal evidence1 windows post-os boundary')
    $bootstrap = @('-Mode','Bootstrap') + $common + @('-PriorReceiptPath','C:\kmp-eval\scratch\seal.json','-PriorParentReceiptPath','C:\kmp-eval\scratch\verify.json','-ReceiptPath','C:\kmp-eval\scratch\bootstrap.json','-AuthorizationPhrase','authorize bootstrap evidence1 e2e windows toolchain without auth')
    $verify = @('-Mode','Verify') + $common + @('-PriorReceiptPath','C:\kmp-eval\scratch\bootstrap.json','-PriorParentReceiptPath','C:\kmp-eval\scratch\seal.json','-ReceiptPath','C:\kmp-eval\scratch\toolchain-verify.json')
    $checkpoint = $common + @('-ToolchainReceiptPath','C:\kmp-eval\scratch\toolchain-verify.json','-PriorParentReceiptPath','C:\kmp-eval\scratch\bootstrap.json','-ReceiptPath','C:\kmp-eval\scratch\checkpoint.json','-ShutdownTimeoutSeconds','120','-AuthorizationPhrase','authorize checkpoint verified evidence1 toolchain without auth')
    { Assert-E1CanonicalPostApplyRunnerArguments 'evidence1-host-diagnose-windows-first-boot.ps1' $diagnose } | Should -Not -Throw
    { Assert-E1CanonicalPostApplyRunnerArguments 'evidence1-host-post-os-canonical-windows.ps1' $postStart } | Should -Not -Throw
    { Assert-E1CanonicalPostApplyRunnerArguments 'evidence1-host-post-os-canonical-windows.ps1' $postSeal } | Should -Not -Throw
    { Assert-E1CanonicalPostApplyRunnerArguments 'evidence1-host-bootstrap-canonical-windows-toolchain.ps1' $bootstrap } | Should -Not -Throw
    { Assert-E1CanonicalPostApplyRunnerArguments 'evidence1-host-bootstrap-canonical-windows-toolchain.ps1' $verify } | Should -Not -Throw
    { Assert-E1CanonicalPostApplyRunnerArguments 'evidence1-host-checkpoint-canonical-windows-toolchain.ps1' $checkpoint } | Should -Not -Throw
  }

  It 'rejects abbreviations, positionals, duplicates, unknowns, and forbidden authorization' {
    $scriptName = 'evidence1-host-post-os-canonical-windows.ps1'
    foreach ($arguments in @(
      @('-M','StartAndVerify'),
      @('StartAndVerify','value'),
      @('-Mode','StartAndVerify','-Mode','Seal'),
      @('-Unknown','value')
    )) {
      { Assert-E1CanonicalPostApplyRunnerArguments $scriptName $arguments } | Should -Throw
    }
    $verifyWithAuthorization = @('-Mode','Verify','-InputLockPath','lock','-GuestCredentialPath','credential','-PriorReceiptPath','prior','-PriorParentReceiptPath','parent','-ReceiptPath','receipt','-AuthorizationPhrase','authorize bootstrap evidence1 e2e windows toolchain without auth')
    { Assert-E1CanonicalPostApplyRunnerArguments 'evidence1-host-bootstrap-canonical-windows-toolchain.ps1' $verifyWithAuthorization } | Should -Throw '*canonical post-apply argv invalid*'
    $diagnoseWithCredential = @('-InputLockPath','lock','-RecoveryReceiptPath','recovery','-ReceiptPath','diagnostic','-GuestCredentialPath','credential','-AuthorizationPhrase','authorize diagnose evidence1 recovered first boot without auth')
    { Assert-E1CanonicalPostApplyRunnerArguments 'evidence1-host-diagnose-windows-first-boot.ps1' $diagnoseWithCredential } | Should -Throw '*canonical post-apply argv*'
  }

  It 'redacts positional and abbreviated authorization spellings before logging' {
    foreach ($arguments in @(
      @('authorize start evidence1 e2e post-os verification'),
      @('-A','authorize start evidence1 e2e post-os verification'),
      @('/Auth: authorize bootstrap evidence1 e2e windows toolchain without auth'),
      @('-AuthorizationPhrase=AUTORIZO checkpoint verified evidence1 toolchain without auth')
    )) {
      $display = @(Get-E1RedactedDisplayArguments $arguments) -join ' '
      $display | Should -Not -Match '(?i)authorize|autorizo'
      $display | Should -Match '\[REDACTED_AUTHORIZATION\]'
    }
  }
}
