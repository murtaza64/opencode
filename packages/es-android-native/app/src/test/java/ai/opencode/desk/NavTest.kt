package ai.opencode.desk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NavTest {
    @Test
    fun push_is_forward() {
        val nav = Nav()
        nav.push(Route.Chat)
        assertTrue(nav.forward)
        assertEquals(Route.Chat, nav.current)
    }

    @Test
    fun pop_is_backward_and_the_outgoing_route_is_gone() {
        val nav = Nav()
        nav.push(Route.Agent("a"))
        assertTrue(nav.pop())
        assertFalse(nav.forward)
        assertEquals(listOf(Route.Home), nav.stack.toList())
    }

    @Test
    fun pop_at_root_is_refused_and_leaves_direction_alone() {
        val nav = Nav()
        assertFalse(nav.pop())
        assertTrue(nav.forward)
        assertEquals(Route.Home, nav.current)
    }

    @Test
    fun push_after_pop_is_forward_again() {
        val nav = Nav()
        nav.push(Route.Chat)
        nav.pop()
        nav.push(Route.Agent("b"))
        assertTrue(nav.forward)
    }

    @Test
    fun pushing_the_current_route_is_a_no_op() {
        val nav = Nav()
        nav.push(Route.Chat)
        nav.pop()
        nav.push(Route.Home)
        assertEquals(1, nav.stack.size)
        assertFalse(nav.forward)
    }
}
