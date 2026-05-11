# Team Security Audit

Execute comprehensive security audit with the security team.

## Scope: $ARGUMENTS
Options: full | api | frontend | auth | dependencies

## Workflow Phases

### Phase 1: Scanning (Parallel)
Launch simultaneously:
- **Security Vulnerability Scanner**: OWASP Top 10, code vulnerabilities
- **Static Code Analyzer**: Security-related code patterns
- **Dependency Manager**: Package vulnerabilities, outdated deps

### Phase 2: Analysis (Sequential)
- **Security Specialist**: Deep analysis of all findings, compliance review

### Phase 3: Remediation Planning (Parallel)
Launch simultaneously:
- **Architect**: Architecture changes needed
- **Fullstack Developer**: Code fix recommendations

## Before starting

Read `CLAUDE.md` and the project manifest (`package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, etc.) to identify:
- Language, frameworks, and runtime
- Auth mechanism in use (JWT, session, OAuth, API key, none)
- Data storage (relational, document, key-value, files)
- Third-party services integrated
- Any existing security policies, threat model, or compliance requirements

Skip scope-specific sections that don't apply.

## Scope-Specific Focus

### full (default)
- All endpoints and routes
- All authentication flows
- All data handling
- All dependencies
- Infrastructure configuration

### api
- Endpoint security
- Input validation
- Rate limiting
- Authentication / authorization
- Response sanitization

### frontend
- XSS vulnerabilities
- CSRF protection
- Content Security Policy
- Client-side data handling
- Third-party script security

### auth
- OAuth / OIDC implementation
- Token handling (JWT, opaque, refresh)
- Session management
- Cookie security (Secure, HttpOnly, SameSite)
- Token storage and transport

### dependencies
- Package manager audit output (`npm audit`, `pip-audit`, `cargo audit`, etc.)
- Known CVEs
- Outdated packages
- License compliance
- Supply chain risks

## General Security Checklist

### Authentication
- [ ] Secrets not committed to source
- [ ] Tokens transported securely (HTTPS only)
- [ ] Session timeout / revocation implemented
- [ ] Cookies use Secure + HttpOnly + SameSite
- [ ] CSRF protection on state-changing requests

### API Security
- [ ] Rate limiting on public endpoints
- [ ] Input validation on all user input
- [ ] Output sanitization
- [ ] Proper error handling (no stack traces leaked)
- [ ] Authentication middleware on protected routes

### Data Protection
- [ ] No PII / secrets in logs
- [ ] Encryption at rest where applicable
- [ ] Encryption in transit (TLS)
- [ ] Principle of least privilege on storage credentials

### Dependencies
- [ ] No known high/critical CVEs
- [ ] Lockfile committed
- [ ] Direct deps reviewed for unmaintained packages

## Output Format

```
## Security Audit Report

### Executive Summary
- Overall Risk Level: [Critical/High/Medium/Low]
- Total Vulnerabilities: [count]
- Critical: [n] | High: [n] | Medium: [n] | Low: [n]

### Critical Findings (Immediate Action Required)
1. **[CVE/Issue ID]** - [Description]
   - Location: [file:line]
   - Impact: [description]
   - Remediation: [steps]
   - Priority: P0

### High / Medium / Low Severity Findings
[Same format]

### Dependency Vulnerabilities
| Package | Current | Vulnerable | Fixed In | Severity |
|---------|---------|------------|----------|----------|

### Compliance Status
[Only include if the project has stated compliance requirements]

### Remediation Priority
1. [High priority fix]
2. [Medium priority fix]

### Next Steps
1. [immediate action]
2. [short-term action]
```

## Agent Prompts

### Security Vulnerability Scanner
```
You are the Security Vulnerability Scanner.
Scope: ${scope}

First, read CLAUDE.md and the project manifest to learn the stack.

Scan for:
1. OWASP Top 10 vulnerabilities
2. Authentication / authorization flaws
3. Injection (SQL, XSS, command, SSRF, template)
4. Sensitive data exposure
5. Security misconfiguration
6. Broken access control
7. Insecure deserialization
8. Known-vulnerable dependencies

For each finding provide:
- CVE / CWE reference where applicable
- Exact file:line location
- Reproduction notes
- Severity (Critical/High/Medium/Low)
- Remediation recommendation
```

### Security Specialist
```
You are the Security Specialist.

Review all scanner findings and:
1. Validate each vulnerability (triage false positives)
2. Assess real-world exploitability
3. Check the project's own security conventions from CLAUDE.md
4. Verify any compliance requirements the project has declared
5. Prioritize remediation efforts
6. Recommend architectural improvements
```
