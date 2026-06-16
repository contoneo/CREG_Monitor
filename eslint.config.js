import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  // Browser code (React frontend)
  {
    files: ["**/*.jsx", "api.client.js"],
    languageOptions: { globals: globals.browser, parserOptions: { ecmaFeatures: { jsx: true } } },
  },
  // Node code (backend + build/data scripts)
  {
    files: ["api.js", "*.config.js", "data/**/*.js"],
    languageOptions: { globals: globals.node },
  },
];
