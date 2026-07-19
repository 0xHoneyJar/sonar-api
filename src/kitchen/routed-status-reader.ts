/**
 * Chain-aware CollectionStatusReader — routes Robinhood (4663) to the RH
 * sidecar Hasura reader; all other EVM chains use the monobelt reader.
 */

import type { CollectionKey } from "./types.js";
import type { CollectionStatusReader, IndexedSnapshot } from "./status.js";

export const ROBINHOOD_CHAIN_ID = 4663;

export function createRoutedCollectionStatusReader(args: {
  defaultReader: CollectionStatusReader;
  robinhoodReader: CollectionStatusReader;
  robinhoodChainId?: number;
}): CollectionStatusReader {
  const rhChain = args.robinhoodChainId ?? ROBINHOOD_CHAIN_ID;
  return {
    async readIndexedSnapshot(key: CollectionKey): Promise<IndexedSnapshot> {
      if (key.chainId === rhChain) {
        return args.robinhoodReader.readIndexedSnapshot(key);
      }
      return args.defaultReader.readIndexedSnapshot(key);
    },
  };
}

export function robinhoodGraphqlUrlFromEnv(): string | null {
  const url = process.env.ROBINHOOD_BELT_GRAPHQL_URL?.trim();
  return url || null;
}
