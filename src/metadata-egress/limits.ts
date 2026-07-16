/** Conservative CR-004 egress budgets (SDD §5.5 / §11.3). */

export interface MetadataEgressLimits {
  readonly max_redirects: number;
  readonly connect_timeout_ms: number;
  readonly header_timeout_ms: number;
  readonly body_timeout_ms: number;
  readonly max_compressed_bytes: number;
  readonly max_decompressed_bytes: number;
  /** Prefer HTTPS; HTTP is allowed only when the URI is already http. */
  readonly prefer_https: boolean;
  /**
   * Ports permitted for egress. Default 80/443 so public-IP port scanning is
   * not an ambient capability. Every redirect revalidates against this set.
   * Tests / approved gateways may supply an explicit controlled override.
   */
  readonly allowed_ports: ReadonlyArray<number>;
}

export const DEFAULT_ALLOWED_PORTS: ReadonlyArray<number> = [80, 443];

export const DEFAULT_METADATA_EGRESS_LIMITS: MetadataEgressLimits = {
  max_redirects: 3,
  connect_timeout_ms: 3_000,
  header_timeout_ms: 5_000,
  body_timeout_ms: 10_000,
  max_compressed_bytes: 256 * 1024,
  max_decompressed_bytes: 1_048_576,
  prefer_https: true,
  allowed_ports: DEFAULT_ALLOWED_PORTS,
};

export const EGRESS_USER_AGENT = "freeside-sonar-metadata-egress/1.0";
