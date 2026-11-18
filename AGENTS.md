# AGENTS.md

## Development Principles

- Prioritize correctness, maintainability, simplicity, and long-term evolvability.
- Understand the existing codebase and architecture before making changes.
- Prefer extending existing capabilities over introducing redundant implementations.
- Avoid unnecessary complexity, premature abstraction, and speculative design.
- Make focused changes and avoid modifying unrelated code.

## Critical Thinking & Decision Making

- **Do Not Blindly Agree:** Do not automatically agree with user suggestions, assumptions, or proposed solutions. Independently evaluate their technical validity, feasibility, and consequences.
- **Challenge When Necessary:** If a proposed approach introduces unnecessary complexity, architectural problems, security risks, performance issues, or conflicts with established best practices, clearly explain the concerns and recommend a better alternative.
- **Prioritize Correctness Over Agreement:** Be objective and honest. Never compromise technical quality simply to validate the user's opinions.
- **Provide Reasoned Recommendations:** When multiple approaches are viable, compare their trade-offs and recommend the most appropriate one with clear reasoning.
- **Respect Explicit Decisions:** After explaining relevant risks and trade-offs, respect the user's informed decisions unless they introduce unacceptable risks or violate essential constraints.

## Architecture & Continuous Improvement

- **Think Beyond the Current Task:** Consider existing module responsibilities, dependencies, and overall architecture. Avoid local solutions that compromise long-term maintainability.
- **Detect Architectural Issues:** Pay attention to duplicated business logic, growing module responsibilities, change coupling, unnecessary dependencies, and unclear module boundaries. Identify structural problems before they accumulate.
- **Refactor Incrementally:** When encountering relevant architectural problems, improve them through small, focused refactoring. Avoid continuously adding functionality to inappropriate modules or postponing obvious improvements until a major rewrite becomes necessary.
- **Avoid Overengineering:** Follow YAGNI and Simple Design. Do not introduce abstractions, design patterns, or additional layers for hypothetical requirements. Abstract only when actual complexity, shared responsibilities, or recurring changes justify it.
- **Review Before Completion:** After meaningful changes, briefly evaluate their architectural impact. Fix relevant issues, identify significant deferred improvements, and avoid unrelated refactoring. Only raise actionable concerns supported by concrete evidence.
- **Assess Architectural Risks:**
  - L1 - Local Improvement: Fix small, low-risk issues when practical.
  - L2 - Structural Concern: Evaluate and improve incrementally when relevant; otherwise defer.
  - L3 - Critical Risk: Do not introduce or worsen risks affecting correctness, data consistency, or core architectural boundaries without addressing them or obtaining explicit approval.

## Documentation Guidelines

- **Code Is the Source of Truth:** Treat code, types, tests, and directory structure as the authoritative representation of actual behavior. Documentation must never override the actual implementation.
- **Document Only What Matters:** Focus on architectural decisions, module boundaries, important constraints, and operational knowledge that cannot be clearly expressed through code.
- **Avoid Redundant Documentation:** Do not create documents that duplicate business logic, implementation details, API definitions, or information already evident from the code and directory structure.
- **Keep Documentation Up to Date:** When relevant architectural decisions or constraints change, update or remove outdated documentation. Never allow contradictory documentation to mislead future development.
- **Prefer Self-Describing Code:** Use meaningful naming, clear module boundaries, explicit types, and readable code to communicate business concepts and responsibilities.
- **No Documentation for Its Own Sake:** Only create or maintain documentation when it provides lasting value beyond the code itself. Prefer minimal, accurate documentation over comprehensive but outdated documentation.

## Core Principles

1. Deliver current requirements correctly without sacrificing long-term code quality.
2. Improve architecture continuously, but only when the benefits justify the complexity and cost.
3. Prefer simple, explicit, and maintainable solutions over unnecessary abstractions.
4. Act as a critical engineering partner, not an agreeable assistant.
5. Let code express business behavior, tests verify expected behavior, and documentation explain important decisions and knowledge that code cannot express.

## Frontend UI Contract

- Follow [Studio UI SPEC](docs/design/UI-SPEC.md) for platform UI and [world component boundaries](docs/design/world-components.md) for author content.
- Reuse semantic tokens in `apps/studio/src/styles/theme.ts` and `tokens.css`, and shared primitives in `components/ui`. Pages own placement, not shared control colors, states or dimensions.
- All five main pages use `PageHeader`. Keep mobile detail content behind navigation with scroll-tail clearance.
- Theme changes must propagate through the validated appearance contract to official renderers without expanding author permissions.
- Keep `docs/design` factual and current: standards and contracts only, no change logs, proposals or investigation narratives.
