# Team i18n Implementation

Execute internationalization implementation with the i18n team.

## Target: $ARGUMENTS
Scope: specific files, a feature area, or "audit" for a full compliance check.

## Workflow Phases

### Phase 1: Audit (Parallel)
Launch simultaneously:
- **Internationalization Expert**: i18n compliance audit
- **Code Standards Specialist**: Inline-style detection, hardcoded text, CSS class usage

### Phase 2: Implementation (Sequential)
- **Fullstack Developer**: Implement i18n fixes and text wrapping

### Phase 3: Validation (Parallel)
Launch simultaneously:
- **QA Testing**: Verify translations render correctly
- **Cross Platform Specialist**: Test across devices and browsers
- **Accessibility Compliance Checker**: RTL and language accessibility

## Before starting — detect the i18n system

Different projects use different i18n approaches. **Read `CLAUDE.md` first.** If it documents an i18n convention, follow it exactly.

Otherwise, detect the system by inspecting the project:

| Indicator | Likely system |
|-----------|---------------|
| `i18next`, `react-i18next` in package.json | i18next (key-based) |
| `react-intl`, `formatjs` | FormatJS / ICU messages |
| `vue-i18n` | Vue i18n |
| `next-intl`, `next-i18next` | Next.js variants |
| `.po` / `.pot` files, `gettext` | GNU gettext |
| `@lingui/*` | LinguiJS |
| Custom `data-i18n` attributes | In-house hash- or key-based system |
| No i18n library | Project is not internationalized yet — ask the user before adding one |

Adopt the detected system's conventions:
- Key format (nested keys, flat keys, hashes, source text as key)
- Translation file location and format (JSON, YAML, PO, TS)
- How dynamic content is handled
- How pluralization and interpolation work
- How the language is selected at runtime

**Never invent a new i18n convention.** If unclear, ask the user.

## Universal Audit Checklist

### Source Files
- [ ] All user-visible strings are wrapped in the project's translation function / component
- [ ] No hardcoded strings in JSX / templates / HTML
- [ ] No hardcoded strings in error messages shown to users
- [ ] Dynamic strings use interpolation, not concatenation
- [ ] Pluralization uses the i18n library's plural API, not `if (n === 1)` chains

### Translation Files
- [ ] New keys added to the default locale
- [ ] Placeholders / ICU syntax is valid
- [ ] Keys sorted or grouped per project convention
- [ ] No unused / orphaned keys

### Layout & RTL
- [ ] Layout uses logical properties (`margin-inline-start`) or RTL-aware classes, not hardcoded `left` / `right`
- [ ] No inline styles that would block RTL flipping
- [ ] Images, icons, and directional UI handle RTL correctly

### Accessibility
- [ ] `lang` attribute set correctly
- [ ] `dir="rtl"` applied for RTL languages
- [ ] Screen reader text localized

## Output Format

```
## i18n Compliance Report

### Summary
- Detected i18n system: [e.g., i18next]
- Files audited: [count]
- Compliance score: [%]
- Issues found: [count]
- Auto-fixable: [count]

### Coverage Status
| Category | Total | Compliant | Issues |
|----------|-------|-----------|--------|
| Components / Templates | [n] | [n] | [n] |
| JS / TS modules | [n] | [n] | [n] |
| Dynamic content | [n] | [n] | [n] |

### Issues by Severity

#### Critical (Breaks i18n)
1. **[Issue]**
   - File: [file:line]
   - Fix: [specific fix using the detected system]

#### Warnings (Should Fix)
1. **Unwrapped text**
   - File: [file:line]
   - Text: "[text]"
   - Suggested key: [key]
   - Fix: [wrapped version using project's convention]

#### Info (Best Practice)
[Same format]

### New Translation Keys
| Key | Default (English) |
|-----|-------------------|

### RTL Issues
[Files with potential RTL problems]

### Next Steps
1. [action]
2. [action]
```

## Agent Prompts

### Internationalization Expert
```
You are the Internationalization Expert.

First, read CLAUDE.md and package.json to detect the project's i18n system.
State which system you detected before doing anything else.

Then audit for compliance with THAT system's conventions:
1. Are user-visible strings wrapped using the project's translation API?
2. Are translation keys following the project's naming convention?
3. Is dynamic content handled via the library's interpolation API?
4. Is pluralization handled via the library's plural API?
5. Are translation files valid and consistent?

Return file:line references. Propose fixes in the project's actual syntax — never a generic one.
```

### Code Standards Specialist (i18n focus)
```
You are the Code Standards Specialist auditing for i18n compliance.

Focus on:
1. Inline styles (style="...") that would prevent RTL flipping
2. Hardcoded text in JavaScript / templates
3. String concatenation used to build translatable strings
4. Directional CSS (left/right) where logical properties should be used
5. Missing lang / dir attributes

For each violation:
- Exact file:line
- Current code
- Recommended fix
- Reason
```
