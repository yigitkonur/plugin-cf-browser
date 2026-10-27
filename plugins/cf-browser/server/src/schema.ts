import Ajv from 'ajv';
import { ToolError } from './cf.js';
export type Json = Record<string, any>;
export interface ToolDef { name: string; description: string; inputSchema: Json; annotations?: Json; handler?: (a: Json) => Promise<any> }
export const str = (description: string, extra: Json = {}) => ({ type: 'string', description, ...extra });
export const int = (description: string, minimum: number, maximum: number) => ({ type: 'integer', description, minimum, maximum });
export const bool = (description: string) => ({ type: 'boolean', description });
export const strArr = (description: string) => ({ type: 'array', items: { type: 'string' }, description });
export const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const en = (values: string[], description = '') => ({ type: 'string', enum: values, description });
const ajv = new Ajv({ strict: false, allErrors: true });
const compiled = new WeakMap<object, any>();
export function validate(schema: Json, args: any) {
  let check = compiled.get(schema); if (!check) { check = ajv.compile(schema); compiled.set(schema, check); }
  if (!check(args)) throw new ToolError('BAD_ARGS', ajv.errorsText(check.errors), 'Correct the arguments using this tool’s schema.');
}
