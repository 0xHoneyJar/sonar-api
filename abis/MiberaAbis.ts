// Mibera-belt ABIs (sonar-ponder-migration-v1 · sprint A-1)
//
// Event signatures extracted VERBATIM from config.mibera.yaml. Using
// `parseAbi` keeps the surface compact; A-2 may switch to JSON ABIs if
// fuller decoding is needed. Coverage = the events the Mibera-belt
// handler consumes; functions/non-event items omitted (Ponder uses
// these for filter inference + decoding only).
//
// Source: ./config.mibera.yaml (envio config, treated as the canonical
// event-signature inventory per A-1 scope)
import { parseAbi } from "viem";

// MiberaLiquidBacking — loan + marketplace + RFV events (Berachain 80094)
export const MiberaLiquidBackingAbi = parseAbi([
  "event LoanReceived(uint256 loanId, uint256[] ids, uint256 amount, uint256 expiry)",
  "event BackingLoanPayedBack(uint256 loanId, uint256 newTotalBacking)",
  "event BackingLoanExpired(uint256 loanId, uint256 newTotalBacking)",
  "event ItemLoaned(uint256 loanId, uint256 itemId, uint256 expiry)",
  "event LoanItemSentBack(uint256 loanId, uint256 newTotalBacking)",
  "event ItemLoanExpired(uint256 loanId, uint256 newTotalBacking)",
  "event ItemPurchased(uint256 itemId, uint256 newTotalBacking)",
  "event ItemRedeemed(uint256 itemId, uint256 newTotalBacking)",
  "event RFVChanged(uint256 indexed newRFV)",
] as const);

// MiberaCollection — ERC721 Transfer (Berachain 80094)
// Shared event signature with TrackedErc721, GeneralMints, MiladyCollection.
export const Erc721TransferAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
] as const);

// PaddleFi — supply/pawn/liquidation (Berachain 80094)
export const PaddleFiAbi = parseAbi([
  "event Mint(address minter, uint256 mintAmount, uint256 mintTokens)",
  "event Pawn(address borrower, uint256[] nftIds)",
  "event LiquidateBorrow(address liquidator, address borrower, uint256 repayAmount, uint256[] nftIds)",
] as const);

// BgtToken — boost (Berachain 80094)
export const BgtTokenAbi = parseAbi([
  "event QueueBoost(address indexed account, bytes indexed pubkey, uint128 amount)",
] as const);

// ERC1155 — shared by CubBadges1155, CandiesMarket1155, MiberaSets, MiberaZora1155
export const Erc1155Abi = parseAbi([
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
] as const);

// GeneralMints — Transfer + Minted (Berachain 80094)
export const GeneralMintsAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event Minted(address indexed user, uint256 tokenId, string traits)",
] as const);

// Seaport — OrderFulfilled (Berachain 80094)
// Multi-chain Seaport v1.6 deploys at 0x0000000000000068F116a894984e2DB1123eB395.
export const SeaportAbi = parseAbi([
  "event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8,address,uint256,uint256)[] offer, (uint8,address,uint256,uint256,address)[] consideration)",
] as const);

// FriendtechShares — Trade (Base 8453)
export const FriendtechSharesAbi = parseAbi([
  "event Trade(address trader, address subject, bool isBuy, uint256 shareAmount, uint256 ethAmount, uint256 protocolEthAmount, uint256 subjectEthAmount, uint256 supply)",
] as const);

// TrackedErc20 — Transfer (Base 8453 — MiberaMaker333)
export const Erc20TransferAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
] as const);
