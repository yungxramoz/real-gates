// JSON schemas for the read-only steps. Their sessions start with --json-schema, so the verdict
// comes back as the result event's `structured_output` and the runner writes any files itself
// (those sessions have no Edit/Write tools at all).

import { REVIEW_CATEGORIES } from './learn.mjs';

const score = { type: 'integer', minimum: 0, maximum: 10 };
const scores = { type: 'object', properties: { design_quality: score, originality: score, craft: score, functionality: score }, additionalProperties: false };

export const REVIEW_SCHEMA = {
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
    scores,
    design: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['verdict', 'blocking', 'summary'],
};

export const ACCEPT_SCHEMA = {
  type: 'object',
  properties: {
    milestone: { type: 'string' },
    pass: { type: 'boolean' },
    deployedCommit: { type: 'string' },
    scores: { type: 'array', items: { type: 'object', properties: { screen: { type: 'string' }, ...scores.properties }, required: ['screen'] } },
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

export const SMOKE_SCHEMA = null; // the smoke step needs no verdict: the guard log is the evidence
