// ponder-runtime/src/handlers/bgt.ts
//
// PORTED FROM: src/handlers/bgt.ts (envio, source-of-truth)
// Contract: BgtToken (Berachain 80094, single deploy at BGT_TOKEN).
//
// Registered in ponder.config.mibera.ts:196 (BgtToken / BgtTokenAbi) — the
// contract + the bgt_boost_event table already existed; this port restores
// the HANDLER (the registered-but-unsubscribed gap from the RLAI ledger).
//
// Captures QueueBoost events emitted when users delegate BGT to validators.
// The deceptively-partial-frozen "delegate" action slice is restored via the
// parallel recordAction('delegate') write into ponder.action.
//
// No NATS path — this handler only writes bgt_boost_event + action.
//
// Envio→Ponder API pivot (verbatim per the already-ported handlers):
//   event.params              → event.args
//   event.chainId             → context.chain.id
//   event.srcAddress          → event.log.address
//   event.logIndex            → event.log.logIndex
//   event.block.timestamp/.number  already bigint (no BigInt() wrap)
//   context.BgtBoostEvent.set (append) → insert(bgtBoostEvent).values(...).onConflictDoNothing()
//   recordAction              → reused from ../lib/record-action
//
// Note on `pubkey`: the QueueBoost event signature is
//   event QueueBoost(address indexed account, bytes indexed pubkey, uint128 amount)
// Because `pubkey` is an `indexed bytes` param, the decoded topic is the
// keccak256 hash (a 0x hex string), NOT the raw pubkey. Envio recovers the
// real pubkey by parsing the transaction calldata (queueBoost(bytes,uint128));
// we keep that recovery verbatim. ethers is a declared dependency (^6.15.0).

import { ponder } from "ponder:registry";
import { Interface, hexlify } from "ethers";
import { bgtBoostEvent } from "../../ponder.schema";
import { recordAction } from "../lib/record-action";

const QUEUE_BOOST_INTERFACE = new Interface([
  "function queueBoost(bytes pubkey, uint128 amount)",
  "function queue_boost(bytes pubkey, uint128 amount)",
]);

const normalizePubkey = (raw: unknown): string | undefined => {
  if (typeof raw === "string") {
    return raw.toLowerCase();
  }

  if (raw instanceof Uint8Array) {
    try {
      return hexlify(raw).toLowerCase();
    } catch (_err) {
      return undefined;
    }
  }

  if (Array.isArray(raw)) {
    try {
      return hexlify(Uint8Array.from(raw as number[])).toLowerCase();
    } catch (_err) {
      return undefined;
    }
  }

  return undefined;
};

ponder.on("BgtToken:QueueBoost", async ({ event, context }) => {
  const { account, pubkey, amount } = event.args;

  if (amount === 0n) {
    return;
  }

  const accountLower = account.toLowerCase();
  let validatorPubkey = pubkey.toLowerCase();
  const transactionFrom = event.transaction.from
    ? event.transaction.from.toLowerCase()
    : accountLower;

  const inputData = event.transaction.input;
  if (inputData && inputData !== "0x") {
    try {
      const parsed = QUEUE_BOOST_INTERFACE.parseTransaction({
        data: inputData,
      });

      if (parsed) {
        const decodedPubkey = normalizePubkey(
          (parsed.args as any)?.pubkey ?? parsed.args?.[0]
        );

        if (decodedPubkey) {
          validatorPubkey = decodedPubkey;
        }
      }
    } catch (error) {
      // envio used context.log.warn; ponder's context has no log surface.
      console.warn(
        `Failed to decode queue_boost input for ${event.transaction.hash}: ${String(
          error
        )}`
      );
    }
  }

  const id = `${event.transaction.hash}_${event.log.logIndex}`;
  const timestamp = event.block.timestamp;
  const chainId = context.chain.id;

  // Append-semantics (envio used context.BgtBoostEvent.set, id is per-event):
  // insert + onConflictDoNothing matches reorg-replay idempotency.
  await context.db
    .insert(bgtBoostEvent)
    .values({
      id,
      account: accountLower as `0x${string}`,
      validatorPubkey,
      amount,
      transactionFrom: transactionFrom as `0x${string}`,
      timestamp,
      blockNumber: event.block.number,
      transactionHash: event.transaction.hash as `0x${string}`,
      chainId,
    })
    .onConflictDoNothing();

  await recordAction(context, {
    id,
    actionType: "delegate",
    actor: transactionFrom,
    primaryCollection: "thj_delegate",
    timestamp,
    chainId,
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    numeric1: amount,
    context: {
      account: accountLower,
      validatorPubkey,
      contract: event.log.address.toLowerCase(),
    },
  });
});
