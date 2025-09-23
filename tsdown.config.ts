import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  target: ["node18", "es2022"],
  sourcemap: true,
  minify: true
});
