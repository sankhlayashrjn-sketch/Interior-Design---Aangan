import type { NextConfig } from "next";

const config: NextConfig = {
  // Native/WASM database drivers are loaded from node_modules at runtime instead of being bundled.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  // The AI reads these files from disk on every call. Next only bundles files it can see imported,
  // so on a serverless host they must be named here or they would be missing at runtime.
  outputFileTracingIncludes: {
    "/*": ["./context/*.md", "./prompts/*.md"],
  },
};

export default config;
