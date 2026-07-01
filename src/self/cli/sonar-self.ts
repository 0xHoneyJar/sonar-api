import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Cli } from "incur";
import { makeLiveSonarSelf } from "../live/sonar-self.live.js";

const sharedOptions = z.object({
  mode: z.enum(["offline", "live", "hybrid"]).default("hybrid"),
  "allow-unknown": z.boolean().optional(),
  "prove-acvp": z.boolean().optional(),
  verbose: z.boolean().optional(),
  format: z.enum(["json", "yaml"]).default("yaml"),
});

export function buildSonarSelfCli(self = makeLiveSonarSelf()) {
  let exitCode: number | undefined;

  function bindCommand(check: boolean, write: boolean) {
    return {
      options: sharedOptions,
      async run(c: {
        options: z.infer<typeof sharedOptions>;
        ok: (data: unknown) => unknown;
      }) {
        const result = await self.run({
          check,
          write,
          mode: c.options.mode,
          allowUnknown: c.options["allow-unknown"],
          proveAcvp: c.options["prove-acvp"],
          verbose: c.options.verbose,
          format: c.options.format,
        });

        if (result.exitCode !== 0) {
          if (result.message) {
            console.error(result.message);
          }
          if (result.drift?.length) {
            for (const line of result.drift) {
              console.error(line);
            }
          }
          if (result.unknownProbes?.length) {
            console.error(`unknown probes: ${result.unknownProbes.join(", ")}`);
          }
        } else if (c.options.verbose && result.message) {
          console.error(result.message);
        }

        if (result.output) {
          process.stdout.write(`${result.output}\n`);
        } else if (write && result.exitCode === 0) {
          process.stdout.write("beacon.yaml written\n");
        } else if (check && result.exitCode === 0) {
          process.stdout.write("coherent\n");
        }

        exitCode = result.exitCode;
        return c.ok({
          exitCode: result.exitCode,
          drift: result.drift,
          unknownProbes: result.unknownProbes,
        });
      },
    };
  }

  const cli = Cli.create("sonar-self", {
    version: "0.1.0",
    description:
      "Territory-derived beacon emitter and drift-check for sonar-api. Introspects config, GraphQL, and Railway; emits or validates root beacon.yaml v2.",
  });

  cli.command("emit", {
    description: "Build beacon draft and print to stdout (default).",
    ...bindCommand(false, false),
  });

  cli.command("check", {
    description: "Diff committed beacon.yaml against live territory. Exit 0=coherent, 1=drift, 2=inconclusive.",
    ...bindCommand(true, false),
  });

  cli.command("write", {
    description: "Validate and write root beacon.yaml from territory probes.",
    ...bindCommand(false, true),
  });

  return { cli, getExit: () => exitCode };
}

const { cli, getExit } = buildSonarSelfCli();
export default cli;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let incurCode = 0;
  const args = process.argv.slice(2);
  const normalized =
    args.length > 0 && args[0].startsWith("-")
      ? ["emit", ...args]
      : args.length === 0
        ? ["emit"]
        : args;

  await cli.serve(normalized, { exit: (code) => { incurCode = code; } });
  process.exit(incurCode !== 0 ? incurCode : (getExit() ?? 0));
}
