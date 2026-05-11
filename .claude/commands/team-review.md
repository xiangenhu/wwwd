# Team Code Review

Execute a comprehensive code review with the full quality team working in parallel.

## Target: $ARGUMENTS (or current working directory if not specified)

## Workflow Phases

### Phase 1: Parallel Automated Analysis
Launch simultaneously using the Task tool:
- **Static Code Analyzer**: Code quality, complexity, maintainability metrics
- **Code Smell Detector**: Anti-patterns, duplicate code, long methods
- **Security Vulnerability Scanner**: OWASP vulnerabilities, auth issues
- **Dead Code Eliminator**: Unused code, unreachable branches
- **Code Standards Specialist**: DRY violations, style consistency

### Phase 2: Comprehensive Review
- **Code Review Automation**: Synthesizes all findings into an actionable review

### Phase 3: Quality Reporting
- **Technical Debt Tracker**: Updates debt register with new findings
- **Performance Metrics Collector**: Collects and reports quality metrics

## Instructions

When executing this review:

1. **Gather Context**
   - Read `CLAUDE.md` (if present) for project-specific conventions
   - Check `package.json` / equivalent for linting, testing, and style tools
   - Identify the target scope from `$ARGUMENTS` (directory, file, PR diff, etc.)

2. **Launch parallel analysis** (Phase 1)
   - Use Task tool with 5 parallel agents
   - Each agent returns file:line-specific findings

3. **Synthesize** (Phase 2)
   - Consolidate duplicates, group by severity, prioritize

4. **Report** using the output format below

## Output Format

```
## Code Review Report

### Executive Summary
- Files Reviewed: [count]
- Issues Found: [count]
- Critical: [n] | High: [n] | Medium: [n] | Low: [n]

### Critical Issues
1. **[Issue]**
   - Location: [file:line]
   - Impact: [description]
   - Fix: [recommendation]

### High / Medium / Low
[Similar format, grouped by severity]

### Positive Findings
[Good patterns worth highlighting]

### Next Steps
1. [action]
2. [action]
```
