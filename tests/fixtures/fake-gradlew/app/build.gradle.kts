plugins {
  id("org.jetbrains.kotlin.multiplatform")
}

kotlin {
  jvm()

  sourceSets {
    val commonMain by getting
    val commonTest by getting
    val jvmTest by getting
  }
}
