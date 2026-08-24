import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/drizzle/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // The house rule from CLAUDE.md: `any` is a documented boundary cast, not a habit.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
