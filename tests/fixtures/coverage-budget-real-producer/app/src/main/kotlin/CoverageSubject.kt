package coveragebudget

class CoverageSubject {
    fun coveredBranch(flag: Boolean): Int {
        return if (flag) {
            1
        } else {
            2
        }
    }

    fun neverCalled(): Int {
        val a = 10
        val b = 20
        return a + b
    }
}
