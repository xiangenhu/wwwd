# Team Performance Optimization

Execute full performance analysis and optimization with the performance team.

## Target: $ARGUMENTS
Scope: specific files/directories or "full" for entire codebase

## Workflow Phases

### Phase 1: Measurement (Parallel)
Launch simultaneously:
- **Performance Metrics Collector**: Collect baseline metrics
- **Performance Test Runner**: Run performance benchmarks
- **Load Test Simulator**: Simulate concurrent user load

### Phase 2: Analysis (Parallel)
Launch simultaneously:
- **Code Optimization Specialist**: Algorithm and code efficiency
- **Loading Performance Specialist**: Page load and resource optimization
- **Data Analyst**: Performance data analysis and patterns

### Phase 3: Implementation (Sequential)
- **Fullstack Developer**: Implement optimizations
- **Architecture Refactoring Specialist**: Larger structural changes

### Phase 4: Validation (Parallel)
Launch simultaneously:
- **Performance Test Runner**: Re-run benchmarks
- **Load Test Simulator**: Verify improvements under load

## Before starting

Read `CLAUDE.md` and `package.json` (or equivalent) to detect:
- What the app is (frontend, backend, full-stack, CLI, library)
- Which frameworks and runtimes are used
- Any existing performance budgets, profiling tools, or benchmarks
- The project's deployment target (affects which metrics matter)

Adapt the focus areas below to what actually applies.

## Performance Focus Areas

### Frontend (if applicable)
- Page load time
- First Contentful Paint (FCP)
- Largest Contentful Paint (LCP)
- Time to Interactive (TTI)
- Bundle size
- Image optimization
- Resource caching

### Backend (if applicable)
- API response times
- Database query optimization
- N+1 queries
- Memory and CPU usage
- Connection pooling
- Response compression

### External Services (if applicable)
- Third-party API latency
- Rate limit handling
- Caching strategy for upstream calls
- Batch / streaming opportunities

## Performance Budgets

If the project defines its own budgets, use those. Otherwise apply these defaults and flag them as assumed:

| Metric | Default Target |
|--------|----------------|
| Page Load | < 3s |
| Cached API Response | < 500ms |
| Uncached API Response | < 2s |
| Database Query | < 100ms |
| Cache Hit Rate | > 80% |

## Analysis Checklist

### Code Efficiency
- [ ] Algorithm complexity review
- [ ] Loop and iteration optimization
- [ ] Memory leak detection
- [ ] Async/await patterns
- [ ] Promise handling

### Frontend
- [ ] Bundle analysis
- [ ] Lazy loading / code splitting
- [ ] Image optimization
- [ ] CSS optimization
- [ ] JavaScript minification

### Backend
- [ ] Query optimization
- [ ] N+1 detection
- [ ] Connection pooling
- [ ] Response compression
- [ ] Caching strategy

## Output Format

```
## Performance Optimization Report

### Executive Summary
- Overall Performance Score: [score/100]
- Key Bottlenecks Identified: [count]
- Optimization Potential: [estimate]

### Baseline Metrics
| Metric | Before | Target | Gap |
|--------|--------|--------|-----|

### Identified Bottlenecks

#### Critical (>50% impact)
1. **[Bottleneck]**
   - Location: [file:line]
   - Impact: [description]
   - Root Cause: [analysis]
   - Recommended Fix: [solution]
   - Expected Improvement: [estimate]

#### Moderate / Minor
[Same format, lower priority]

### Optimization Plan
| Priority | Optimization | Effort | Impact | ROI |
|----------|-------------|--------|--------|-----|

### Validation Results (After)
| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|

### Long-term Recommendations
1. [recommendation]
```

## Agent Prompts

### Code Optimization Specialist
```
You are the Code Optimization Specialist.

First, read CLAUDE.md and package.json (or equivalent) to understand the stack.

Analyze code for:
1. Algorithm complexity (Big-O)
2. Unnecessary iterations / repeated work
3. Memory allocation patterns
4. Async/await inefficiencies
5. Promise anti-patterns
6. Resource cleanup

Provide file:line references and specific optimization suggestions grounded in the project's actual framework and conventions.
```

### Loading Performance Specialist
```
You are the Loading Performance Specialist.

First, determine whether this project has a frontend at all. If not, skip.

Otherwise analyze:
1. Initial page load sequence
2. Resource loading order
3. Critical rendering path
4. JavaScript bundle size
5. CSS delivery
6. Third-party script impact
7. Loading feedback UI

Use the project's own build tools (webpack, Vite, Rollup, etc.) to gather data.
```
