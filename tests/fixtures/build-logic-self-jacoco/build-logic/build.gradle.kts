// build-logic compiles itself with jacoco for self-tests of its convention
// plugins. The `plugins { jacoco }` block applies jacoco TO build-logic, not
// to consumer modules. detectBuildLogicCoverageHints must classify this as
// kind='self' — analyzeModule must NOT inherit jacoco for consumer modules.
plugins {
    `kotlin-dsl`
    jacoco
}
