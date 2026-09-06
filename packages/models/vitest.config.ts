import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@meco/models",
    // The first request over the whole Catalogue creates five ONNX sessions
    // and runs four Models on a 1280x1600 photograph; on a loaded laptop that
    // is past Vitest's 5 s default, and a timeout is not a finding here.
    testTimeout: 30_000,
  },
});
