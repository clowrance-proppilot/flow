import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";

export default [
  js.configs.recommended,
  eslintConfigPrettier,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-console": "off",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "desktop/renderer/**"],
  },
];
