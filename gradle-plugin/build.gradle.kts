import org.gradle.language.jvm.tasks.ProcessResources

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

val testMavenRepoDir = layout.buildDirectory.dir("test-maven-repo").get().asFile

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
            name = "TestLocal"
            url = uri(testMavenRepoDir)
        }
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
    dependsOn("publishAllPublicationsToTestLocalRepository")
    maxParallelForks = 1
    systemProperty("plugin.version", project.version.toString())
    systemProperty("test.maven.repo", testMavenRepoDir.absolutePath.replace('\\', '/'))
}

// Additive processResources: copies lib/, scripts/{sh,ps1,lib}/, and package.json
// into the plugin JAR. Unlike Sync, each from() block only adds files — no other
// destinations are deleted when this block runs.
tasks.named<ProcessResources>("processResources") {
    from("../scripts/sh")  { into("scripts/sh");  exclude(".gitkeep") }
    from("../scripts/ps1") { into("scripts/ps1"); exclude(".gitkeep") }
    from("../scripts/lib") { into("scripts/lib"); exclude(".gitkeep") }
    from("../lib")         { into("lib") }
    from("..") { include("package.json") }
}
