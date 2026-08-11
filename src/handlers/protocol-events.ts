/*
 * The protocol-events lane. One handler, one binding, every registered
 * protocol contract — one Action row per named protocol event, actionType =
 * the registry's verb, actor = the registry-named wallet param.
 *
 * This is behavior indexing, not balance indexing: the lane writes Action ONLY
 * (no holder/balance entities), so it needs no schema change and a mistake here
 * can never corrupt a balance. Balances for the same contracts stay with their
 * token-standard lanes — the same address legitimately appears under both
 * bindings (e.g. Goldilocked is TrackedErc20's PRG *and* the staking hub here);
 * each binding decodes only its own event set.
 *
 * The onEvent call sites below are LITERAL one-liners, one per event NAME in
 * the union — scripts/check-onevent-bijection.mjs parses call sites with a
 * regex, so they cannot be generated in a loop. Adding a protocol whose event
 * names already exist here is registry-only; a new event name is one more line.
 */
import { indexer, type EvmOnEventContext } from "envio";

import { eventIdentity, recordAction } from "../lib/actions";
import { findProtocol } from "../registry/protocols";

/** Structural event shape shared by every protocol event this lane handles. */
interface ProtocolEvmEvent {
  params: unknown;
  srcAddress: string;
  chainId: number;
  logIndex: number | bigint;
  transaction: { hash: string; transactionIndex?: number | bigint };
  block: { timestamp: number | bigint; number: number | bigint };
}

/** Context values arrive as bigint/number/string; JSON.stringify throws on
 *  bigint (recordAction would silently drop the whole context), so everything
 *  is stringified here. */
function pickContext(
  params: Record<string, unknown>,
  keys: readonly string[] | undefined,
  contract: string,
): Record<string, string> {
  const out: Record<string, string> = { contract };
  for (const k of keys ?? []) {
    const v = params[k];
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

/** The one recording path every protocol event funnels through. */
export function recordProtocolEvent(
  eventName: string,
  event: ProtocolEvmEvent,
  context: Pick<EvmOnEventContext, "Action">,
): void {
  const contract = event.srcAddress.toLowerCase();
  const protocol = findProtocol(event.chainId, contract);
  if (!protocol) return;
  const spec = protocol.byEvent.get(eventName);
  if (!spec) return;

  const params = event.params as Record<string, unknown>;
  const actor = params[spec.actorParam];
  // A non-string actor means the registry names a param the ABI does not carry —
  // drop the row rather than write a poisoned "" wallet downstream.
  if (typeof actor !== "string" || actor.length === 0) return;

  const id = eventIdentity(event);
  const amount = spec.amountParam ? params[spec.amountParam] : undefined;
  recordAction(context, {
    actionType: spec.verb,
    actor: actor.toLowerCase(),
    primaryCollection: protocol.community,
    timestamp: id.timestamp,
    chainId: event.chainId,
    txHash: id.txHash,
    logIndex: id.logIndex,
    blockNumber: id.blockNumber,
    transactionIndex: id.transactionIndex,
    numeric1: amount === undefined || amount === null ? undefined : (amount as bigint | number | string),
    context: pickContext(params, spec.contextParams, contract),
  });
}

type OnEventArgs = { event: ProtocolEvmEvent; context: EvmOnEventContext };

/** Preload gate + funnel. The lane reads no entities, so preload has nothing to
 *  batch — write only on the real pass. */
const handle = (eventName: string) =>
  async ({ event, context }: OnEventArgs): Promise<void> => {
    if ((context as unknown as { isPreload?: boolean }).isPreload) return;
    recordProtocolEvent(eventName, event, context);
  };

// Which BINDING delivers each event follows protocolBindingPlan (gen-config):
// token-tracked protocol addresses ride their token lane, the rest ride
// ProtocolEvents. The (contract, event) pairs below must match config.yaml
// exactly — check-onevent-bijection.mjs fails an orphan on either side.
indexer.onEvent({ contract: "TrackedErc20", event: "Stake" }, handle("Stake"));
indexer.onEvent({ contract: "TrackedErc20", event: "Unstake" }, handle("Unstake"));
indexer.onEvent({ contract: "TrackedErc20", event: "Stir" }, handle("Stir"));
indexer.onEvent({ contract: "TrackedErc20", event: "Borrow" }, handle("Borrow"));
indexer.onEvent({ contract: "TrackedErc20", event: "Repay" }, handle("Repay"));
indexer.onEvent({ contract: "TrackedErc20", event: "Redeem" }, handle("Redeem"));
indexer.onEvent({ contract: "ProtocolEvents", event: "ProposalCreated" }, handle("ProposalCreated"));
indexer.onEvent({ contract: "ProtocolEvents", event: "VoteCast" }, handle("VoteCast"));
indexer.onEvent({ contract: "ProtocolEvents", event: "DelegateChanged" }, handle("DelegateChanged"));
indexer.onEvent({ contract: "ProtocolEvents", event: "Activated" }, handle("Activated"));
indexer.onEvent({ contract: "ProtocolEvents", event: "ActivationUpgraded" }, handle("ActivationUpgraded"));
indexer.onEvent({ contract: "ProtocolEvents", event: "ElectionSet" }, handle("ElectionSet"));
indexer.onEvent({ contract: "ProtocolEvents", event: "NFTBought" }, handle("NFTBought"));
indexer.onEvent({ contract: "ProtocolEvents", event: "NFTSold" }, handle("NFTSold"));
indexer.onEvent({ contract: "ProtocolEvents", event: "LoanCreated" }, handle("LoanCreated"));
indexer.onEvent({ contract: "ProtocolEvents", event: "LoanRepaid" }, handle("LoanRepaid"));
indexer.onEvent({ contract: "ProtocolEvents", event: "CertificateBought" }, handle("CertificateBought"));
indexer.onEvent({ contract: "ProtocolEvents", event: "CertificateRedeemed" }, handle("CertificateRedeemed"));
indexer.onEvent({ contract: "ProtocolEvents", event: "PullSettled" }, handle("PullSettled"));
