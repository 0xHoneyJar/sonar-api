/*
 * collection-key-parity.test.ts — the migration safety net for sprint-bug-191.
 *
 * `primaryCollection` is score-api's join key. Deriving it from config.yaml instead of
 * a hardcoded TypeScript map is a refactor ONLY if every derived value is byte-identical
 * to what the map produced. If one value differs by a character, every historical row
 * for that collection orphans silently — no error, no missing row, just a join that
 * stops matching. That makes this a data migration wearing a refactor's clothes, and
 * this file is the gate that tells the two apart.
 *
 * PINNED_KEYS below is a verbatim copy of TRACKED_ERC721_COLLECTION_KEYS as it existed
 * at b3209fd8, the commit before the map was deleted. It is intentionally duplicated
 * rather than imported: the point is to compare against a frozen historical artifact,
 * so it must not move when the source moves.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  deriveCollectionKeys,
  collectionKeyFromComment,
} from "../src/handlers/marketplaces/tracked-nft-contracts";
import {
  patchConfigForKitchenIngest,
  sanitizeKitchenLabel,
} from "../src/kitchen/config-patcher";

const configText = readFileSync("config.yaml", "utf8");

/**
 * TRACKED_ERC721_COLLECTION_KEYS, verbatim from `main` @ b3209fd8
 * (src/handlers/tracked-erc721/constants.ts:20-78, deleted by this sprint).
 * 28 entries. DO NOT EDIT — a change here is a change to a downstream join key.
 */
const PINNED_KEYS: Readonly<Record<string, string>> = {
  "0x4b08a069381efbb9f08c73d6b2e975c9be3c4684": "mibera_tarot",
  "0x86db98cf1b81e833447b12a077ac28c36b75c8e1": "miparcels",
  "0x8d4972bd5d2df474e71da6676a365fb549853991": "miladies",
  "0x144b27b1a267ee71989664b3907030da84cc4754": "mireveal_1_1",
  "0x72db992e18a1bf38111b1936dd723e82d0d96313": "mireveal_2_2",
  "0x3a00301b713be83ec54b7b4fb0f86397d087e6d3": "mireveal_3_3",
  "0x419f25c4f9a9c730aacf58b8401b5b3e566fe886": "mireveal_4_20",
  "0x81a27117bd894942ba6737402fb9e57e942c6058": "mireveal_5_5",
  "0xaab7b4502251ae393d0590bab3e208e2d58f4813": "mireveal_6_6",
  "0xc64126ea8dc7626c16daa2a29d375c33fcaa4c7c": "mireveal_7_7",
  "0x24f4047d372139de8dacbe79e2fc576291ec3ffc": "mireveal_8_8",
  "0xed5af388653567af2f388e6224dc7c4b3241c544": "azuki",
  "0xcb28749c24af4797808364d71d71539bc01e76d4": "based_punks",
  "0x3319197b0d0f8ccd1087f2d2e47a8fb7c0710171": "hypio",
  "0xee7d1b184be8185adc7052635329152a4d0cdefa": "kemonokaki",
  "0x699727f9e01a822efdcf7333073f0461e5914b4e": "warplets",
  "0x1260f90e0b1c482b38b88f26dee17c57615d670b": "lil_bangers",
  "0x9e7a06c281355f60570e47a12650c89fe1d36ff3": "based_onchain_punks",
  "0x95bc4c2e01c2e2d9e537e7a9fe58187e88dd8019": "nodes_by_hunter",
  "0x20fd75eccd7bb9c4eb9e3bb4c09c6b382e15d63e": "veecon_2024_tickets",
  "0xfc2d7ebfeb2714fce13caf234a95db129ecc43da": "apdao_seat",
  "0x6b31859e5e32a5212f1ba4d7b377604b9d4c7a60": "lore_1_introducing_mibera",
  "0x9247edf18518c4dccfa7f8b2345a1e8a4738204f": "lore_2_honey_online_offline",
  "0xb2c7f411aa425d3fce42751e576a01b1ff150385": "lore_3_bera_kali_acc",
  "0xa12064e3b1f6102435e77aa68569e79955070357": "lore_4_bgt_network_spirituality",
  "0x6ca29eed22f04c1ec6126c59922844811dcbcdfa": "lore_5_initiation_ritual",
  "0x7988434e1469d35fa5f442e649de45d47c3df23c": "lore_6_miberamaker_design",
  "0x96c200ec4cca0bc57444cfee888cfba78a1ddbd8": "lore_7_miberamaker_design",
};

