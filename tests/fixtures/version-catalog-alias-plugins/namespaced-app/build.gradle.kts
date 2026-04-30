// Namespaced alias key (nowinandroid pattern) — catalog has no exact entry,
// so v0.6.x Gap 3 falls back to suffix heuristic and resolves the trailing
// `android.application` to `com.android.application`.
plugins {
    alias(libs.plugins.nowinandroid.android.application)
}
