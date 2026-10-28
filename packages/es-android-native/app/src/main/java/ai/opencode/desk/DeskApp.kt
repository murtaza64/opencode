package ai.opencode.desk

import android.app.Application
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner

// One DeskStore per process, owned by the Application rather than the Activity, so the
// Stay-connected service and the UI share the same connection loop, SSE stream, outbox and
// reconciler (inbox-push 2b: "one stream"). Activities look it up here instead of creating
// their own.
class DeskApp : Application(), ViewModelStoreOwner {
    override val viewModelStore = ViewModelStore()
    val store: DeskStore by lazy { ViewModelProvider(this, ViewModelProvider.AndroidViewModelFactory.getInstance(this))[DeskStore::class.java] }

    companion object {
        fun store(context: android.content.Context): DeskStore = (context.applicationContext as DeskApp).store
    }
}
