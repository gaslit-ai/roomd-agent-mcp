// Opencode agent — the standalone, MCP-free, kernel-free implementation.
//
// `createOpencodeAgent(config)` returns an `OpencodeAgent`: spawn a session,
// prompt it, subscribe to its events, read its sessions, close it. The agent
// speaks agent language only — no task vocabulary, no MCP `_meta`, no service
// locator. It is a thin composition over the opencode SDK:
//   - `runtime.ts`        — the lazily-constructed v2 OpencodeClient.
//   - `session-events.ts` — the SSE event multiplexer (the `subscribe` facet).
//   - `session-reader.ts` — session list/read (the reader facet).
// `spawn` / `prompt` are this file's only original logic; everything else is
// composed.
import type { OpencodeClient, Part, ToolState } from "@opencode-ai/sdk/v2";
import type {
  AgentSessionEvents,
  AgentSessionReader,
} from "../interfaces/index.js";
import type { OpencodeAgentConfig } from "./schemas/opencode-config.js";
import type { OpencodeToolCall, PromptResult, SpawnInfo } from "./schemas/io.js";
import { createOpencodeRuntime } from "./runtime.js";
import { createOpencodeSessionEvents } from "./session-events.js";
import { createOpencodeSessionReader } from "./session-reader.js";

/**
 * One in-flight prompt turn. `result` resolves with the `PromptResult` on
 * success and REJECTS on an opencode-reported error or any unexpected failure.
 * `abort()` cancels the in-flight request and tells opencode to stop.
 */
export interface AgentRun {
  readonly result: Promise<PromptResult>;
  abort(): void;
}

/**
 * The opencode agent. Structurally an `AgentSessionEvents` (`subscribe`) and an
 * `AgentSessionReader` (`listSessions` / `readSession`), so a consumer can hand
 * the agent straight to a feature that wants either facet.
 */
export interface OpencodeAgent extends AgentSessionEvents, AgentSessionReader {
  /** Open a fresh opencode session. Returns plain data — no MCP envelope. */
  spawn(): Promise<SpawnInfo>;
  /** Run one prompt turn against a session. Returns immediately. */
  prompt(sessionId: string, message: string): AgentRun;
  /** Tear down the event stream and the runtime. Idempotent. */
  close(): Promise<void>;
}

/**
 * Split `<providerID>/<modelID>` on the first `/`. Model ids may contain
 * further slashes (e.g. `lmstudio/google/gemma-3n-e4b`), so the second segment
 * keeps the rest of the string.
 */
function splitModelId(modelString: string): {
  providerID: string;
  modelID: string;
} {
  const slash = modelString.indexOf("/");
  if (slash <= 0 || slash === modelString.length - 1) {
    throw new Error(
      `Invalid opencode model id "${modelString}". Expected "<providerID>/<modelID>".`,
    );
  }
  return {
    providerID: modelString.slice(0, slash),
    modelID: modelString.slice(slash + 1),
  };
}

