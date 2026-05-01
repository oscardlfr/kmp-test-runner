plugins {
    `java-gradle-plugin`
    `maven-publish`
    kotlin("jvm") version "2.3.20"
}

group = "io.github.oscardlfr"
version = "0.7.0"

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
tasks.named("processResources") { dependsOn(syncScripts) }
