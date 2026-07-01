/**
 * Block-tick resolver for address-type classification (sonar-api#63).
 * Drains pending / due-eoa rows via eth_getCode off the transfer hot path.
 */

import { indexer, createEffect, S, type AddressType as AddressTypeEntity, type EvmOnEventContext } from "envio";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

import { classifyCode, needsRecheck } from "../lib/address-type";

const BASE_CHAIN_ID = 8453;
const RPC_URL = process.env.ENVIO_RPC_URL ?? "https://mainnet.base.org";

const baseClient = createPublicClient({
  chain: base,
  transport: http(RPC_URL),
});

function envPosInt(name: string, def: number): number {
  const n = Math.floor(Number(process.env[name]));
  return Number.isFinite(n) && n > 0 ? n : def;
}

function envPosBigInt(name: string, def: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  try {
    const n = BigInt(raw);
    return n > 0n ? n : def;
  } catch {
    return def;
  }
}

const MAX_PER_TICK = envPosInt("ADDRESS_RESOLVE_MAX_PER_TICK", 50);
const RECHECK_WINDOW_BLOCKS = envPosBigInt("ADDRESS_RESOLVE_RECHECK_BLOCKS", 43200n);
const CAUGHT_UP_THRESHOLD_BLOCKS = envPosBigInt("ADDRESS_RESOLVE_CAUGHT_UP_BLOCKS", 100n);

export const getAddressCode = createEffect(
  {
    name: "getAddressCode",
    input: {
      address: S.string,
      blockNumber: S.bigint,
    },
    output: S.string,
    cache: true,
    rateLimit: { calls: 10, per: "second" },
  },
  async ({ input }) => {
    const code = await baseClient.getBytecode({
      address: input.address as `0x${string}`,
      blockNumber: input.blockNumber,
    });
    return code ?? "0x";
  },
);

function sortById(rows: AddressTypeEntity[]): AddressTypeEntity[] {
  return [...rows].sort((a, b) => a.id.localeCompare(b.id));
}

async function collectDueRows(
  context: EvmOnEventContext,
  chainId: number,
  currentBlock: bigint,
): Promise<AddressTypeEntity[]> {
  const pending = await context.AddressType.getWhere({
    chainId: { _eq: chainId },
    type: { _eq: "pending" },
  });
  const dueEoa = await context.AddressType.getWhere({
    chainId: { _eq: chainId },
    type: { _eq: "eoa" },
    recheckAfter: { _lte: currentBlock },
  });
  return sortById([...pending, ...dueEoa]).slice(0, MAX_PER_TICK);
}

indexer.onBlock(
  {
    name: "AddressResolveBase",
    where: ({ chain }) => {
      if (chain.id !== BASE_CHAIN_ID) return false;
      return { block: { number: { _every: 10 } } };
    },
  },
  async ({ block, context }) => {
    const currentBlock = BigInt(block.number);
    const chainId = context.chain.id;

    let head: bigint;
    try {
      head = await baseClient.getBlockNumber();
    } catch {
      return;
    }
    if (head > currentBlock && head - currentBlock > CAUGHT_UP_THRESHOLD_BLOCKS) {
      return;
    }

    const due = await collectDueRows(context, chainId, currentBlock);
    if (due.length === 0) return;

    let resolvedTs: bigint;
    try {
      const blockHeader = await baseClient.getBlock({ blockNumber: currentBlock });
      resolvedTs = blockHeader.timestamp;
    } catch {
      return;
    }

    for (const row of due) {
      let code: string;
      try {
        code = await context.effect(getAddressCode, {
          address: row.address,
          blockNumber: currentBlock,
        });
      } catch {
        continue;
      }

      const type = classifyCode(code);
      const recheckAfter = needsRecheck(type)
        ? currentBlock + RECHECK_WINDOW_BLOCKS
        : undefined;

      context.AddressType.set({
        ...row,
        type,
        resolvedAtBlock: currentBlock,
        lastResolved: resolvedTs,
        recheckAfter,
      });
    }
  },
);
