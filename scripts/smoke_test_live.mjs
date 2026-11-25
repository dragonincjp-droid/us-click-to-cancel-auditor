#!/usr/bin/env node
/**
 * Live Production Health & Cost-Cap Smoke Test (`scripts/smoke_test_live.mjs`)
 *
 * - Runs `us-click-to-cancel-auditor` against 1 safe URL (`https://example.com`)
 *   with a strict `maxTotalChargeUsd: 0.10` circuit breaker.
 * - Supports `--dry-run` for zero-network CI verification of `.actor/*` schema parity & character limits.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const APIFY_API_BASE = 'https://api.apify.com/v2';
const DEFAULT_ACTOR_NAME = 'us-click-to-cancel-auditor';
const DEFAULT_TARGET_URL = 'https://example.com';
const HARD_MAX_CHARGE_USD = 0.10;
const RUN_TIMEOUT_SECS = 90;
const RUN_MEMORY_MB = 256;
const MAX_WALL_WAIT_MS = 120_000;

const PPE_EVENT_PRICES_USD = {
  'actor-start': 0.005,
  'url-audited': 0.015,
  'remediation-pack-generated': 0.01,
};

const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8'));
}

function matchesJsonType(value, expectedType) {
  const types = Array.isArray(expectedType) ? expectedType : [expectedType];
  return types.some((t) => {
    if (t === 'null') return value === null;
    if (t === 'array') return Array.isArray(value);
    if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (t === 'number') return typeof value === 'number' && !Number.isNaN(value);
    if (t === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
    if (t === 'string' || t === 'boolean') return typeof value === t;
    return true;
  });
}

function validateDatasetItem(item) {
  const dsSchema = readJson('.actor/dataset_schema.json');
  const fields = dsSchema.fields;
  const errors = [];

  for (const reqKey of fields.required || []) {
    if (!(reqKey in item) || item[reqKey] === undefined) {
      errors.push(`Missing required field "${reqKey}"`);
    }
  }

  for (const [key, def] of Object.entries(fields.properties || {})) {
    if (key in item && item[key] !== undefined && def?.type) {
      if (!matchesJsonType(item[key], def.type)) {
        errors.push(`Field "${key}" expected type ${JSON.stringify(def.type)}, got ${typeof item[key]}`);
      }
    }
  }

  return errors;
}

async function runDryRun() {
  const actorJson = readJson('.actor/actor.json');
  const ppeJson = readJson('.actor/pay_per_event.json');
  const inputSchema = readJson('.actor/input_schema.json');

  if (actorJson.title.length > 58) {
    throw new Error(`actor.json title length ${actorJson.title.length} exceeds 58 chars`);
  }
  if (actorJson.description.length > 250) {
    throw new Error(`actor.json description length ${actorJson.description.length} exceeds 250 chars`);
  }
  for (const [evKey, evDef] of Object.entries(ppeJson)) {
    if ((evDef.eventDescription || '').length > 160) {
      throw new Error(`pay_per_event.json "${evKey}" description exceeds 160 chars`);
    }
  }

  const sampleItem = {
    url: DEFAULT_TARGET_URL,
    normalizedInputUrl: DEFAULT_TARGET_URL,
    finalUrl: `${DEFAULT_TARGET_URL}/`,
    domain: 'example.com',
    auditedAt: new Date().toISOString(),
    status: 'audited',
    httpStatus: 200,
    pageTitle: 'Example Domain',
    detectedLanguage: 'en',
    sitePlatform: 'custom',
    businessModel: 'non_subscription',
    subscriptionStack: [],
    hasSubscriptionSignals: false,
    loadTimeMs: 85,
    pagesFetchedCount: 1,
    pagesFetched: [`${DEFAULT_TARGET_URL}/`],
    errorMessage: null,
    complianceScore: 100,
    riskTier: 'LOW',
    cancellationStatus: 'no_subscription_detected',
    onlineClickToCancelFound: false,
    callOrEmailObstructionFound: false,
    mandatoryExitSurveyFound: false,
    clickToCancelCheck: { checked: true, cancellationStatus: 'no_subscription_detected' },
    preCheckedConsentBoxFound: false,
    missingAutoRenewalDisclosure: false,
    missingTrialConversionDisclosure: false,
    affirmativeConsentCheck: { checked: true, preCheckedConsentBoxFound: false },
    dripFeeViolationFound: false,
    dripFeeCheck: { checked: true, dripFeeRisk: false },
    pricingUrl: null,
    cancelPageUrl: null,
    termsUrl: null,
    billingOrFaqUrl: null,
    discoveredLinks: {
      pricingUrl: null,
      cancelPageUrl: null,
      termsUrl: null,
      billingOrFaqUrl: null,
      privacyUrl: null,
    },
    findingsCount: 0,
    findings: [],
    coldOutreachHook: 'Sample neutral outreach hook.',
    remediationPackGenerated: false,
    remediationPack: null,
    recommendedNextActors: [],
    disclaimer:
      'Automated technical heuristic signals for human review only; does not constitute legal advice or formal regulatory certification.',
  };

  const schemaErrors = validateDatasetItem(sampleItem);
  if (schemaErrors.length > 0) {
    throw new Error(`Dry-run schema validation failed: ${schemaErrors.join('; ')}`);
  }

  const simulatedUsd =
    (ppeJson['actor-start']?.eventPriceUsd ?? 0) + (ppeJson['url-audited']?.eventPriceUsd ?? 0);
  if (simulatedUsd > HARD_MAX_CHARGE_USD) {
    throw new Error(`Simulated smoke run cost $${simulatedUsd} exceeds $${HARD_MAX_CHARGE_USD}`);
  }

  console.log(
    `[smoke_test] DRY-RUN PASS: actor="${actorJson.name}", titleLen=${actorJson.title.length}, descLen=${actorJson.description.length}, inputProps=${Object.keys(inputSchema.properties).length}, simulatedCost=$${simulatedUsd.toFixed(3)} <= $${HARD_MAX_CHARGE_USD.toFixed(2)}`,
  );
}

async function apifyFetch(method, endpoint, token, body) {
  const res = await fetch(`${APIFY_API_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Apify API ${method} ${endpoint} HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

async function runLive(token) {
  let actorId = process.env.APIFY_ACTOR_ID?.trim()?.replace('/', '~');
  if (!actorId) {
    const me = await apifyFetch('GET', '/users/me', token);
    const username = me?.data?.username;
    actorId = `${username}~${DEFAULT_ACTOR_NAME}`;
  }

  const qs = new URLSearchParams({
    waitForFinish: '60',
    maxTotalChargeUsd: HARD_MAX_CHARGE_USD.toFixed(2),
    timeout: String(RUN_TIMEOUT_SECS),
    memory: String(RUN_MEMORY_MB),
  });

  const startedAt = Date.now();
  const startResp = await apifyFetch(
    'POST',
    `/acts/${encodeURIComponent(actorId)}/runs?${qs.toString()}`,
    token,
    {
      urls: [DEFAULT_TARGET_URL],
      includeRemediationPack: false,
      maxLegalPagesPerDomain: 1,
      maxUrls: 1,
    },
  );

  let run = startResp?.data;
  while (!TERMINAL_STATUSES.has(run.status)) {
    if (Date.now() - startedAt > MAX_WALL_WAIT_MS) {
      await apifyFetch('POST', `/actor-runs/${encodeURIComponent(run.id)}/abort`, token).catch(() => {});
      throw new Error('Smoke test exceeded wall-clock timeout and was aborted.');
    }
    const poll = await apifyFetch('GET', `/actor-runs/${encodeURIComponent(run.id)}?waitForFinish=60`, token);
    run = poll?.data || run;
  }

  if (run.status !== 'SUCCEEDED') {
    throw new Error(`Live smoke run ended with status=${run.status} (runId=${run.id})`);
  }

  let chargedUsd = typeof run.usageTotalUsd === 'number' ? run.usageTotalUsd : 0;
  if (!chargedUsd && run.chargedEventCounts) {
    for (const [k, v] of Object.entries(run.chargedEventCounts)) {
      chargedUsd += (Number(v) || 0) * (PPE_EVENT_PRICES_USD[k] ?? 0);
    }
  }
  if (chargedUsd > HARD_MAX_CHARGE_USD + 1e-6) {
    throw new Error(`Live smoke charge $${chargedUsd.toFixed(4)} exceeded cap $${HARD_MAX_CHARGE_USD}`);
  }

  const dsRes = await fetch(
    `${APIFY_API_BASE}/datasets/${encodeURIComponent(run.defaultDatasetId)}/items?clean=true&limit=5`,
    {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    },
  );
  const items = await dsRes.json();
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Smoke run produced 0 dataset items.');
  }
  const errors = validateDatasetItem(items[0]);
  if (errors.length > 0) {
    throw new Error(`Dataset item schema mismatch: ${errors.join('; ')}`);
  }

  console.log(
    `[smoke_test] LIVE PASS: actor=${actorId}, runId=${run.id}, items=${items.length}, charged=$${chargedUsd.toFixed(4)}`,
  );
}

const isDryRun = process.argv.includes('--dry-run') || process.argv.includes('-d');
if (isDryRun) {
  runDryRun().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
} else {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) {
    console.error('APIFY_TOKEN is required unless --dry-run is passed.');
    process.exitCode = 1;
  } else {
    runLive(token).catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
  }
}
