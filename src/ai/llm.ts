// Bring-your-own-LLM plumbing. Two ways in, no hard dependency:
//   * `model` — any Vercel AI SDK model (`anthropic("…")`, `openai("…")`,
//     `ollama("…")`…). Requires the optional peer dependency `ai`.
//   * `llm` — your own function: receives a system prompt, a user prompt, a JSON
//     Schema and optional images, returns the parsed JSON object.
export type JsonSchema = Record<string, unknown>;

export type LlmRequest = {
  system: string;
  prompt: string;
  schema: JsonSchema;
  images?: Buffer[];
};

export type LlmFunction = (request: LlmRequest) => Promise<unknown>;

// A Zod schema (v3 or v4) or a plain JSON Schema object.
export type SchemaLike = JsonSchema | { safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: unknown } };

export type ModelOptions = {
  // Vercel AI SDK LanguageModel (typed loosely so `ai` stays optional).
  model?: unknown;
  llm?: LlmFunction;
};

export function isZod(schema: unknown): schema is { safeParse: (value: unknown) => any } {
  return Boolean(schema) && typeof (schema as any).safeParse === "function";
}

export async function toJsonSchema(schema: SchemaLike): Promise<JsonSchema> {
  if (!isZod(schema)) {
    return schema as JsonSchema;
  }
  // Zod v4: z.toJSONSchema. Zod v3: the optional zod-to-json-schema package.
  if ((schema as any)._zod) {
    const zod = await import_optional("zod", "Zod schemas need the `zod` package");
    const to = zod.toJSONSchema ?? zod.z?.toJSONSchema;
    if (typeof to === "function") {
      return to(schema) as JsonSchema;
    }
  }
  const converter = await import_optional("zod-to-json-schema", "Zod v3 schemas need `zod-to-json-schema` (or pass a JSON Schema)");
  return (converter.zodToJsonSchema ?? converter.default)(schema) as JsonSchema;
}

export function validate(schema: SchemaLike, value: unknown): { ok: true; data: unknown } | { ok: false; error: string } {
  if (isZod(schema)) {
    const result = schema.safeParse(value);
    return result.success ? { ok: true, data: result.data } : { ok: false, error: summarize_zod_error(result.error) };
  }
  const problems = check_json_schema(schema as JsonSchema, value, "$");
  return problems.length === 0 ? { ok: true, data: value } : { ok: false, error: problems.slice(0, 8).join("; ") };
}

// Resolves the caller's model choice into one callable.
export function resolveLlm({ model, llm }: ModelOptions): LlmFunction {
  if (llm) {
    return llm;
  }
  if (!model) {
    throw new Error("Pass `model` (a Vercel AI SDK model, e.g. anthropic(\"claude-sonnet-5-5\")) or `llm` (your own function).");
  }
  return async ({ system, prompt, schema, images }) => {
    const ai = await import_optional("ai", "Using `model` needs the optional peer dependency `ai` (npm i ai)");
    const content: any[] = [{ type: "text", text: prompt }];
    for (const image of images ?? []) {
      content.push({ type: "image", image, mediaType: "image/png", mimeType: "image/png" });
    }
    const messages = [{ role: "user", content }];

    // AI SDK >= 6: generateText + Output.object (generateObject is deprecated);
    // AI SDK 4/5: generateObject.
    if (ai_major_version() >= 6 && ai.Output?.object) {
      const result = await ai.generateText({ model, system, messages, output: ai.Output.object({ schema: ai.jsonSchema(schema) }) });
      return result.output;
    }
    const { object } = await ai.generateObject({ model, system, messages, schema: ai.jsonSchema(schema) });
    return object;
  };
}

function ai_major_version(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return parseInt(String(require("ai/package.json").version), 10) || 0;
  } catch {
    return 0;
  }
}

async function import_optional(name: string, hint: string): Promise<any> {
  try {
    return await import(name);
  } catch (error) {
    throw new Error(`${hint}. (${String((error as Error)?.message ?? error).split("\n")[0]})`);
  }
}

function summarize_zod_error(error: any): string {
  const issues: any[] = error?.issues ?? [];
  if (issues.length === 0) {
    return String(error?.message ?? error);
  }
  return issues
    .slice(0, 8)
    .map((issue) => `${(issue.path ?? []).join(".") || "$"}: ${issue.message}`)
    .join("; ");
}

// Small structural JSON Schema check (type / required / properties / items /
// enum) — enough to catch a broken extractor, not a full validator.
function check_json_schema(schema: JsonSchema, value: unknown, path: string): string[] {
  const problems: string[] = [];
  const type = schema.type as string | string[] | undefined;
  const types = Array.isArray(type) ? type : type ? [type] : [];

  if (value === null || value === undefined) {
    if (types.length > 0 && !types.includes("null")) {
      problems.push(`${path}: required value is missing`);
    }
    return problems;
  }

  const actual = Array.isArray(value) ? "array" : typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value;
  if (types.length > 0 && !types.includes(actual) && !(actual === "integer" && types.includes("number"))) {
    problems.push(`${path}: expected ${types.join("|")}, got ${actual}`);
    return problems;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    problems.push(`${path}: not one of ${JSON.stringify(schema.enum)}`);
  }

  if (actual === "object") {
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      const field = (value as Record<string, unknown>)[key];
      if (field === undefined || field === null || field === "") {
        const field_types = props[key]?.type;
        const nullable = Array.isArray(field_types) ? field_types.includes("null") : field_types === "null";
        if (!nullable) {
          problems.push(`${path}.${key}: required value is missing`);
        }
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      const field = (value as Record<string, unknown>)[key];
      if (field !== undefined && field !== null) {
        problems.push(...check_json_schema(sub, field, `${path}.${key}`));
      }
    }
  }

  if (actual === "array" && schema.items) {
    (value as unknown[]).forEach((item, index) => problems.push(...check_json_schema(schema.items as JsonSchema, item, `${path}[${index}]`)));
    if (typeof schema.minItems === "number" && (value as unknown[]).length < schema.minItems) {
      problems.push(`${path}: fewer than ${schema.minItems} items`);
    }
  }

  return problems;
}
