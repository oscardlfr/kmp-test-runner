// Writes each argument (argv[2+]) on its own line to stdout.
// Used by windows-metachar round-trip tests to prove cmd.exe arg transport.
process.argv.slice(2).forEach(a => process.stdout.write(a + '\n'));
