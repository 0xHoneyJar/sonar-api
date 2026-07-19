import {
  compileStagedReconcilerSeparationV1,
  type ReconciliationPrincipalV1,
} from "../src/truth-contract/index.js";
import { fixtureSigners } from "../src/collection-resolver/trust-protocol.js";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key === undefined || value === undefined || !key.startsWith("--")) {
    throw new Error("invalid staged reconciler harness arguments");
  }
  args.set(key.slice(2), value);
}
const required = (key: string): string => {
  const value = args.get(key);
  if (value === undefined) throw new Error(`missing --${key}`);
  return value;
};

const signer = fixtureSigners().sonarRotated;
const producer: ReconciliationPrincipalV1 = {
  service_id: "sonar-producer",
  key_id: fixtureSigners().sonarPrimary.keyId,
  process_id: required("producer-process-id"),
  artifact_directory: required("producer-directory"),
  network_boundary: "producer-vpc",
};
const reconciler: ReconciliationPrincipalV1 = {
  service_id: "sonar-staged-reconciler",
  key_id: signer.keyId,
  process_id: `pid-${process.pid}`,
  artifact_directory: required("reconciler-directory"),
  network_boundary: "reconciler-vpc",
};
const attestation = compileStagedReconcilerSeparationV1(
  {
    environment: "development",
    producer,
    reconciler,
    producer_pid: required("producer-pid"),
    reconciler_pid: String(process.pid),
    forbidden_authority_key_ids: [
      required("reviewer-key-id"),
      required("randomness-witness-key-id"),
      fixtureSigners().orderingReplay.keyId,
    ],
    launched_at: required("launched-at"),
    expires_at: required("expires-at"),
  },
  signer,
);
process.stdout.write(`${JSON.stringify(attestation)}\n`);
