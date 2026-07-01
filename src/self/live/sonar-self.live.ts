import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SonarSelf } from "../ports/sonar-self.port.js";
import type { SelfCheckOptions, SelfCheckResult } from "../domain/self-check.domain.js";
import { exitForCheck } from "../domain/self-check.domain.js";
import {
  buildBeaconDraft,
  collectUnknownProbes,
  serializeBeacon,
} from "../merge/beacon-merge.js";
import { diffBeacon, loadCommittedBeacon } from "../merge/beacon-diff.js";
import { scrubSecrets } from "../scrub/secret-scrub.js";
import { validateBeaconV2 } from "../validate/beacon-schema.validate.js";

function repoRoot(options: SelfCheckOptions): string {
  return options.repoRoot ?? process.cwd();
}

export function makeLiveSonarSelf(): SonarSelf {
  return {
    async buildDraft(options) {
      return buildBeaconDraft({
        repoRoot: repoRoot(options),
        mode: options.mode ?? "hybrid",
        proveAcvp: options.proveAcvp,
      });
    },

    async run(options) {
      const root = repoRoot(options);
      const mode = options.mode ?? "hybrid";
      const draft = await buildBeaconDraft({
        repoRoot: root,
        mode,
        proveAcvp: options.proveAcvp,
      });

      const yaml = serializeBeacon(draft);
      const scrub = scrubSecrets(yaml);
      if (!scrub.ok) {
        return {
          exitCode: 1,
          message: `secret scrub rejected output: ${scrub.violations.join(", ")}`,
        };
      }

      const schema = validateBeaconV2(draft);
      if (options.write && !schema.ok) {
        return {
          exitCode: 1,
          message: `schema invalid: ${schema.errors.join("; ")}`,
        };
      }

      const unknownProbes = collectUnknownProbes(draft);

      if (options.check) {
        const committed = loadCommittedBeacon(root);
        if (!committed) {
          return { exitCode: 1, message: "beacon.yaml not found — run pnpm self:write first" };
        }

        const drifts = diffBeacon(committed, draft, root);
        const unknownRequired =
          unknownProbes.length > 0 && !options.allowUnknown;

        const exitCode = exitForCheck({
          drift: drifts.length > 0,
          unknownRequired,
          scrubFailed: false,
          schemaInvalid: !schema.ok,
        });

        return {
          exitCode,
          drift: drifts,
          unknownProbes,
          output:
            options.format === "json"
              ? JSON.stringify({ drift: drifts, unknownProbes }, null, 2)
              : drifts.length
                ? drifts.join("\n")
                : unknownRequired
                  ? `unknown probes: ${unknownProbes.join(", ")}`
                  : "coherent",
        };
      }

      if (options.write) {
        const outPath = resolve(root, "beacon.yaml");
        writeFileSync(outPath, scrub.text, "utf8");
      }

      const output =
        options.format === "json" ? JSON.stringify(draft, null, 2) : scrub.text;

      return {
        exitCode: 0,
        output: options.write ? undefined : output,
        unknownProbes,
      };
    },
  };
}
