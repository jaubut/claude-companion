import { createRoot } from "react-dom/client"
import { App } from "./app"
import { registerServiceWorker } from "./lib/push"
import "./index.css"

createRoot(document.getElementById("root")!).render(<App />)

// Register service worker for push notifications. Silently no-ops over HTTP.
void registerServiceWorker()
