import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/dashboard",
  base: "/dashboard/",
  plugins: [react()],
  build: {
    outDir: "../../dist/dashboard",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: resolve(__dirname, "src/dashboard/index.html"),
    },
  },
});
