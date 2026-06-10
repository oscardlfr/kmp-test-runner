plugins {
    `java-gradle-plugin`
    `maven-publish`
    kotlin("jvm") version "2.3.20"
}

group = "io.github.oscardlfr"
version = "0.14.0"

kotlin {
    jvmToolchain(17)
}

gradlePlugin {
    plugins {
        create("kmpTestRunner") {
            id = "io.github.oscardlfr.kmp-test-runner"
            implementationClass = "io.github.oscardlfr.kmptestrunner.KmpTestRunnerPlugin"
        }
    }
}

publishing {
    publications {
        withType<MavenPublication>().configureEach {
            pom {
                name.set("kmp-test-runner")
                description.set(
                    "Parallel test runner for Kotlin Multiplatform and Android Gradle " +
                    "projects. Fans out test tasks across modules and emits a stable " +
                    "JSON envelope for AI coding agents."
                )
                url.set("https://github.com/oscardlfr/kmp-test-runner")
                licenses {
                    license {
                        name.set("MIT")
                        url.set("https://opensource.org/licenses/MIT")
                    }
                }
            }
        }
    }
    repositories {
        maven {
            name = "GitHubPackages"
            url = uri("https://maven.pkg.github.com/oscardlfr/kmp-test-runner")
            credentials {
                username = providers.gradleProperty("gpr.user").orNull
                    ?: System.getenv("GITHUB_ACTOR")
                password = providers.gradleProperty("gpr.key").orNull
                    ?: System.getenv("GITHUB_TOKEN")
            }
        }
    }
}

repositories {
    mavenCentral()
}

dependencies {
    implementation(kotlin("stdlib"))
    testImplementation(kotlin("test"))
    testImplementation(gradleTestKit())
    testImplementation("org.junit.jupiter:junit-jupiter-params:5.11.0")
}

tasks.test {
    useJUnitPlatform()
    dependsOn("publishToMavenLocal")
    maxParallelForks = 1
    // Expose plugin version to TestKit fixtures so they can resolve the freshly
    // published artefact without hardcoding a literal that would rot on every bump.
    systemProperty("plugin.version", project.version.toString())
}

val syncScripts by tasks.registering(Sync::class) {
    from("../scripts/sh")
    into(layout.buildDirectory.dir("resources/main/scripts/sh"))
}

// v0.8 STRATEGIC PIVOT: bundle lib/ + package.json for migrated subcommands.
// Tasks (BenchmarkTestsTask + future ChangedTestsTask, AndroidTestsTask, etc.)
// extract this tree to a temp dir at runtime and invoke `node lib/runner.js
// <feature>` directly. Sub-entry 1 (benchmark) is the first consumer.
val syncLib by tasks.registering(Sync::class) {
    from("../lib")
    into(layout.buildDirectory.dir("resources/main/lib"))
}
val syncPackageJson by tasks.registering(Sync::class) {
    from("..") {
        include("package.json")
    }
    into(layout.buildDirectory.dir("resources/main"))
}

tasks.named("processResources") {
    dependsOn(syncScripts, syncLib, syncPackageJson)
}
