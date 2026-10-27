package ai.opencode.desk

// Inline preview geometry (CHAT-PARTS §3) in dp, computed from stored dimensions so the box
// is reserved before any decode and is identical for the pending bubble and the accepted
// transcript message: acceptance changes colour, never geometry.
object ImageLayout {
    const val MAX_W = 360
    const val MAX_H = 280
    const val ROW_H = 160
    const val GAP = 4
    const val SHOW = 3

    data class Box(val width: Int, val height: Int)

    // One image: natural aspect inside max 360x280 and the available column width.
    fun single(width: Int, height: Int, columnWidth: Int): Box {
        // Unknown dimensions: a 4:3 contain box at the single-image width, identical for pending and accepted.
        if (width <= 0 || height <= 0) { val w = minOf(MAX_W, columnWidth); return Box(w, minOf(MAX_H, w * 3 / 4)) }
        val maxW = minOf(MAX_W, columnWidth)
        val scale = minOf(maxW.toDouble() / width, MAX_H.toDouble() / height, 1.0)
        return Box(maxOf(1, (width * scale).toInt()), maxOf(1, (height * scale).toInt()))
    }

    // Row items: each 160dp tall at natural aspect, capped at the column width.
    fun tile(width: Int, height: Int, columnWidth: Int): Box {
        if (width <= 0 || height <= 0) return Box(ROW_H, ROW_H)
        val w = (width.toDouble() * ROW_H / height).toInt().coerceIn(1, columnWidth)
        return Box(w, ROW_H)
    }

    // Visible tiles for n images: all up to 4, else the first 3 plus a "+N" tile.
    fun visible(count: Int) = if (count <= 4) count else SHOW
    fun overflow(count: Int) = if (count <= 4) 0 else count - SHOW
}
