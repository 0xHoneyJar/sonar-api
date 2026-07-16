# Metadata egress boundary (CR-004)

Sonar fetches untrusted collection metadata **only** through this module.

## Ownership

| Surface | Role |
|---|---|
| `retrieveMetadata` | Sole permitted network path for remote metadata/image bytes |
| `enrichCandidateFromRemoteMetadata` | Resolver/report adapter: partial diagnostics, never throws on hostile/missing |
| `DnsPort` / `PinnedTransportPort` | Injectable for hermetic fixtures; production pins validated public addresses |

## Security invariants

- IPv4/IPv6 deny-by-default; IPv6 public-only (`2000::/3`) minus IANA special-purpose
  ranges; IPv4-embedding / transition spaces (`::ffff:/96`, `::/96`, `64:ff9b::/96`,
  `64:ff9b:1::/48`, `2002::/16`) are decoded and denied with IPv4 policy applied to
  embedded addresses. Also deny discard/documentation/segment-routing (`100::/64`,
  `3fff::/20`, `5f00::/16`, …). IPv4 non-global specials include deprecated 6to4
  relay anycast `192.88.99.0/24` (covers `192.88.99.2/32`).
- Default allowed ports `80/443` (explicit override only for tests/approved gateways);
  every redirect revalidates port policy.
- Host authority brackets public IPv6 and includes non-default ports; SNI stays the
  bare hostname; TLS verification stays on; no second DNS resolution after pin.
- Provenance redacts userinfo/query/fragment/secrets and all non-allowlisted
  path segments (explicit structural segments + safe terminal filenames only —
  filename shapes in nonterminal positions are hashed); URI digest correlates
  the rest. Same redaction on success/partial/redirects/diagnostics/enrichment.
- Nested metadata `image` URIs are `untrusted_metadata_image_ref` only — never
  trusted/renderable; private/link-local pointers do not escape as safe fields.
- Trusted images: **PNG only**, after strict structure proof for the supported
  subset — non-interlaced color types **0, 2, 4, 6** with legal bit depths;
  IHDR → optional PLTE (truecolor 2/6 only; grayscale PLTE prohibited) →
  contiguous IDAT → IEND; exact zlib consume + scanline filter bounds; CRC on
  every chunk; reserved bit clear; unknown critical chunks rejected.
  Indexed (color type 3), interlaced, and `tEXt`/`zTXt`/`iTXt` fail closed
  (typed partial / unsupported) — trusted PNG does not need textual metadata
  and this boundary does not keep a text-decompression surface.
  JPEG/GIF/WebP/AVIF/SVG and every other image type fail closed; Accept
  headers advertise only allowlisted types (no `*/*`, no denied image MIME).
  Magic peek is diagnostic only. HTML/SVG sniffed through BOM/comments/
  polyglot/UTF-16 and anywhere in candidate image bodies; trailing polyglots
  rejected.

## Non-goals / forbidden

- Browser or Dashboard must never fetch arbitrary metadata origins.
- Resolver/report workers must not call `fetch`/`http.request` on user- or
  collection-supplied metadata URIs outside this boundary.
- No validate-then-re-resolve transport: DNS is resolved, validated, and the
  chosen public address is pinned for the TCP/TLS connection.
- TLS verification is never disabled.

## Future producers (CR-102+)

EVM tokenURI / contractURI adapters and report enrichment workers import
`retrieveMetadata` (or `enrichCandidateFromRemoteMetadata`) from this package
path. Do not add parallel HTTP clients for metadata.
