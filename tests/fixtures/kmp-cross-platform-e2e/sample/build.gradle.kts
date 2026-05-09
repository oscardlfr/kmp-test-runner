plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.android.kotlin.multiplatform.library)
}

kotlin {
    jvmToolchain(21)

    jvm()
    js(IR) { nodejs() }
    wasmJs { nodejs() }

    iosX64()
    iosSimulatorArm64()
    iosArm64()

    macosArm64()

    androidLibrary {
        namespace = "io.github.oscardlfr.kmptest.fixture.sample"
        compileSdk = libs.versions.android.compileSdk.get().toInt()
        minSdk = libs.versions.android.minSdk.get().toInt()

        withHostTestBuilder { }
    }

    sourceSets {
        commonTest.dependencies {
            implementation(kotlin("test"))
        }
    }
}
