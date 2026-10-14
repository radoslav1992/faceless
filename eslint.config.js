import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";

// Focused on bugs rather than style: hook rules, accessibility and unsafe patterns.
export default tseslint.config(
  { ignores: ["dist", ".wrangler", "node_modules", "renderer", ".claude"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // The codebase types external rows and provider payloads loosely on purpose.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Everything the Worker imports runs when it starts, within Cloudflare's startup CPU limit: providers are called
      // with fetch, never through their SDKs (ElevenLabs' alone took most of that time).
      "no-restricted-imports": ["error", { patterns: [{ group: ["@elevenlabs/*", "@fal-ai/*", "openai"], message: "Call the provider's REST API with fetch (server/providers): SDKs slow the Worker's startup." }] }],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      // Players show generated speech and user uploads; the script and caption editor are the text alternative.
      "jsx-a11y/media-has-caption": "off",
      // VoiceSelect renders a <select>: a label around it labels that select.
      "jsx-a11y/label-has-associated-control": ["error", { controlComponents: ["VoiceSelect"], depth: 3 }],
    },
  },
  {
    files: ["public/sw.js"],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    files: ["tests/**/*.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
