import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  // Not a secret — this identifies the project, it doesn't grant access.
  // Auth comes from TRIGGER_ACCESS_TOKEN / the CLI login session instead,
  // so this can be committed directly (CI has no access to local .env).
  project: "proj_faqoxguqmnoyjvmvbsoc",
  dirs: ["./src/trigger"],
  maxDuration: 900,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 2_000,
      maxTimeoutInMs: 30_000,
      randomize: true,
    },
  },
});