const derivation = deriveCollectionKeys(configText);

/** Flatten chainId → address → key into address → key, matching the old map's shape. */
const derived = new Map<string, string>();
for (const [, perChain] of derivation.keys) {
  for (const [address, key] of perChain) derived.set(address, key);
}

describe("AC2 — no existing primaryCollection value changes", () => {
  it("pins 28 entries, the full size of the deleted map", () => {
    expect(Object.keys(PINNED_KEYS)).toHaveLength(28);
  });

  it.each(Object.entries(PINNED_KEYS))(
    "derives %s → %s from config.yaml alone",
    (address, expected) => {
      expect(
        derived.get(address),
        `primaryCollection for ${address} would change from "${expected}" to ` +
          `"${derived.get(address)}". Every historical row for this collection joins ` +
          `on the old value and would orphan silently. This is a data migration, not a ` +
          `refactor — stop and report rather than fixing it forward.`,
      ).toBe(expected);
    },
  );

  it("changes no pinned value in aggregate (whole-map snapshot)", () => {
    const derivedSubset = Object.fromEntries(
      Object.keys(PINNED_KEYS).map((a) => [a, derived.get(a)]),
    );
    expect(derivedSubset).toEqual(PINNED_KEYS);
  });
});

describe("AC1 — every bound ERC-721 collection has a stable non-address key", () => {
  it("leaves no bound collection unnamed", () => {
    expect(
      derivation.unnamed,
      `these bound ERC-721 contracts would report a raw hex address as ` +
        `primaryCollection. Give each a "# <key>" comment in config.yaml.`,
    ).toEqual([]);
  });

  it("never derives an address-shaped key", () => {
    for (const [, key] of derived) {
      expect(key).not.toMatch(/^0x[0-9a-f]{40}$/);
    }
  });

  it("names strictly more collections than the deleted map did", () => {
    expect(derived.size).toBeGreaterThan(Object.keys(PINNED_KEYS).length);
  });
});

describe("two collections must never derive the same key", () => {
  it("finds no duplicate keys in config.yaml", () => {
    expect(
      Object.fromEntries(derivation.duplicates),
      `duplicate collection keys merge two collections into one in every downstream ` +
        `join. Rename one in config.yaml.`,
    ).toEqual({});
  });

  it("drops BOTH claimants rather than picking a winner", () => {
    const clash = [
      "chains:",
      "  - id: 8453",
      "    contracts:",
      "      - name: TrackedErc721",
      "        address:",
      "          - 0x1111111111111111111111111111111111111111 # dup_key (first)",
      "          - 0x2222222222222222222222222222222222222222 # dup_key (second)",
      "          - 0x3333333333333333333333333333333333333333 # unique_key",
      "",
    ].join("\n");
    const d = deriveCollectionKeys(clash);
    expect([...d.duplicates.keys()]).toEqual(["dup_key"]);
    // Both fall back to their raw address: distinct-but-unnamed beats silently merged.
    expect(d.keys.get(8453)?.size).toBe(1);
    expect(
      d.keys.get(8453)?.get("0x3333333333333333333333333333333333333333"),
    ).toBe("unique_key");
  });
});

describe("collectionKeyFromComment", () => {
  it.each([
    ["based_punks (deploy 12774442)", "based_punks"],
    ["azuki (canonical, verified on Etherscan)", "azuki"],
    ["mibera_tarot / mibera_quiz", "mibera_tarot"],
    ["miparcels (fracture #1)", "miparcels"],
    ["kitchen_just_t00ns (eip155:1; physical_job ingest_8782)", "kitchen_just_t00ns"],
    ["  Warplets  ", "warplets"],
    ["mireveal_4_20", "mireveal_4_20"],
    ["pudgy-penguins", "pudgy-penguins"],
  ])("reads %j as %j", (comment, expected) => {
    expect(collectionKeyFromComment(comment)).toBe(expected);
  });

  it.each([
    ["", "no comment at all"],
    ["   ", "whitespace only"],
    ["(deploy 12774442)", "starts with prose punctuation"],
    ["#1 fracture", "starts with a hash"],
    ["— em dash lead", "starts with a non-ASCII glyph"],
  ])("rejects %j (%s)", (comment) => {
    expect(collectionKeyFromComment(comment)).toBeNull();
  });
});

/**
 * AC3 — the write side and the read side must agree, or "onboard a collection" is
 * still a code change. Kitchen writes the comment; the indexer derives identity from
 * it. This closes the loop in-process; T5 proves the same path against a live belt.
 */
