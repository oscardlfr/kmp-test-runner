plugins {
    kotlin("jvm") version "2.3.20"
    jacoco
}

dependencies {
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
}

// No tasks.jacocoTestReport{} configuration by default — kmp-test's coverage-XML
// autofix init-script (orchestrator-utils.js#writeCoverageXmlInitScript) forces
// xml.required=true via allprojects{}.tasks.withType(JacocoReport).configureEach{},
// registered BEFORE this project's own build script runs. Declaring an explicit
// xml.required.set(false) unconditionally here would register a SECOND, LATER
// configuration action that wins over the init-script's earlier one, permanently
// defeating the autofix for cases that need real XML.
//
// The PR A E2E producer test (Evidence1 success-recovery runbook Section 8.8)
// needs a THIRD real case where XML is deliberately absent. It gates the same
// later-wins-on-registration-order behavior behind a Gradle project property
// (-PcoverageBudgetE2eDisableXml=true) instead of --no-coverage-xml-autofix,
// because that flag was found NOT to suppress the autofix init-script's
// injection in this exact Gradle/task-graph shape (verified empirically: the
// init-script is still written and passed to gradle even with the flag set) —
// a pre-existing bug in shouldAutofixCoverageXml/dispatchCoverageReports,
// outside lib/orchestrators/orchestrator-utils.js, which is not in PR A's
// allowlist. Reported separately; this fixture works around it rather than
// depending on it.
if (providers.gradleProperty("coverageBudgetE2eDisableXml").isPresent) {
    tasks.jacocoTestReport {
        reports {
            xml.required.set(false)
        }
    }
}
