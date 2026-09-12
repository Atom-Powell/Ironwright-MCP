import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Underscore-prefixed parameters are deliberate placeholders: a signature
      // fixed early so later tasks do not have to touch every call site.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/domain/**/*.ts"],
    rules: {
      // The domain layer is pure: no I/O, no transport, no Azure, no Graph.
      // This is what lets the entire reconciliation engine be tested against
      // fixtures before any tenant access exists.
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["**/server/**", "**/mcp/**", "**/tools/**", "**/setup/**"], message: "The domain layer must not depend on transport, tool, or setup layers." },
          { group: ["@azure/*", "@microsoft/*", "express"], message: "The domain layer must stay free of I/O dependencies." },
        ],
      }],
    },
  },
);
