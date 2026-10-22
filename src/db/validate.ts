/**
 * Input validation (AL4 1.4.4; AL6 rule 1, AC-15, AC-38, AC-39, AC-51, AC-53 .. AC-55).
 * Every public input is re-validated with its contract schema. Only the parsed value is
 * returned, never the raw input. Issues carry paths and Zod messages only (no input values,
 * AC-54). No function here ever throws.
 */
import type { z } from 'zod';
import {
  PlaceRefInputSchema,
  SaveListingPageInputSchema,
  SavePlaceDetailsInputSchema,
  TagRefInputSchema,
  findCommentRuleIssues,
  type PlaceRefInput,
  type SaveListingPageInput,
  type SavePlaceDetailsInput,
  type StoreIssue,
  type TagRefInput,
} from '../../contracts/storage.schema';
import { PlaceDetailsSchema } from '../../contracts/wikimapia-client.schema';
import { toFailureIssues } from '../wikimapia/issues';
import { invalidData } from './failures';
import type { Validated } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function samePath(a: readonly (string | number)[], b: readonly (string | number)[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

function fallback<T>(message: string): Validated<T> {
  return { ok: false, failure: invalidData([{ path: [], message }]) };
}

function plain<T>(schema: z.ZodType<T>, input: unknown, shapeMessage: string): Validated<T> {
  try {
    const r = schema.safeParse(input);
    if (r.success) return { ok: true, value: r.data };
    return { ok: false, failure: invalidData(toFailureIssues(r.error.issues)) };
  } catch {
    return fallback(shapeMessage);
  }
}

export function validateListingInput(input: unknown): Validated<SaveListingPageInput> {
  return plain(
    SaveListingPageInputSchema,
    input,
    'input does not have the shape of a Listing Save',
  );
}

/** Attaches `commentNum` / `placeId` from the Comment rules to the matching issues. */
function enrich(issues: readonly StoreIssue[], input: unknown): StoreIssue[] {
  const d = PlaceDetailsSchema.safeParse(isRecord(input) ? input.details : undefined);
  if (!d.success) return [...issues];
  const rules = findCommentRuleIssues(d.data);
  return issues.map((issue) => {
    const rule = rules.find((r) => samePath(issue.path, ['details', ...r.path]));
    if (rule === undefined) return issue;
    const enriched: StoreIssue = { path: issue.path, message: issue.message };
    if (rule.commentNum !== undefined) enriched.commentNum = rule.commentNum;
    if (rule.placeId !== undefined) enriched.placeId = rule.placeId;
    return enriched;
  });
}

export function validateDetailsInput(input: unknown): Validated<SavePlaceDetailsInput> {
  const shapeMessage = 'input does not have the shape of a Details Save';
  try {
    const r = SavePlaceDetailsInputSchema.safeParse(input);
    if (r.success) return { ok: true, value: r.data };
    const issues = toFailureIssues(r.error.issues);
    return { ok: false, failure: invalidData(enrich(issues, input)) };
  } catch {
    return fallback(shapeMessage);
  }
}

export function validatePlaceRef(input: unknown): Validated<PlaceRefInput> {
  return plain(PlaceRefInputSchema, input, 'input does not have the shape of a place reference');
}

export function validateTagRef(input: unknown): Validated<TagRefInput> {
  return plain(TagRefInputSchema, input, 'input does not have the shape of a tag reference');
}
