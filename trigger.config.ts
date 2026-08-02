import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  // Replace with your project ref from cloud.trigger.dev → Project → Settings.
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_REPLACE_ME",
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
