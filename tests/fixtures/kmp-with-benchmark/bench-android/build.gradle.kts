// Android-only androidx.benchmark module. Orchestrator should detect this and
// dispatch :bench-android:connectedAndroidTest when --platform android|all
// AND an adb device is available (or KMP_TEST_SKIP_ADB=1 is set).
plugins {
    id("com.android.library")
    id("androidx.benchmark")
}

android {
    namespace = "test.fixture.bench"
    compileSdk = 34
}

dependencies {
    implementation("androidx.benchmark:benchmark-junit4:1.2.0")
}
