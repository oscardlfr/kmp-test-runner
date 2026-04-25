plugins {
    `java-gradle-plugin`
    `maven-publish`
    kotlin("jvm") version "2.3.20"
}

group = "io.github.oscardlfr"
version = "0.2.0"

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

dependencies {
    implementation(kotlin("stdlib"))
    testImplementation(kotlin("test"))
    testImplementation(gradleTestKit())
}

tasks.test {
    useJUnitPlatform()
}
