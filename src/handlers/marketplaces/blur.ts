/*
 * Blur — OrdersMatched. Ethereum only; Blur never deployed to an L2.
 *
 * This is the coverage Seaport-only was missing. The 98.2% Seaport-presence
 * figure was measured on Base, where Seaport dominates; on Ethereum a large
 * share of NFT volume settles through Blur and produced no sale row at all.
 *
 * Blur is simpler than Seaport: an order carries its own `price`, `paymentToken`,
 * `collection` and `tokenId`, so there is no leg-summing and no bundle split —
 * one matched pair is one NFT.
 *
 * Order (both sides):
 *   trader, side, matchingPolicy, collection, tokenId, amount, paymentToken,
 *   price, listingTime, expirationTime, fees[], salt, extraParams
 *
 * `side` is 0 = Buy, 1 = Sell. We read the parties off `sell.trader` / `buy.trader`
 * rather than the indexed maker/taker, because either party can be the maker —
 * maker/taker says who signed first, not who sold.
 */
import { indexer } from "envio";

import { eventIdentity } from "../../lib/actions";
import { ZERO_ADDRESS } from "../../lib/mint-detection";
import { recordSale, type SaleItem } from "../../lib/sale";
import { isTrackedContract } from "../../registry/contracts";

// Field positions in the Order struct, as envio delivers it (numeric-key struct).
const TRADER = 0;
const COLLECTION = 3;
const TOKEN_ID = 4;
const AMOUNT = 5;
const PAYMENT_TOKEN = 6;
const PRICE = 7;

type BlurOrder = { readonly [index: number]: unknown };

indexer.onEvent(
  { contract: "Blur", event: "OrdersMatched" },
  async ({ event, context }) => {
    const { sell, buy } = event.params as unknown as { sell: BlurOrder; buy: BlurOrder };
    const chainId = Number(event.chainId);

    const seller = String(sell[TRADER]).toLowerCase();
    const buyer = String(buy[TRADER]).toLowerCase();
    if (seller === buyer) return; // self-trade
    if (seller === ZERO_ADDRESS || buyer === ZERO_ADDRESS) return;

    const contract = String(sell[COLLECTION]).toLowerCase();
    if (!isTrackedContract(chainId, contract)) return;

    // Blur v1's standard policies are ERC-721; the ERC-1155 policy sets amount > 1.
    // Inferring from amount is the only signal on the log — the matching policy
    // address would be exact, but that means a policy allowlist to maintain, and
    // being wrong here mislabels tokenStandard on a row whose price is still right.
    const quantity = BigInt(String(sell[AMOUNT] ?? 1n));
    const item: SaleItem = {
      contract,
      tokenId: BigInt(String(sell[TOKEN_ID])),
      quantity: quantity > 0n ? quantity : 1n,
      tokenStandard: quantity > 1n ? "ERC1155" : "ERC721",
    };

    // Both sides of a valid match carry the same price; read the sell side.
    // paymentToken 0x0 is ETH; Blur bids settle in Blur Pool (BETH), which is a
    // real ERC-20 address and is recorded as such so currencies never mix.
    const price = BigInt(String(sell[PRICE] ?? 0n));
    const paymentToken = String(sell[PAYMENT_TOKEN] ?? ZERO_ADDRESS).toLowerCase();

    recordSale(context, eventIdentity(event), {
      seller,
      buyer,
      items: [item],
      amountPaid: price,
      paymentToken,
      operator: String(event.srcAddress).toLowerCase(),
      marketplace: "blur",
      chainId,
    });
  },
);
