import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      // `!` keeps packages/README.md out: the glob matches files as well as
      // directories, and a non-config file in the match is a startup error.
      "packages/*",
      "!packages/*.md",
      { test: { name: "repo", include: ["tests/**/*.test.ts"] } },
    ],
  },
});
