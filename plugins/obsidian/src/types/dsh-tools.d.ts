/** Hand-written ambient types for @deepseek-ai/dsh-tools (no .d.ts shipped).
 *
 * Shapes match the installed runtime (dsh-tool-cordis registration pattern,
 * audit D Q1): `parameters` is a flat JSON-Schema property DSL, `output` is
 * `{ schema: { type: 'json' }, render(args, value) }`.
 *
 * No top-level import: this file stays a global script so the ambient
 * declaration creates the module.
 */

declare module '@deepseek-ai/dsh-tools' {
  export interface ToolOutputRenderItem {
    readonly type: 'text'
    readonly text: string
  }

  export interface ToolOutputSpec {
    readonly schema: { readonly type: 'json' }
    readonly render?: (args: unknown, value: unknown) => readonly ToolOutputRenderItem[]
  }

  export interface ToolExecution {
    readonly signal: AbortSignal
  }

  export interface ToolDefinition {
    readonly name: string
    readonly description: string
    /** Flat JSON-Schema property DSL (audit D Q1). */
    readonly parameters: Readonly<Record<string, {
      readonly type?: string
      readonly required?: boolean
      readonly enum?: readonly unknown[]
      readonly description?: string
    }>>
    readonly output: ToolOutputSpec
    readonly execute?: (args: never, exec: ToolExecution) => unknown | Promise<unknown>
    readonly presentCall?: (args: unknown) => unknown
  }

  export function defineTool(definition: ToolDefinition): ToolDefinition
}
