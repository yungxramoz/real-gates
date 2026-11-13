// JSON schemas for the read-only steps. Their sessions start with --json-schema, so the verdict
// comes back as the result event's `structured_output` and the runner writes any files itself
// (those sessions have no Edit/Write tools at all).

import { REVIEW_CATEGORIES } from './learn.mjs';

const score = { type: 'integer', minimum: 0, maximum: 10 };
/** The scores object for a work type's rubric: exactly those keys. No rubric: any object (it is left out). */
const scoresFor = (rubric) => (rubric?.length ? { type: 'object', properties: Object.fromEntries(rubric.map((r) => [r, score])), additionalProperties: false } : { type: 'object' });

/** The review verdict schema for an item whose work type has this rubric. */
export const reviewSchema = (rubric) => ({
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes'] },
    blocking: {
      type: 'array',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, line: { type: 'integer' }, issue: { type: 'string' }, fix: { type: 'string' }, category: { type: 'string', enum: REVIEW_CATEGORIES }, cause: { type: 'string' } },
        required: ['file', 'issue', 'fix', 'category'],
      },
    },
    non_blocking: { type: 'array', items: { type: 'string' } },
    acceptance: { type: 'array', items: { type: 'object', properties: { ac: { type: 'string' }, status: { type: 'string', enum: ['met', 'not_met', 'owner'] }, evidence: { type: 'string' } }, required: ['ac', 'status'] } },
    scores: scoresFor(rubric),
    design: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['verdict', 'blocking', 'summary'],
});

export const ACCEPT_SCHEMA = {
  type: 'object',
  properties: {
    milestone: { type: 'string' },
    pass: { type: 'boolean' },
    deployedCommit: { type: 'string' },
    // one entry per thing that was scored (a screen, a command): its name and the rubric scores
    scores: { type: 'array', items: { type: 'object', properties: { subject: { type: 'string' }, screen: { type: 'string' } } } },
    failures: {
      type: 'array',
      items: { type: 'object', properties: { title: { type: 'string' }, scope: { type: 'string' }, evidence: { type: 'string' }, relatedItem: { type: 'string' } }, required: ['title', 'scope'] },
    },
    owner: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['pass', 'failures', 'summary'],
};

export const PACKET_SCHEMA = {
  type: 'object',
  properties: { markdown: { type: 'string' }, screenshots: { type: 'array', items: { type: 'string' } } },
  required: ['markdown'],
};

const str = { type: 'string' };
/** What a retro session returns (loop/prompts/retro.md says what each part means). */
export const RETRO_SCHEMA = {
  type: 'object',
  properties: {
    summary: str,
    went_well: { type: 'array', items: { type: 'object', properties: { practice: str, evidence: str, keep: { type: 'boolean' } }, required: ['practice', 'evidence'] } },
    problems: {
      type: 'array',
      items: { type: 'object', properties: { title: str, evidence: str, cause: str, owner: { type: 'string', enum: ['product', 'practice', 'harness', 'owner'] }, signal: str }, required: ['title', 'evidence', 'cause', 'owner'] },
    },
    checks: {
      type: 'array',
      items: { type: 'object', properties: { action: str, verdict: { type: 'string', enum: ['worked', 'no_effect', 'too_early'] }, decision: { type: 'string', enum: ['keep', 'revise', 'retire'] }, note: str }, required: ['action', 'verdict', 'decision'] },
    },
    actions: {
      type: 'array',
      items: { type: 'object', properties: { title: str, rung: { type: 'string', enum: ['lesson', 'test', 'rule', 'tool'] }, what: str, expect: str, done_when: str, signal: str }, required: ['title', 'rung', 'what', 'expect', 'done_when'] },
    },
    impediments: {
      type: 'array',
      items: { type: 'object', properties: { title: str, part: { type: 'string', enum: ['guard', 'runner', 'prompt', 'ci', 'profile', 'other'] }, evidence: str, example: str, wanted: str, signal: str }, required: ['title', 'part', 'evidence', 'wanted'] },
    },
  },
  required: ['summary', 'went_well', 'problems', 'checks', 'actions', 'impediments'],
};

export const SMOKE_SCHEMA = null; // the smoke step needs no verdict: the guard log is the evidence
