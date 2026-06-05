import type { ToolDef } from '@fetch/llm';

/**
 * A Tool the research agent can call. Wraps an LLM ToolDef (the schema the
 * model sees) with an `execute` that actually does the work. A tool failure
 * returns an error string the model can read — it is never fatal to the loop.
 */
export interface Tool {
  readonly def: ToolDef;
  execute(input: Record<string, unknown>): Promise<string>;
}
