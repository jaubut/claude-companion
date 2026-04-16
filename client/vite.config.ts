import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { resolve } from "path"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  server: {
    port: 5176,
    host: true,
    proxy: {
      "/api": {
        target: "http://localhost:4245",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:4245",
        ws: true,
      },
    },
  },
})
