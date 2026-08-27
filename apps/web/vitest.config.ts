import { defineConfig } from "vitest/config";

// The one thing this project cannot inherit from the root config.
//
// apps/web's tsconfig sets `jsx: "preserve"` because Next owns the JSX transform; Vite's
// transformer reads that tsconfig and hands import analysis untransformed JSX, which fails.
// So any test that renders a component needs the runtime named here, in the project's own
// root. It is `oxc`, not `esbuild`: Vite 8 transforms with oxc and ignores esbuild options —
// setting the esbuild key instead produces a warning and no effect.
//
// `test` is deliberately empty: `fileParallelism: false` lives in the root config and is
// load-bearing (ADR-0003's global chain lock). Nothing here may restate or override it.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
});
