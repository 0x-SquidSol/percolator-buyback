import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      // Mirror tsconfig.json path alias so vitest resolves at runtime the same
      // way tsc does at compile time. The destination indexer has
      // @percolatorct/sdk as a real dep; here we route imports to the local
      // sdk-staging package whose source carries the buyback event decoders not
      // yet published upstream.
      //
      // Use fileURLToPath rather than URL.pathname: on Windows the latter yields
      // "/C:/..." which Vite cannot resolve.
      "@percolatorct/sdk": fileURLToPath(
        new URL("../sdk-staging/src/index.ts", import.meta.url),
      ),
    },
  },
});
