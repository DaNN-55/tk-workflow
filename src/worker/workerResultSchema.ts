const requiredResultFields = ["version", "taskId", "status", "artifacts", "validation", "actualCostCents", "blockers", "retry", "nextStep"] as const;

const storyboardSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "shots", "audioCues"],
  properties: {
    version: { type: "string", const: "storyboard/v1" },
    shots: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "scriptSegment", "durationSeconds", "shotType", "productionMethod", "inputBasis", "targetSpec"],
        properties: {
          id: { type: "string", minLength: 1 },
          scriptSegment: { type: "string", minLength: 1 },
          durationSeconds: { type: "number", exclusiveMinimum: 0 },
          shotType: { type: "string", enum: ["a_roll", "b_roll"] },
          productionMethod: { type: "string", minLength: 1 },
          inputBasis: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["relativePath", "sha256"],
              properties: { relativePath: { type: "string" }, sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } },
            },
          },
          targetSpec: { type: "string", minLength: 1 },
        },
      },
    },
    audioCues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "description", "startSeconds", "durationSeconds"],
        properties: {
          id: { type: "string", minLength: 1 },
          kind: { type: "string", enum: ["bgm", "sfx"] },
          description: { type: "string", minLength: 1 },
          startSeconds: { type: "number", minimum: 0 },
          durationSeconds: { type: "number", exclusiveMinimum: 0 },
        },
      },
    },
  },
} as const;

const commonResultProperties = {
  version: { type: "string", const: "worker-result/v1" },
  taskId: { type: "string" },
  status: { type: "string", enum: ["completed", "blocked", "failed"] },
  artifacts: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["artifactType", "relativePath", "sha256", "fileSize"],
      properties: {
        artifactType: { type: "string" },
        relativePath: { type: "string" },
        sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
        fileSize: { type: "integer", minimum: 0 },
      },
    },
  },
  validation: {
    type: "object",
    additionalProperties: false,
    required: ["passed", "checks"],
    properties: {
      passed: { type: "boolean" },
      checks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "passed", "detail"],
          properties: { name: { type: "string" }, passed: { type: "boolean" }, detail: { type: "string" } },
        },
      },
    },
  },
  actualCostCents: { type: "integer", minimum: 0 },
  blockers: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["code", "detail"],
      properties: { code: { type: "string" }, detail: { type: "string" } },
    },
  },
  retry: {
    type: "object",
    additionalProperties: false,
    required: ["shouldRetry", "reason"],
    properties: { shouldRetry: { type: "boolean", const: false }, reason: { type: "string" } },
  },
  nextStep: { type: "string" },
} as const;

export function workerResultJsonSchema(capability: string) {
  const isStoryboardTask = capability === "storyboard_planning";
  return {
    type: "object",
    additionalProperties: false,
    required: isStoryboardTask ? [...requiredResultFields, "storyboard"] : [...requiredResultFields],
    properties: {
      ...commonResultProperties,
      ...(isStoryboardTask ? { storyboard: { ...storyboardSchema, type: ["object", "null"] } } : {}),
    },
  };
}
