# Project-Specific Review Instructions (Template)

This file is a template. Copy this directory for each project and customize.

The base review instructions in `agents/AGENTS.md` are always loaded.
This file adds project-specific context.

## Language & Framework

<!-- Describe the tech stack so the reviewer understands conventions -->
- Language: Java 17
- Framework: Spring Boot 3.x
- Build: Gradle (multi-module monorepo)
- Database: PostgreSQL with Flyway migrations
- Testing: JUnit 5 + Mockito

## Project Conventions

<!-- Add project-specific rules the reviewer should enforce -->
- All REST endpoints must have OpenAPI annotations
- Database migrations must be backwards-compatible (no column drops without deprecation)
- Service layer must not directly access repositories of other modules — use the module's public API
- All public API changes require corresponding test updates

## Common Pitfalls

<!-- List recurring issues to watch for -->
- N+1 queries in JPA: always check `@EntityGraph` or `JOIN FETCH` when loading collections
- Missing `@Transactional` on service methods that do multiple writes
- Forgetting to update the API version when changing response schemas
- Nullable fields returned from database mapped to non-null Kotlin/Java types

## Tools Available

- `jira-fetch <ticket-id>` — fetch Jira issue details for context
- `glab` — GitLab CLI for git operations
- Full filesystem access to the codebase in the working directory
