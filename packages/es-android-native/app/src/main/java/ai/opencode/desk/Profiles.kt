package ai.opencode.desk

// Two Desk instances on one phone: the personal profile (user 0) and the work profile
// (user 10), each paired to its own host. Switching host = switching app via Android's
// CrossProfileApps (API 28+, own package, no permission). This file is the pure decision
// layer; ProfileBridge.kt talks to the platform.
object Profiles {
    data class Current(val managed: Boolean) {
        val name get() = if (managed) "Work" else "Personal"
    }

    // A reachable other-profile target: Android's own label and icon are used verbatim
    // ("Switch to work apps" / "Switch to personal apps"), never our own wording.
    data class Target(val label: String, val managed: Boolean)

    data class Switch(val visible: Boolean, val label: String?, val currentName: String)

    // The header action shows only when the other profile has Desk installed (targets
    // non-empty). With several targets (unusual), the first is used.
    fun decide(current: Current, targets: List<Target>): Switch {
        val target = targets.firstOrNull() ?: return Switch(false, null, current.name)
        return Switch(true, target.label, current.name)
    }

    // Connection-label suffix: "Work" / "Personal" only when a second profile exists,
    // so single-profile phones keep the short label.
    fun profileSuffix(current: Current, targets: List<Target>): String? =
        if (targets.isEmpty()) null else current.name
}
