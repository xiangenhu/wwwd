# Team Feature Development

Execute full feature development with coordinated team workflow.

## Feature: $ARGUMENTS

## Workflow Phases

### Phase 1: Planning (Parallel)
Launch simultaneously:
- **Architect**: System design, patterns, integration points
- **UI/UX Specialist**: Interface design, user flows, accessibility
- **Data Analyst**: Analytics requirements, tracking needs

### Phase 2: Implementation (Sequential)
- **Fullstack Developer**: Core implementation based on planning phase outputs

### Phase 3: Quality Gates (Parallel)
Launch simultaneously:
- **Code Review Automation**: Review implementation
- **Static Code Analyzer**: Quality metrics
- **Code Smell Detector**: Anti-patterns
- **Security Vulnerability Scanner**: Security issues

### Phase 4: Testing (Parallel)
Launch simultaneously:
- **Unit Test Generator**: Create unit tests
- **Integration Test Coordinator**: Integration tests
- **E2E Test Orchestrator**: End-to-end tests
- **Accessibility Compliance Checker**: WCAG compliance

### Phase 5: Documentation (Parallel)
Launch simultaneously:
- **Documentation Specialist**: Technical documentation
- **Code Documentation Generator**: JSDoc/API docs
- **Demo Documentation Specialist**: Examples and demos

### Phase 6: Deployment (Sequential)
- **DevOps Engineer**: Environment preparation
- **CI/CD Pipeline Manager**: Pipeline configuration

## Execution Instructions

Before starting:
1. **Read project conventions**: Check `CLAUDE.md`, `CONTRIBUTING.md`, and `package.json` (or equivalent) to learn the project's stack, coding standards, test framework, and linting rules. Adapt every phase to match what you find — do not assume.
2. **Identify the auth, i18n, API, and data layers** already in use, and follow those patterns rather than introducing new ones.

Then execute:

1. **Planning Phase** — Launch 3 parallel agents via Task tool. Consolidate their outputs into a single design.
2. **Implementation Phase** — Pass consolidated plan to the developer agent. Respect existing file structure.
3. **Quality Gates Phase** — Launch 4 parallel quality agents. If critical issues found, iterate on implementation before proceeding.
4. **Testing Phase** — Launch 4 parallel testing agents. Only generate tests compatible with the project's existing test framework.
5. **Documentation Phase** — Update docs only if the project has a documentation convention; otherwise skip.
6. **Deployment Phase** — Prepare deployment configuration only if the project has existing CI/CD files to update.

## Output Format

```
## Feature Development Report: [Feature Name]

### Planning Summary
- Architecture: [summary]
- UI/UX Design: [summary]
- Analytics: [tracking requirements]

### Implementation
- Files created: [list]
- Files modified: [list]
- Key changes: [summary]

### Quality Results
- Code quality: [metrics]
- Security: [status]
- Code smells: [count/status]

### Testing
- Unit tests: [count] ([coverage]%)
- Integration tests: [count]
- E2E tests: [count]
- Accessibility: [WCAG level]

### Documentation
- Updated: [list of docs]
- Created: [list of new docs]

### Deployment
- Status: [ready/blocked]
- Notes: [any deployment considerations]

### Next Steps
1. [action item]
2. [action item]
```
