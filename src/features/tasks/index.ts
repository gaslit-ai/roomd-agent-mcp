// Tasks feature — public boundary.
//
// The feature is the "ability": a state machine over the MCP Tasks
// protocol. An implementer wires a bridge into it via `deps.start` and
// drives each task through a `TaskHandle`.
export {
  createTasksFeature,
  buildTasksFeatureCapabilities,
  TasksFeatureCapabilities,
  type TasksFeatureDeps,
} from "./feature.js";

export {
  type TaskHandle,
  type TaskFailure,
  type TaskStart,
} from "./handle.js";

export {
  TasksFeatureConfigSchema,
  TasksToolAnnotationsSchema,
  type TasksFeatureConfig,
} from "./schemas/task-config.js";
