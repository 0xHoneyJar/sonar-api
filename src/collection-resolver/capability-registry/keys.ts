import type { NetworkRef } from "../protocol.js";
import type { NetworkCapability, OperationCapability, OperationKind } from "./schemas.js";

export const networkIdentityKey = (network: NetworkRef): string =>
  `${network.network_namespace}:${network.network_reference}`;

export const adapterOperationKey = (
  network: NetworkRef,
  adapterId: string,
  operation: OperationKind,
): string => `${networkIdentityKey(network)}:${adapterId}:${operation}`;

export const compareDecimalUint64 = (left: string, right: string): number => {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
};

export const UINT64_MAX = "18446744073709551615";
export const UINT64_ZERO = "0";

export const isOperationEnabledAndActive = (operation: OperationCapability): boolean =>
  operation.enabled && operation.state !== "disabled";

/** Default-resolvable healthy capability: enabled and state=available (excludes degraded). */
export const isOperationEnabledAndHealthy = (operation: OperationCapability): boolean =>
  operation.enabled && operation.state === "available";

export const operationKinds = ["recognize", "prepare", "read_evidence"] as const satisfies ReadonlyArray<OperationKind>;

export const getOperation = (
  network: NetworkCapability,
  kind: OperationKind,
): OperationCapability => network.operations[kind];
