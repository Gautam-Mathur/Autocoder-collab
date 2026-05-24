Goal Description
The goal is to resolve the "split-brain" architectural issues in the current Auto-Coder project and fully implement the RuFlo SPARC-based fusion architecture described in implementation.md.
To strictly comply with the requirement to NOT remove any line of code from the parent directory, we will create a completely new repository folder (Auto-Coder-Refactored) alongside the current one. We will initialize a fresh Git repository, systematically copy, merge, and restructure the codebase into this new environment, and then proceed with the Phase 1–6 agentic architectural enhancements.
Proposed Changes
Phase 0: Structural Consolidation (The Workspace Fix)
We will create a script that copies the necessary files from Auto-Coder into Auto-Coder-Refactored following these rules:
1. Root Configuration
[NEW] Auto-Coder-Refactored/pnpm-workspace.yaml: Copied directly from the current root. Updated to point to apps/* and packages/*.
[NEW] Auto-Coder-Refactored/package.json: Copied from AutoCoder/package.json.
Git Initialization: Run git init in the new directory.
2. apps/ Directory
[NEW] apps/api-server/: Copied from AutoCoder/artifacts/api-server/
[NEW] apps/web/: Copied from AutoCoder/artifacts/autocoder/ (renamed for clarity)
[NEW] apps/mockup-sandbox/: Copied from AutoCoder/artifacts/mockup-sandbox/
[NEW] apps/desktop/: Copied from AutoCoder/desktop/
3. packages/ Directory (Consolidating lib/)
[NEW] packages/: We will copy the root lib/ directory first, and then overwrite it with AutoCoder/lib/.
4. Clean-up & Wiring (Path References)
Ensure all tsconfig.json paths, workspace imports (workspace:*), and relative path imports across the codebase are updated to reflect the apps/ and packages/ structure instead of artifacts/ or lib/.

Phase 1: Foundation (Substrate & Memory)
[NEW] packages/core/src/ExecutiveMemory.ts
Implement a typed memory layer extending ctx to store structured outputs, a DecisionLog, and invalidated sets.
[NEW] packages/core/src/StageLedger.ts
Implement the Coordination Bus to intercept read/writes, enforcing a frozen OWNERSHIP map.
DriftNegotiation Loop: If an agent needs to change something outside its scope (e.g., Coder needs to modify Architect's fileGraph), it will emit a DriftEvent. Instead of a hard crash, this triggers an Amendment Request where the owning agent is invoked to negotiate the scope change.

Phase 2: Executive Layer (SPARC Integration)
[MODIFY] apps/api-server/src/modules/pipeline-orchestrator.ts
Replace the current orchestration loop with the strict SPARC sequence: Queen → Planner → Architect → System → Designer → Coder → Debugger → Reviewer → Tester.
SLM Monitor & Timeout: Wrap agents in a health-check with a monitoring system that triggers at 3000ms (to log or check generation health) and times out at 10000ms.

Phase 3: Dependency & Surgical Engine
[NEW] apps/api-server/src/modules/invalidation-engine.ts
Implement propagateInvalidation(target).
[MODIFY] apps/api-server/src/modules/agent-runner.ts
Add a shouldRun() gate to skip stable backend stages if only frontend components are invalidated.

Phase 4: Consistency Contracts (The Logic Gate)
[NEW] apps/api-server/src/modules/consistency-validator.ts
Planner → Architect Gate: Asserts all planned features have an architectural module.
System → Designer Gate: Asserts all UI data models have a system consumer.

Phase 5: Hardening & Observability
[MODIFY] apps/api-server/src/modules/ruflo/knowledge-injector.ts
Add token accounting to cap KB injection to 500 tokens for Planner/Architect stages.
[MODIFY] apps/api-server/src/modules/ruflo/slm-repair.ts
Enforce a 4096-byte patch limit. Exceeding this triggers a fallback to the template-basement.
[MODIFY] apps/api-server/src/modules/telemetry/sinks.ts
Ensure all drift events and agent decisions are piped to LangSmith/OTel.

Phase 6: Ship Gate (Final Delivery)
[MODIFY] apps/api-server/src/modules/ship-gate.ts
Ensure the 3-Layer cascade (Parser → SLM Repair → Template Fallback) is intact.
Add Semantic Pass (import resolution) and Cross-File Pass (symbol matching).
Generate the final structured JSON delivery report.
Verification Plan
Structural Verification: Run pnpm typecheck and pnpm build in the new Auto-Coder-Refactored repo. Ensure the legacy repo remains completely untouched.
Automated Testing: Run Vitest suites on the new ExecutiveMemory and StageLedger to ensure ownership bounds and DriftNegotiation are strictly enforced.
Pipeline Verification: Trigger a generation pipeline via api-server and verify the sequence strictly adheres to the SPARC model, timeouts trigger appropriately at 10000ms, and drift events trigger an amendment instead of crashing.
