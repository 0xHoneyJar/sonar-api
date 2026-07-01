const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /postgres:\/\/[^\s"']+@/i, label: "postgres connection string with credentials" },
  { re: /nats:\/\/[^\s"']+@/i, label: "nats connection string with credentials" },
  { re: /mongodb:\/\/[^\s"']+@/i, label: "mongodb connection string with credentials" },
  { re: /AKIA[0-9A-Z]{16}/, label: "AWS access key" },
  { re: /ghp_[A-Za-z0-9]{20,}/, label: "GitHub personal access token" },
  { re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, label: "PEM private key" },
  {
    re: /(?:seed|private_key|signing_key|SONAR_SIGNING)\s*:\s*["']?[0-9a-fA-F]{64}\b/i,
    label: "64-char hex signing seed in key context",
  },
];

const RAILWAY_INTERNAL = /\.railway\.internal\b/g;

export interface ScrubResult {
  ok: boolean;
  text: string;
  violations: string[];
}

export function scrubSecrets(yamlText: string): ScrubResult {
  const violations: string[] = [];

  for (const { re, label } of SECRET_PATTERNS) {
    if (re.test(yamlText)) {
      violations.push(label);
    }
  }

  let text = yamlText.replace(RAILWAY_INTERNAL, "<railway-internal>");

  return {
    ok: violations.length === 0,
    text,
    violations,
  };
}
