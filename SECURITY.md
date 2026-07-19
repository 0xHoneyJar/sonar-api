# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability, please follow these steps:

### For Private Disclosure (Preferred)

1. **Do NOT create a public GitHub issue**
2. **Email the security team** at jani@0xhoneyjar.xyz with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact assessment
   - Any suggested fixes (optional)

3. **Expect a response within 48 hours**

4. **Coordinate disclosure timeline** with maintainers

### What to Report

- Authentication/authorization bypasses
- Injection vulnerabilities (command, code, etc.)
- Secrets exposure risks
- Insecure default configurations
- Agent prompt injection vectors
- MCP server security issues

### What NOT to Report

- Vulnerabilities in dependencies (report to upstream)
- Social engineering attacks
- Physical security issues
- Denial of service (unless critical)

## Security Measures

### Automated Security Scanning

This repository uses:

- **TruffleHog** - Secret detection
- **GitLeaks** - Secret scanning
- **Dependabot** - Dependency vulnerability alerts
- **CodeQL** - Static code analysis

### Branch Protection

The `main` branch is protected with:

- Required pull request reviews
- Required status checks
- No force pushes
- No deletions

### Secrets Management

- All secrets must use environment variables
- No hardcoded credentials in code
- `.env` files are gitignored
- Secret rotation procedures documented

### Sonar→Score Truth Contract

- Normative v1 uses RFC 8785 JCS, SHA-256, and Ed25519 through the independently
  pinned vendored trust protocol. Algorithm fallback is forbidden.
- External signed roots must enter through `verifyTruthBundleRootBytes`, which
  enforces the byte ceiling, canonical JSON, environment/key binding, a trusted
  generation high-water mark, and an injected trusted clock.
- Committed signing vectors are fixture-only public test material. Production
  private keys must be non-exportable KMS/HSM keys behind the `TruthSigner`
  service and require a separately approved activation path.
- The detached Loa promotion receipt authorizes implementation only. It does
  not authorize production signing, registry publication, deployment, Score
  graduation, index/database mutation, restart, wipe, or floor changes.

## Security Best Practices for Contributors

### When Adding New Features

1. **Never commit secrets** - Use environment variables
2. **Validate all inputs** - Especially in agent prompts
3. **Sanitize outputs** - Prevent information disclosure
4. **Review MCP integrations** - External APIs need security review

### When Using MCP Servers

1. Use minimal required permissions
2. Validate data from external sources
3. Handle errors without exposing sensitive info
4. Test with mock data before production

## Vulnerability Disclosure Timeline

| Day | Action |
|-----|--------|
| 0 | Vulnerability reported |
| 1-2 | Acknowledgment sent |
| 3-7 | Initial assessment complete |
| 8-30 | Fix developed and tested |
| 31-45 | Coordinated disclosure (if approved) |

## Security Updates

Security updates are announced via:

- GitHub Security Advisories
- CHANGELOG.md updates
- Discord announcements (for critical issues)

---

Thank you for helping keep Loa secure!
