// Kernel public boundary. Re-exports the framework primitives consumed by
// features and composition roots.
export {
  type AgentModule,
  type AttachContext,
} from "./module.js";

export {
  type Logger,
  type LogLevel,
  type ConsoleLoggerOptions,
  createConsoleLogger,
  noopLogger,
} from "./logger.js";

export {
  type AgentTransportHandle,
  type SessionConnector,
  createStreamableHttpTransport,
} from "./transport.js";

export {
  type AgentMcpServerOptions,
  type AgentMcpServerHandle,
  createAgentMcpServer,
} from "./server.js";

export {
  McpTransportConfigSchema,
  type McpTransportConfig,
} from "./schemas/transport-config.js";

export {
  type TokenBucketRateLimiter,
  type TokenBucketRateLimiterOptions,
  createTokenBucketRateLimiter,
} from "./rate-limiter.js";
