import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// Nest necesita metadatos de decoradores (emitDecoratorMetadata), que esbuild no genera: se usa SWC.
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: "es6" },
      jsc: {
        target: "es2023",
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        keepClassNames: true,
      },
    }),
  ],
  test: {
    include: ["test/**/*.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Las pruebas comparten la misma base de datos, cola y almacenamiento reales.
    fileParallelism: false,
  },
});
