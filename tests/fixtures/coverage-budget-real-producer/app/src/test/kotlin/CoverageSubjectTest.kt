package coveragebudget

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class CoverageSubjectTest {
    @Test
    fun exercisesTrueBranchOnly() {
        val subject = CoverageSubject()
        assertEquals(1, subject.coveredBranch(true))
    }
}
