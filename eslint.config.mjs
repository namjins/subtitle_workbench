import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

// Replaces the previous eslint-config-next setup. The app is a plain Vite SPA
// with a Node CLI/bridge alongside it, so there is no Next.js to configure for.
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", ".tmp/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Browser UI.
    files: ["app/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // Node CLI, bridge and tests.
    files: ["lib/**/*.mjs", "tools/**/*.mjs", "tests/**/*.mjs", "*.mjs", "*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
