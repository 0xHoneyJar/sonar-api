import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeFixtureScenarioBundle,
  fixtureRegistryFromBundle,
  fixtureSigners,
  ServiceKeyRegistry,
  trustEnvelopeFixturesRoot,
} from "../trust-protocol.js";
import { OWNERSHIP_EVIDENCE_CAPABILITY } from "./constants.js";

export const loadSharedProducerConsumerFixtures = () => {
  const bundlePath = join(
    trustEnvelopeFixturesRoot(),
    "scenarios/producer-consumer.shared.json",
  );
  const bundle = decodeFixtureScenarioBundle(
    JSON.parse(readFileSync(bundlePath, "utf8")),
  );
  const baseRegistry = fixtureRegistryFromBundle(bundle);
  const keys = bundle.registry.keys.map((key) =>
    key.producer === "sonar-api"
      ? {
          ...key,
          capabilities: [...new Set([...key.capabilities, OWNERSHIP_EVIDENCE_CAPABILITY])],
        }
      : key,
  );
  return {
    bundle,
    registry: new ServiceKeyRegistry(keys),
    baseRegistry,
    signers: fixtureSigners(),
    acceptedAtMs:
      (bundle as { accepted_at_ms?: number }).accepted_at_ms ??
      Date.parse("2026-07-17T21:00:01.000Z"),
  };
};

export const fixtureCapabilityEvidenceBody = (overrides?: Partial<{
  registry_epoch: string;
  registry_sequence: string;
  deployment_id: string;
  capability_state: string;
}>) => ({
  schema_version: 1 as const,
  registry_epoch: overrides?.registry_epoch ?? "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  registry_sequence: overrides?.registry_sequence ?? "1",
  deployment_id: overrides?.deployment_id ?? "deploy-alpha-mainnet",
  capability_state: overrides?.capability_state ?? "ready",
});

export const fixtureOwnershipEvidenceBody = (overrides?: Partial<{
  deployment_id: string;
  holder_digest: string;
  observation_kind: "token_balance" | "contract_owner";
}>) => ({
  schema_version: 1 as const,
  deployment_id: overrides?.deployment_id ?? "deploy-alpha-mainnet",
  holder_digest:
    overrides?.holder_digest ??
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  observation_kind: overrides?.observation_kind ?? ("token_balance" as const),
});
