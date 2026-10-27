package ai.opencode.desk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProfilesTest {
    private val personal = Profiles.Current(managed = false)
    private val work = Profiles.Current(managed = true)
    private val toWork = Profiles.Target("Switch to work apps", managed = true)
    private val toPersonal = Profiles.Target("Switch to personal apps", managed = false)

    @Test
    fun hidden_when_the_other_profile_has_no_desk() {
        val decision = Profiles.decide(personal, emptyList())
        assertFalse(decision.visible)
        assertNull(decision.label)
        assertEquals("Personal", decision.currentName)
        assertNull(Profiles.profileSuffix(personal, emptyList()))
    }

    @Test
    fun personal_profile_offers_the_platform_label_for_work() {
        val decision = Profiles.decide(personal, listOf(toWork))
        assertTrue(decision.visible)
        assertEquals("Switch to work apps", decision.label)
        assertEquals("Personal", decision.currentName)
        assertEquals("Personal", Profiles.profileSuffix(personal, listOf(toWork)))
    }

    @Test
    fun work_profile_offers_the_platform_label_for_personal() {
        val decision = Profiles.decide(work, listOf(toPersonal))
        assertTrue(decision.visible)
        assertEquals("Switch to personal apps", decision.label)
        assertEquals("Work", decision.currentName)
        assertEquals("Work", Profiles.profileSuffix(work, listOf(toPersonal)))
    }

    @Test
    fun several_targets_use_the_first_and_stay_visible() {
        val decision = Profiles.decide(personal, listOf(toWork, Profiles.Target("Switch to other", true)))
        assertTrue(decision.visible)
        assertEquals("Switch to work apps", decision.label)
    }

    @Test
    fun labels_are_never_invented_locally() {
        assertEquals("Custom label from Android", Profiles.decide(personal, listOf(Profiles.Target("Custom label from Android", true))).label)
    }
}
