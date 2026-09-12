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
      //
      // Stated as an allowlist rather than a denylist of known-bad packages. A
      // denylist has to anticipate every way in, and the previous one let
      // node:dns, node:tls, undici, and axios all through. Anything that is not
      // zod and not a relative path into the domain layer's own siblings is
      // refused, so a new dependency has to be argued for here first.
      "no-restricted-imports": ["error", {
        patterns: [
          {
            regex: "^(?!zod$|\\.{1,2}/)",
            message: "The domain layer is pure: it may import zod and its own siblings, and nothing else.",
          },
          // The allowlist above admits every relative path, and a relative path
          // can still climb out of the domain layer, so the sibling half of the
          // rule needs its own pattern.
          {
            group: ["**/server/**", "**/mcp/**", "**/tools/**", "**/setup/**"],
            message: "The domain layer must not depend on transport, tool, or setup layers.",
          },
        ],
      }],
    },
  },
);
