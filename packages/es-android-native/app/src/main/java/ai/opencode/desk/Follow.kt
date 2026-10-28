package ai.opencode.desk

// Follow-scroll for reversed transcripts (index 0 = newest): after Send jump to the bottom and
// keep following new output, unless the reader scrolled up on purpose; then offer "jump to
// latest" instead of yanking the view.
object Follow {
    fun scrolledUp(firstVisibleIndex: Int, firstVisibleOffset: Int, slackPx: Int = 200) = firstVisibleIndex > 0 || firstVisibleOffset > slackPx
    fun shouldFollow(userScrolledUp: Boolean, justSent: Boolean) = justSent || !userScrolledUp
}
