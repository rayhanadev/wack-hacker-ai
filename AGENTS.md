This document defines mandatory rules for all AI coding agents working on this codebase. Code that violates these rules is considered incomplete.

## Quality Gates (ALL MUST PASS)

Before any code is considered complete, it MUST pass all quality gates:

```bash
# 1. Type checking - zero errors allowed
bun run typecheck

# 2. Linting - zero errors allowed
bun run lint

# 3. Tests - required only when test harness is configured
# See .agents/skills/setup-tests/SKILL.md
bun run test

# 4. Coverage - required only when test harness is configured
# See .agents/skills/setup-tests/SKILL.md
bun run test:coverage

# 5. Documentation - must be updated if behavior changes
```

**NO EXCEPTIONS.** Code that fails any gate is not finished.

---

## Centralized Configuration and Errors

### Environment Variables

**NEVER use `process.env` directly in new business code.** Environment variables must go through `src/env.ts` (`AppEnv`).

```typescript
import { env } from "./env";

// WRONG - Never do this
const token = process.env.DISCORD_TOKEN;

// RIGHT - Access env through centralized config
const token = env.DISCORD_TOKEN;
```

**Adding new environment variables:**

1. Add the field to `src/env.ts`
2. Add the field to `.env.example` (or equivalent env setup docs)
3. Update any documentation that references environment setup

### Error Modeling

**NEVER create ad-hoc domain errors inline.** Keep domain failures centralized and typed.

**Adding new error models:**

1. Define in `src/errors.ts` (create it if needed)
2. Use stable typed shapes (discriminated unions or typed classes)
3. Export from `src/index.ts` if public
4. Document when to use each error type in JSDoc

---

## TypeScript Rules

### NEVER Use `any` or `unknown` as Type Escape Hatches

**NEVER use `any` or `unknown` to bypass type errors.** This is a hard rule with no exceptions.

#### When `unknown` IS allowed:

- Validation function entry points (e.g., `function validate(data: unknown): MyType`)
- Schema definitions for genuinely dynamic data (prefer runtime schema validation)
- Catch block error parameters (`catch (error: unknown)`)
- Index signatures for extensible objects (e.g., `[key: string]: unknown`)

#### When `unknown` is NOT allowed:

- As a lazy replacement for defining proper types
- For function parameters where the type is knowable
- For return types that should be specific
- Anywhere you would have used `any` before

Instead:

- Investigate the actual types from library `.d.ts` files
- Use proper type imports from the library
- Create proper interface definitions if types are missing
- Use generics for flexible but type-safe APIs
- Fix the root cause of type mismatches

```typescript
// WRONG - Never do this
const data = response as any;
const config = { token: "abc" } as any;
function process(items: unknown[]): void {} // lazy unknown

// RIGHT - Use proper types
import type { ResponseData } from "library";
const data: ResponseData = response;

// RIGHT - unknown only for validation entry points
function validateInput(data: unknown): MyType {
  return MySchema.parse(data); // Schema validates and returns typed result
}

// RIGHT - Use generics for flexible APIs
function process<T extends BaseItem>(items: T[]): T[] {}
```

### Type Assertions

Avoid type assertions (`as Type`) unless absolutely necessary. When needed:

- Prefer `satisfies` operator for type checking without widening
- Document why the assertion is safe
- Never use `as any` or `as unknown as Type` chains

### Explicit Return Types

All public functions MUST have explicit return types:

```typescript
// WRONG
export function getUser(id: string) {
  return db.query.users.findFirst({ where: eq(users.id, id) });
}

// RIGHT
export async function getUser(id: string): Promise<User | undefined> {
  return db.query.users.findFirst({ where: eq(users.id, id) });
}
```

---

## Dependencies

- Prefer existing dependencies over adding new ones
- No duplicate functionality across modules

---

## Agent Workflow Rules

### Before Writing Code

1. **Understand the existing patterns** - Read similar files first
2. **Check for existing implementations** - Don't duplicate
3. **Verify the spec** - Reference issue/task details and README docs

### While Writing Code

1. **Follow existing patterns** - Match the codebase style
2. **When tests are configured, write tests alongside implementation** - Not after
3. **Add JSDoc as you go** - Not as a separate pass
4. **Run typecheck frequently** - Catch errors early

### After Writing Code

1. **Run all enabled quality gates** - typecheck/lint always; test/coverage when configured
2. **Fix ALL errors** - No skipping, no suppressing
3. **Verify exports** - Ensure public API is correct

### Verification Checklist

Before marking ANY task complete:

- [ ] `bun run typecheck` passes with 0 errors
- [ ] `bun run lint` passes with 0 errors
- [ ] If test harness is configured: `bun run test` passes with 0 failures
- [ ] If test harness is configured: `bun run test:coverage` meets configured threshold (currently 100%)
- [ ] All public APIs have JSDoc documentation
- [ ] No `any` types anywhere
- [ ] No `@ts-ignore` or `@ts-expect-error` comments
- [ ] No `eslint-disable` comments
- [ ] README.md updated if public API changed
- [ ] AGENTS.md updated if internal patterns changed
- [ ] docs/ updated if architecture changed

---

## Parallelization with Subagents

For large tasks, use subagents to parallelize work:

### When to Use Subagents

- Testing: One subagent per module/feature area
- Documentation: One subagent per doc area
- Features spanning multiple modules
- Any task with independent subtasks

### Subagent Prompt Requirements

When delegating to subagents, include:

1. **TASK** - Specific, atomic goal
2. **CONTEXT** - File paths, existing patterns
3. **REQUIREMENTS** - What must be included
4. **CONSTRAINTS** - What must NOT be done
5. **VERIFICATION** - How to confirm completion

### Subagent Coordination

```
Phase 1 (Sequential): Setup/infrastructure
Phase 2 (Parallel): Independent implementation tasks
Phase 3 (Sequential): Integration and verification
```

---

## Forbidden Patterns

These patterns are NEVER allowed:

```typescript
// Type escape hatches
as any
as unknown as Type
@ts-ignore
@ts-expect-error
eslint-disable

// Empty error handling
catch (e) {}
catch (e) { /* ignore */ }

// Lazy typing
items: any[]
data: object
config: {}

// Type assertions without justification
value as SomeType  // Why is this safe?
```

---

## File Naming Conventions

- Source files: `kebab-case.ts` (e.g., `daemon-tokens.ts`)
- Test files: `kebab-case.test.ts` (e.g., `daemon-tokens.test.ts`)
- Type files: `kebab-case.ts` or `types.ts`
- Index files: `index.ts` (entrypoint or barrel only; avoid mixed responsibilities)

---

## Summary

Every piece of code in this repository must be:

1. **Error-free** - Passes typecheck and lint
2. **Well-typed** - No `any`, explicit return types
3. **Documented** - JSDoc on all public APIs
4. **Tested** - Meets configured coverage thresholds, all tests pass
5. **Consistent** - Follows existing patterns
6. **Not duplicated** - Reuse existing code

**If your code doesn't meet ALL these criteria, it's not done.**