describe("AC3 — a Kitchen-onboarded collection is named with zero TypeScript edits", () => {
  const NEW_CONTRACT = "0x1234567890abcdef1234567890abcdef12345678" as const;

  /** Drive the real Kitchen patcher, then the real indexer-side derivation. */
  const onboard = (chainId: number, label: string) => {
    const { changed, configYaml } = patchConfigForKitchenIngest({
      configYaml: configText,
      key: { chainId, contract: NEW_CONTRACT },
      label,
    });
    expect(changed).toBe(true);
    return deriveCollectionKeys(configYaml);
  };

  it.each([
    ["just t00ns", "just_t00ns"],
    ["Wealthy Hypio Babies", "wealthy_hypio_babies"],
    ["Some  New   Community", "some_new_community"],
    ["Veecon 2025 Tickets!", "veecon_2025_tickets_"],
  ])(
    "round-trips label %j through config.yaml to collection key %j",
    (rawLabel, expectedKey) => {
      expect(onboard(8453, rawLabel).keys.get(8453)?.get(NEW_CONTRACT)).toBe(
        expectedKey,
      );
    },
  );

  it("refuses to name a collection onboarded under an already-taken key", () => {
    // "Nodes by Hunter" sanitizes to `nodes_by_hunter`, which 0x95bc4c2e… already
    // holds on Base. Both must fall back to their raw address: two collections
    // merged under one key is unrecoverable downstream, an unnamed one is not.
    const after = onboard(8453, "Nodes by Hunter");
    expect([...after.duplicates.keys()]).toEqual(["nodes_by_hunter"]);
    expect(after.keys.get(8453)?.get(NEW_CONTRACT)).toBeUndefined();
    expect(
      after.keys.get(8453)?.get("0x95bc4c2e01c2e2d9e537e7a9fe58187e88dd8019"),
    ).toBeUndefined();
  });

  it("works on chain 1 too, where Kitchen writes EthTrackedErc721", () => {
    // The two contract names are the only routing difference; identity must not care.
    expect(onboard(1, "some new community").keys.get(1)?.get(NEW_CONTRACT)).toBe(
      "some_new_community",
    );
  });

  it("never emits a label whose first token loses information (no spaces survive)", () => {
    // A surviving space silently truncates the key at the first word — the defect
    // this constraint exists to prevent.
    expect(sanitizeKitchenLabel("Wealthy Hypio Babies")).not.toContain(" ");
  });

  it("leaves the derived key of every pre-existing collection untouched", () => {
    const after = onboard(8453, "brand_new_collection");
    const flat = new Map<string, string>();
    for (const [, perChain] of after.keys) {
      for (const [address, key] of perChain) flat.set(address, key);
    }
    for (const [address, key] of Object.entries(PINNED_KEYS)) {
      expect(flat.get(address)).toBe(key);
    }
    expect(after.duplicates.size).toBe(0);
    expect(after.unnamed).toEqual([]);
  });
});

describe("config parsing hazards", () => {
  it("survives unquoted 0x addresses (YAML 1.1 would read them as hex integers)", () => {
    // The failsafe schema is the only reason this works. Without it the default schema
    // coerces a bare 0x… scalar to a number and the address is destroyed — the defect
    // that left only chains 1 and 80094 parsing in sprint-bug-190.
    const bare = [
      "chains:",
      "  - id: 8453",
      "    contracts:",
      "      - name: TrackedErc721",
      "        address:",
      "          - 0xcb28749c24af4797808364d71d71539bc01e76d4 # based_punks",
      "",
    ].join("\n");
    expect(
      deriveCollectionKeys(bare).keys.get(8453)?.get(
        "0xcb28749c24af4797808364d71d71539bc01e76d4",
      ),
    ).toBe("based_punks");
  });

  it("matches checksummed config addresses against lowercase lookups", () => {
    // Berachain's entries are checksummed in config.yaml; the handler looks up
    // event.srcAddress.toLowerCase(). A checksummed map key matches nothing (R-12).
    expect(derived.get("0x4b08a069381efbb9f08c73d6b2e975c9be3c4684")).toBe(
      "mibera_tarot",
    );
  });

  it("ignores non-collection contract definitions", () => {
    // Seaport is bound four times per chain with `# Seaport v1.x` comments. If those
    // were in scope, "seaport" would be a duplicate key and the whole map would be
    // polluted with marketplace and token addresses.
    for (const [, key] of derived) expect(key).not.toBe("seaport");
    expect(derived.has("0x0000000000000068f116a894984e2db1123eb395")).toBe(false);
  });
});
