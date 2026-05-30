// Public boundary of the agent-over-MCP library.
//
// Re-exports from each layer's own public boundary. Consumers should
// import from here rather than reaching into folder internals.
//
// Independence contract — this module imports only from:
//   - `zod`
//   - `@modelcontextprotocol/sdk` (and subpath exports)
//   - `@opencode-ai/sdk` (and subpath exports)
//   - node built-ins
// It does not import from any other folder under `src/`.

// Kernel — framework primitives.
export * from "./kernel/index.js";

// Backend service contracts.
export * from "./backends/interfaces/index.js";

// Concrete backend: opencode.
export * from "./backends/opencode/index.js";

// Features.
export * from "./features/tasks/index.js";
export * from "./features/resources/index.js";
