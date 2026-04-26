import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: "127.0.0.1",
    allowedHosts: ["mr.tail0d96d3.ts.net", ".tail0d96d3.ts.net"],
  },
})
