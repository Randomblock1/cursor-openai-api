export interface ClientToolSpec {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}
