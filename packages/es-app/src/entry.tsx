import "./index.css"
import { render } from "solid-js/web"
import type { ParentProps } from "solid-js"
import { MetaProvider } from "@solidjs/meta"
import { Route, Router } from "@solidjs/router"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import Home from "./pages/home"
import SessionPage from "./pages/session"
import Sidebar from "./components/sidebar"
import { DashboardProvider } from "./state"

function FileStub(props: { path?: string }) {
  return <span data-component="file-stub">{props.path ?? "[file]"}</span>
}

function Providers(props: ParentProps) {
  return (
    <MetaProvider>
      <DialogProvider>
        <MarkedProvider>
          <FileComponentProvider component={FileStub}>
            <DashboardProvider>
              <div class="shell">
                <Sidebar />
                <div class="content">{props.children}</div>
              </div>
            </DashboardProvider>
          </FileComponentProvider>
        </MarkedProvider>
      </DialogProvider>
    </MetaProvider>
  )
}

render(
  () => (
    <Router root={(p) => <Providers>{p.children}</Providers>}>
      <Route path="/" component={Home} />
      <Route path="/session/:id" component={SessionPage} />
    </Router>
  ),
  document.getElementById("root")!,
)
