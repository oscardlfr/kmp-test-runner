package io.github.oscardlfr.kmptest.fixture.sample

import kotlin.test.Test
import kotlin.test.assertEquals

class CommonTrivialTest {
    @Test
    fun answerIsForty_two() {
        assertEquals(42, Sample.ANSWER)
    }

    @Test
    fun mathHolds() {
        assertEquals(2, 1 + 1)
    }
}
