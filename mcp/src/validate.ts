// Validate a request body against the model's published input_schema (JSON
// Schema 2020-12) before anything is sent, so a typo never reaches a billable
// endpoint. Errors are phrased for an agent to fix in one step.

import { createRequire } from 'node:module';
import type { JsonSchemaObject } from './client.js';

const require = createRequire(import.meta.url);
// ajv and ajv-formats are CommonJS; load them through require for stable interop.
const Ajv2020 = require('ajv/dist/2020.js') as typeof import('ajv/dist/2020.js').default;
const addFormats = require('ajv-formats') as typeof import('ajv-formats').default;

type AjvInstance = InstanceType<typeof Ajv2020>;
type ValidateFn = ReturnType<AjvInstance['compile']>;
interface AjvError {
  keyword: string;
  instancePath: string;
  params: Record<string, unknown>;
  message?: string;
}

let ajv: AjvInstance | null = null;
const compiled = new Map<string, ValidateFn>();

function instance(): AjvInstance {
  if (!ajv) {
    const AjvCtor = ((Ajv2020 as unknown as { default?: typeof Ajv2020 }).default ?? Ajv2020) as typeof Ajv2020;
    ajv = new AjvCtor({ allErrors: true, strict: false, validateSchema: false });
    const add = ((addFormats as unknown as { default?: typeof addFormats }).default ?? addFormats) as typeof addFormats;
    add(ajv as never);
  }
  return ajv;
}

export interface ValidationResult {
  valid: boolean;
  problems: string[];
}

function fieldName(path: string): string {
  return path.replace(/^\//, '').replace(/\//g, '.') || '(body)';
}

export function validateInput(model: string, schema: JsonSchemaObject, body: Record<string, unknown>): ValidationResult {
  const key = `${model}\n${JSON.stringify(schema)}`;
  let validate = compiled.get(key);
  if (!validate) {
    const { $schema: _ignored, ...rest } = schema as Record<string, unknown>;
    validate = instance().compile(rest);
    compiled.set(key, validate);
  }
  if (validate(body)) return { valid: true, problems: [] };
  const allowed = Object.keys(schema.properties ?? {}).filter((name) => name !== 'model');
  const problems = new Set<string>();
  for (const error of (validate.errors ?? []) as AjvError[]) {
    const field = fieldName(error.instancePath);
    switch (error.keyword) {
      case 'additionalProperties':
        problems.add(
          `unknown field "${String(error.params.additionalProperty)}" for ${model}; allowed fields: ${allowed.join(', ')}`
        );
        break;
      case 'required':
        problems.add(`missing required field "${String(error.params.missingProperty)}"`);
        break;
      case 'enum':
        problems.add(`"${field}" must be one of: ${(error.params.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(', ')}`);
        break;
      case 'const':
        problems.add(`"${field}" must be ${JSON.stringify(error.params.allowedValue)}`);
        break;
      case 'dependentRequired':
        problems.add(`"${String(error.params.property)}" requires "${String(error.params.missingProperty)}"`);
        break;
      case 'pattern':
      case 'format':
        problems.add(`"${field}" ${error.message ?? 'is invalid'}${/https/.test(String(error.params.pattern ?? '')) ? ' (public https:// URL required; upload local files with upload_image)' : ''}`);
        break;
      default:
        problems.add(`"${field}" ${error.message ?? 'is invalid'}`);
    }
  }
  return { valid: false, problems: [...problems] };
}