/** Map an opencode tool `Part` into the typed `OpencodeToolCall`. */
function toolStateToToolCall(
  part: Extract<Part, { type: "tool" }>,
): OpencodeToolCall {
  const state = part.state;
  const status = state.status;
  let durationMs: number | undefined;
  if (
    (status === "completed" || status === "error") &&
    "time" in state &&
    state.time &&
    typeof state.time.end === "number" &&
    typeof state.time.start === "number"
  ) {
    durationMs = state.time.end - state.time.start;
  }
  return {
    tool: part.tool,
    callId: part.callID,
    input: "input" in state ? state.input : undefined,
    status,
    ...(status === "completed"
      ? {
          output: (state as Extract<ToolState, { status: "completed" }>).output,
        }
      : {}),
    ...(status === "error"
      ? { error: (state as Extract<ToolState, { status: "error" }>).error }
      : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/**
 * Build the opencode agent. Lazy: no opencode process or SDK call happens until
 * `spawn` / `prompt` / `subscribe` / `listSessions` is first invoked.
 */
export function createOpencodeAgent(config: OpencodeAgentConfig): OpencodeAgent {
  const runtime = createOpencodeRuntime(config);
  // Sessions this agent has touched — `spawn` / `prompt` write it, the reader
  // filters list/read against it (opencode's session DB is installation-wide).
  const knownSessions = new Set<string>();
  const events = createOpencodeSessionEvents(runtime);
  const reader = createOpencodeSessionReader(runtime, knownSessions);

  return {
    subscribe: events.subscribe,
    listSessions: reader.listSessions,
    readSession: reader.readSession,

    async spawn(): Promise<SpawnInfo> {
      const client = (await runtime.client()) as OpencodeClient;
      const modelParts = config.model ? splitModelId(config.model) : undefined;
      const modelForCreate = modelParts
        ? {
            id: modelParts.modelID,
            providerID: modelParts.providerID,
            ...(config.variant !== undefined ? { variant: config.variant } : {}),
          }
        : undefined;
      const created = await client.session.create(
        {
          directory: config.workspacePath,
          title: config.sessionTitle,
          ...(config.agent !== undefined ? { agent: config.agent } : {}),
          ...(modelForCreate !== undefined ? { model: modelForCreate } : {}),
        },
        { throwOnError: true },
      );
      const sessionId = created.data.id;
      knownSessions.add(sessionId);
      return {
        sessionId,
        workspace: { cwd: config.workspacePath, root: config.workspacePath },
        ...(modelParts ? { model: modelParts } : {}),
        ...(config.agent !== undefined ? { agent: config.agent } : {}),
      };
    },

    prompt(sessionId: string, message: string): AgentRun {
      knownSessions.add(sessionId);
      const ac = new AbortController();
      const result = (async (): Promise<PromptResult> => {
        const client = (await runtime.client()) as OpencodeClient;
        const modelParts = config.model
          ? splitModelId(config.model)
          : undefined;
        const modelForPrompt = modelParts
          ? { providerID: modelParts.providerID, modelID: modelParts.modelID }
          : undefined;
        const res = await client.session.prompt(
          {
            sessionID: sessionId,
            directory: config.workspacePath,
            parts: [{ type: "text", text: message }],
            ...(config.systemPrompt !== undefined
              ? { system: config.systemPrompt }
              : {}),
            ...(modelForPrompt !== undefined ? { model: modelForPrompt } : {}),
            ...(config.variant !== undefined ? { variant: config.variant } : {}),
            ...(config.agent !== undefined ? { agent: config.agent } : {}),
            ...(config.tools !== undefined ? { tools: config.tools } : {}),
          },
          { throwOnError: true, signal: ac.signal },
        );
        const info = res.data.info;
        if (info.error) {
          const err = info.error;
          const name = err.name;
          const errData = (err as { data?: { message?: string } }).data;
          const failure = new Error(errData?.message ?? String(name));
          failure.name = name;
          throw failure;
        }
        const parts = res.data.parts;
        const text = parts
          .filter(
            (p): p is Extract<Part, { type: "text" }> =>
              p.type === "text" && !p.synthetic,
          )
          .map((p) => p.text)
          .join("");
        const reasoningText = parts
          .filter(
            (p): p is Extract<Part, { type: "reasoning" }> =>
              p.type === "reasoning",
          )
          .map((p) => p.text)
          .join("");
        const toolCalls = parts
          .filter(
            (p): p is Extract<Part, { type: "tool" }> => p.type === "tool",
          )
          .map(toolStateToToolCall);
        const durationMs =
          typeof info.time.completed === "number"
            ? info.time.completed - info.time.created
            : undefined;
        return {
          sessionId,
          messageId: info.id,
          parentMessageId: info.parentID,
          agent: info.agent,
          mode: info.mode,
          model: { providerID: info.providerID, modelID: info.modelID },
          workspace: { cwd: info.path.cwd, root: info.path.root },
          tokens: info.tokens,
          cost: info.cost,
          text,
          parts: parts.map((p) => p.type),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(info.finish !== undefined ? { finishReason: info.finish } : {}),
          ...(reasoningText.length > 0 ? { reasoning: reasoningText } : {}),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        };
      })();
      return {
        result,
        abort: () => {
          ac.abort();
          // Best-effort: also tell opencode to stop. A missing session or a
          // torn-down server is fine — nothing to do.
          void runtime
            .client()
            .then((c) =>
              (c as OpencodeClient).session.abort({ sessionID: sessionId }),
            )
            .catch(() => {});
        },
      };
    },

    async close(): Promise<void> {
      await events.close();
      await runtime.close();
    },
  };
}
