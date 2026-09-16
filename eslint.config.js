import tseslint from "typescript-eslint";

// The domain layer is pure: no I/O, no transport, no Azure, no Graph. This is
// what lets the entire reconciliation engine be tested against fixtures before
// any tenant access exists.
//
// Stated as an allowlist rather than a denylist of known-bad packages. A
// denylist has to anticipate every way in, and the previous one let node:dns,
// node:tls, undici, and axios all through. Anything that is not zod and not a
// relative path into the domain layer's own siblings is refused, so a new
// dependency has to be argued for here first.
const PURITY_PATTERNS = [
  {
    regex: "^(?!zod$|\\.{1,2}/)",
    message: "The domain layer is pure: it may import zod and its own siblings, and nothing else.",
  },
  // The allowlist above admits every relative path, and a relative path can
  // still climb out of the domain layer, so the sibling half of the rule needs
  // its own pattern.
  {
    group: [
      "**/server/**",
      "**/mcp/**",
      "**/tools/**",
      "**/setup/**",
      "**/graph/**",
      "**/store/**",
      "**/scan/**",
      "**/workbook/**",
      "**/config.js",
    ],
    message:
      "The domain layer must not depend on the transport, tool, setup, Graph, store, scan, workbook, or config layers.",
  },
];

// The reconciliation engine has exactly one front door. Every stage is a plain
// named export from its own module so its unit tests can reach it, which makes
// all ten importable from anywhere unless something says otherwise; this is
// that something.
//
// The rule exists because the engine's whole claim is to be the single
// authoritative answer to what a client owes. A caller that reaches a stage
// directly can compute a second, slightly different answer to the same
// question -- "just the expected list" without the matching stage's promotions,
// say -- and the two would then drift apart with nothing to catch it. Type-only
// imports are covered as well, not exempted: index.ts re-exports every report
// type, so there is nothing a caller needs from types.js that the front door
// does not already hand them.
//
// The group matches on the import string as written rather than on the module
// it resolves to, so the `domain/` segment is deliberately not required: a
// sibling of the package writes `../reconcile/match.js` and would otherwise
// walk straight past a pattern anchored to the longer path.
//
// The fixtures are exempt for the same reason the engine's own tests are.
// A golden report on disk and the loader that reads it compute no part of
// the compliance answer, so a caller reaching them cannot produce the
// second, drifting answer this rule exists to prevent. Tools are pinned
// against that report, and the alternative is every tool test declaring its
// own fixture, which is how two fixtures start disagreeing.
//
// Both the directory and its contents are negated. The underlying matcher
// follows gitignore semantics, where a parent directory excluded by one
// pattern cannot be re-included by a later pattern that only un-ignores its
// contents; the directory itself has to be un-ignored too, or the negation
// silently does nothing.
const RECONCILE_ENTRY_POINT_PATTERN = {
  group: [
    "**/reconcile/**",
    "./reconcile/**",
    "!**/reconcile/index.js",
    "!./reconcile/index.js",
    "!**/reconcile/fixtures",
    "!./reconcile/fixtures",
    "!**/reconcile/fixtures/**",
    "!./reconcile/fixtures/**",
  ],
  message:
    "The reconciliation engine has one entry point: import reconcile and the report types from domain/reconcile/index.js, never a stage module directly.",
};

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
  // Inside the engine, where the stages are siblings and must reach each other.
  {
    files: ["src/domain/reconcile/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: PURITY_PATTERNS }],
    },
  },
  // The rest of the domain layer: pure, and a consumer of the engine like any
  // other.
  {
    files: ["src/domain/**/*.ts"],
    ignores: ["src/domain/reconcile/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [...PURITY_PATTERNS, RECONCILE_ENTRY_POINT_PATTERN] }],
    },
  },
  // Everything else, including scripts/: a fixture generator held to the same
  // import-boundary standard as the rest of the repo, even though it is
  // excluded from tsconfig.json's own build and so never ships in the
  // production image. `tests/domain/reconcile/**` is exempt because those are
  // the engine's own unit tests: proving a stage does what its brief asked for
  // requires calling that stage, and that is the one legitimate reason to
  // reach past the front door.
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"],
    ignores: ["src/domain/**", "tests/domain/reconcile/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [RECONCILE_ENTRY_POINT_PATTERN] }],
    },
  },
  {
    files: ["src/domain/**/*.ts"],
    rules: {
      // No clock and no randomness in the domain layer. The reference date is
      // an input, and a report that read the clock could not be compared
      // against a golden file, could not be reproduced from its own inputs
      // when someone disputes it, and would quietly answer a different
      // question depending on when it ran.
      //
      // These are separate rules from the purity allowlist above because they
      // have to be. That rule restricts imports, and `Date`, `performance` and
      // `Math` are globals: nothing is imported, so no import rule can see
      // them. Defaulting asOf to the current month is a one-line convenience
      // edit that would otherwise pass lint, pass typecheck, and fail only the
      // golden test, which is exactly the sort of failure a hurried reader
      // "fixes" by editing the fixture.
      "no-restricted-globals": [
        "error",
        {
          name: "Date",
          message: "The domain layer must not read the clock: the reference date is an input, so a report can be reproduced from its own inputs.",
        },
        {
          name: "performance",
          message: "The domain layer must not read the clock: the reference date is an input, so a report can be reproduced from its own inputs.",
        },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message: "The domain layer must be deterministic: the same inputs must produce the same report, down to the bytes.",
        },
      ],
    },
  },
);
