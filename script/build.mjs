import { build as viteBuild } from "vite";
import react from "@vitejs/plugin-react";
import { rm } from "node:fs/promises";
import path from "node:path";

const bundledServerDeps = [
  "connect-pg-simple",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-session",
  "passport",
  "passport-local",
  "pg",
  "zod",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild({
    configFile: false,
    plugins: [react()],
    resolve: {
      preserveSymlinks: true,
      alias: {
        "@": path.resolve("client", "src"),
        "@shared": path.resolve("shared"),
        "@assets": path.resolve("attached_assets"),
      },
    },
    root: path.resolve("client"),
    build: {
      outDir: path.resolve("dist/public"),
      emptyOutDir: true,
    },
  });

  console.log("building server...");
  await viteBuild({
    configFile: false,
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    resolve: {
      preserveSymlinks: true,
      alias: {
        "@": path.resolve("client", "src"),
        "@shared": path.resolve("shared"),
        "@assets": path.resolve("attached_assets"),
      },
    },
    ssr: {
      noExternal: bundledServerDeps,
    },
    build: {
      ssr: "server/index.ts",
      outDir: path.resolve("dist"),
      emptyOutDir: false,
      minify: true,
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "index.cjs",
          chunkFileNames: "server-assets/[name]-[hash].cjs",
        },
      },
    },
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
