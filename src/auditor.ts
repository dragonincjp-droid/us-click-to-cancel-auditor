import { ApifyRuntimeAdapter } from './apifyRuntime.js';
import { BillingManager, type BillingSummary } from './billing.js';
import {
  checkAffirmativeConsent,
  checkClickToCancel,
  checkDripFees,
  detectSiteLanguage,
  detectSubscriptionAndStack,
  discoverSubscriptionLinks,
  selectPriorityInternalSubpages,
  type InspectedPageBundle,
} from './detectors.js';
import { parseHtmlDocument } from './htmlParser.js';
import { DEFAULT_MAX_RESPONSE_BYTES, fetchSafeHttp } from './httpClient.js';
import {
  buildFindingsAndScore,
  buildRecommendedNextActors,
  generateColdOutreachHook,
  generateRemediationPack,
} from './remediation.js';
import { RobotsAndRateGuard } from './robots.js';
import { validateUrlAgainstSsrf, type DnsLookupFn } from './ssrf.js';
import {
  LEGAL_DISCLAIMER,
  PPE_EVENTS,
  type AuditStatus,
  type NormalizedAuditInput,
  type RawActorInput,
  type SubscriptionAuditReportItem,
  type UrlRequestObject,
} from './types.js';

function clampInt(val: unknown, fallback: number, min: number, max: number): number {
  const num = typeof val === 'number' ? val : Number(val);
  if (Number.isNaN(num) || !Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

/**
 * Normalizes both full URLs (`https://app.example.com`) and bare domains
 * (`app.example.com` -> `https://app.example.com`), while preserving non-HTTP schemes
 * (e.g. `file://`, `ftp://`) so SSRF validation explicitly rejects them.
 */
export function coerceUrlCandidate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('//')) {
    return `https:${trimmed}`;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return trimmed;
  }
  if (/^(?:\[[0-9a-fA-F:]+\]|[a-z0-9.-]+\.[a-z]{2,}|localhost)(?::\d+)?(?:[/?#].*)?$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

function extractRawUrlStrings(
  rawInput: RawActorInput | null | undefined,
  extraDatasetUrls: string[] = [],
): string[] {
  const collected: string[] = [];

  const appendSingle = (candidate: string) => {
    const coerced = coerceUrlCandidate(candidate);
    if (coerced) collected.push(coerced);
  };

  const appendList = (list?: Array<string | UrlRequestObject>) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (typeof item === 'string') {
        appendSingle(item);
      } else if (item && typeof item === 'object' && typeof item.url === 'string') {
        appendSingle(item.url);
      }
    }
  };

  if (rawInput) {
    appendList(rawInput.urls);
    appendList(rawInput.startUrls);
    if (typeof rawInput.url === 'string') {
      appendSingle(rawInput.url);
    }
  }

  for (const dsUrl of extraDatasetUrls) {
    appendSingle(dsUrl);
  }

  return Array.from(new Set(collected));
}

export function normalizeAuditInput(
  rawInput: RawActorInput | null | undefined,
  extraDatasetUrls: string[] = [],
  maxUrlsHardCap = 5000,
): NormalizedAuditInput {
  const input = rawInput ?? {};
  const maxUrls = clampInt(input.maxUrls, 100, 1, maxUrlsHardCap);
  const dedupedUrls = extractRawUrlStrings(input, extraDatasetUrls).slice(0, maxUrls);

  const rawBudget = input.maxBudgetUsd ?? input.maxTotalChargeUsd;
  const parsedBudget =
    typeof rawBudget === 'number' && !Number.isNaN(rawBudget) && rawBudget >= 0
      ? rawBudget
      : undefined;

  return {
    urls: dedupedUrls,
    datasetId:
      typeof input.datasetId === 'string' && input.datasetId.trim()
        ? input.datasetId.trim()
        : undefined,
    datasetUrlField:
      typeof input.datasetUrlField === 'string' && input.datasetUrlField.trim()
        ? input.datasetUrlField.trim()
        : undefined,
    maxLegalPagesPerDomain: clampInt(input.maxLegalPagesPerDomain, 3, 0, 5),
    includeRemediationPack: input.includeRemediationPack ?? true,
    checkClickToCancel: input.checkClickToCancel ?? true,
    checkAffirmativeConsent: input.checkAffirmativeConsent ?? true,
    checkDripFees: input.checkDripFees ?? true,
    respectRobotsTxt: input.respectRobotsTxt ?? true,
    maxUrls,
    maxConcurrency: clampInt(input.maxConcurrency, 5, 1, 20),
    domainDelayMs: clampInt(input.domainDelayMs, 300, 0, 30_000),
    requestTimeoutMs: clampInt(input.requestTimeoutMs, 12_000, 2_000, 60_000),
    maxBudgetUsd: parsedBudget,
  };
}

function safeExtractHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return 'invalid-host';
  }
}

function isBinaryContentType(contentType: string): boolean {
  const lowerCt = (contentType || '').toLowerCase();
  return (
    /^(?:image|video|audio|font)\//.test(lowerCt) ||
    /\bapplication\/(?:pdf|zip|x-gzip|gzip|octet-stream|msword|vnd\.)\b/.test(lowerCt)
  );
}

function buildBlockedOrErrorItem(params: {
  rawUrl: string;
  normalizedInputUrl: string;
  status: Exclude<AuditStatus, 'audited'>;
  httpStatus?: number | null;
  reason: string;
  loadTimeMs: number;
}): SubscriptionAuditReportItem {
  const domain = safeExtractHostname(params.normalizedInputUrl || params.rawUrl);
  return {
    url: params.rawUrl,
    normalizedInputUrl: params.normalizedInputUrl,
    finalUrl: null,
    domain,
    auditedAt: new Date().toISOString(),
    status: params.status,
    httpStatus: params.httpStatus ?? null,
    pageTitle: null,
    detectedLanguage: null,
    sitePlatform: 'custom',
    businessModel: 'non_subscription',
    subscriptionStack: [],
    hasSubscriptionSignals: false,
    loadTimeMs: params.loadTimeMs,
    pagesFetchedCount: 0,
    pagesFetched: [],
    errorMessage: params.reason,
    complianceScore: 0,
    riskTier: 'LOW',
    cancellationStatus: 'not_checked',
    onlineClickToCancelFound: false,
    callOrEmailObstructionFound: false,
    mandatoryExitSurveyFound: false,
    clickToCancelCheck: {
      checked: false,
      cancellationStatus: 'not_checked',
      onlineSelfServeFound: false,
      cancelPortalUrl: null,
      cancelButtonLabel: null,
      obstructionFound: false,
      obstructionSignals: [],
      mandatorySurveyGateFound: false,
      surveySignals: [],
      selfServeSignals: [],
      foundOnPages: [],
    },
    preCheckedConsentBoxFound: false,
    missingAutoRenewalDisclosure: false,
    missingTrialConversionDisclosure: false,
    affirmativeConsentCheck: {
      checked: false,
      preCheckedConsentBoxFound: false,
      preCheckedSignals: [],
      expressUncheckedConsentFound: false,
      autoRenewalTermsDisclosed: false,
      freeTrialDetected: false,
      trialConversionTermsDisclosed: false,
      missingTrialConversionRisk: false,
      matchedConsentSignals: [],
      foundOnPages: [],
    },
    dripFeeViolationFound: false,
    dripFeeCheck: {
      checked: false,
      dripFeeSignalsFound: false,
      dripFeeRisk: false,
      matchedDripFeePhrases: [],
      foundOnPages: [],
    },
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
    coldOutreachHook: '',
    remediationPackGenerated: false,
    remediationPack: null,
    recommendedNextActors: buildRecommendedNextActors(domain),
    disclaimer: LEGAL_DISCLAIMER,
  };
}

export interface AuditExecutionDependencies {
  runtime?: ApifyRuntimeAdapter;
  robotsGuard?: RobotsAndRateGuard;
  billing?: BillingManager;
  allowLocalhost?: boolean;
  dnsLookup?: DnsLookupFn;
  pushToDataset?: boolean;
  chargeActorStart?: boolean;
}

export interface BatchAuditResult {
  items: SubscriptionAuditReportItem[];
  billing: BillingSummary;
  stoppedDueToBudgetCap: boolean;
  engineName: string;
}

export async function auditSingleSite(params: {
  rawUrl: string;
  config: NormalizedAuditInput;
  billing: BillingManager;
  robotsGuard: RobotsAndRateGuard;
  allowLocalhost?: boolean;
  dnsLookup?: DnsLookupFn;
}): Promise<{ item: SubscriptionAuditReportItem | null; budgetStopped: boolean }> {
  const { rawUrl, config, billing, robotsGuard, allowLocalhost, dnsLookup } = params;
  const startedMs = Date.now();
  const normalizedInputUrl = coerceUrlCandidate(rawUrl);

  // 1. Strict SSRF Pre-Flight Validation
  const ssrf = await validateUrlAgainstSsrf(normalizedInputUrl, { allowLocalhost, dnsLookup });
  if (!ssrf.allowed || !ssrf.normalizedUrl || !ssrf.hostname) {
    return {
      item: buildBlockedOrErrorItem({
        rawUrl,
        normalizedInputUrl,
        status: 'blocked_ssrf',
        reason: ssrf.reason || 'Blocked by SSRF security policy.',
        loadTimeMs: Date.now() - startedMs,
      }),
      budgetStopped: false,
    };
  }

  const targetUrl = ssrf.normalizedUrl;
  const hostname = ssrf.hostname;

  // 2. Budget Ceiling Pre-Check before making network calls
  if (!billing.canAfford(PPE_EVENTS.URL_AUDITED, 1)) {
    return { item: null, budgetStopped: true };
  }

  // 3. Polite robots.txt check for homepage
  let effectiveDelayMs = config.domainDelayMs;
  if (config.respectRobotsTxt) {
    const robots = await robotsGuard.checkUrlAllowed(targetUrl, { allowLocalhost, dnsLookup });
    if (!robots.allowed) {
      return {
        item: buildBlockedOrErrorItem({
          rawUrl,
          normalizedInputUrl,
          status: 'blocked_robots',
          reason: `Disallowed by domain robots.txt (${robots.matchedRule || 'Disallow rule'}).`,
          loadTimeMs: Date.now() - startedMs,
        }),
        budgetStopped: false,
      };
    }
    if (robots.crawlDelayMs > effectiveDelayMs) {
      effectiveDelayMs = robots.crawlDelayMs;
    }
  }

  // 4. Polite per-domain delay
  await robotsGuard.waitForDomainSlot(hostname, effectiveDelayMs);

  // Re-check budget after waiting in queue
  if (!billing.canAfford(PPE_EVENTS.URL_AUDITED, 1)) {
    return { item: null, budgetStopped: true };
  }

  // 5. Fetch homepage via anti-DNS-rebinding pinned HTTP client
  const homeRes = await fetchSafeHttp(targetUrl, {
    maxBytes: DEFAULT_MAX_RESPONSE_BYTES,
    timeoutMs: config.requestTimeoutMs,
    maxRedirects: 5,
    allowLocalhost,
    dnsLookup,
    checkRedirectAllowed: config.respectRobotsTxt
      ? async (redirectUrl) => {
          const r = await robotsGuard.checkUrlAllowed(redirectUrl, { allowLocalhost, dnsLookup });
          return {
            allowed: r.allowed,
            reason: r.allowed
              ? undefined
              : `Redirect disallowed by robots.txt (${r.matchedRule || 'Disallow'}).`,
          };
        }
      : undefined,
  });

  if (homeRes.blockedBySsrf) {
    return {
      item: buildBlockedOrErrorItem({
        rawUrl,
        normalizedInputUrl,
        status: 'blocked_ssrf',
        reason: homeRes.errorMessage || 'Blocked by SSRF redirect policy.',
        loadTimeMs: Date.now() - startedMs,
      }),
      budgetStopped: false,
    };
  }

  if (homeRes.blockedByRobots) {
    return {
      item: buildBlockedOrErrorItem({
        rawUrl,
        normalizedInputUrl,
        status: 'blocked_robots',
        reason: homeRes.errorMessage || 'Blocked by domain robots.txt during redirect.',
        loadTimeMs: Date.now() - startedMs,
      }),
      budgetStopped: false,
    };
  }

  if (!homeRes.ok || homeRes.statusCode === null) {
    return {
      item: buildBlockedOrErrorItem({
        rawUrl,
        normalizedInputUrl,
        status: 'error',
        httpStatus: homeRes.statusCode,
        reason: homeRes.errorMessage || 'Target site returned an unreachable or non-2xx/3xx HTTP status.',
        loadTimeMs: Date.now() - startedMs,
      }),
      budgetStopped: false,
    };
  }

  if (isBinaryContentType(homeRes.contentType)) {
    return {
      item: buildBlockedOrErrorItem({
        rawUrl,
        normalizedInputUrl,
        status: 'error',
        httpStatus: homeRes.statusCode,
        reason: `Skipped non-HTML binary resource (Content-Type: ${homeRes.contentType}); $0 billed.`,
        loadTimeMs: Date.now() - startedMs,
      }),
      budgetStopped: false,
    };
  }

  const homeDoc = parseHtmlDocument(homeRes.bodyText, homeRes.finalUrl);
  const inspectedPages: InspectedPageBundle[] = [
    {
      requestedUrl: targetUrl,
      finalUrl: homeRes.finalUrl,
      redirectChain: homeRes.redirectChain,
      doc: homeDoc,
    },
  ];
  const pagesFetched: string[] = [homeRes.finalUrl];

  // 6. Discover and fetch up to `maxLegalPagesPerDomain` internal same-origin pages
  const candidateSubpages = selectPriorityInternalSubpages(
    homeDoc,
    homeRes.finalUrl,
    config.maxLegalPagesPerDomain,
  );

  const finalHomeHost = safeExtractHostname(homeRes.finalUrl);

  for (const subUrl of candidateSubpages) {
    if (config.respectRobotsTxt) {
      const subRobots = await robotsGuard.checkUrlAllowed(subUrl, { allowLocalhost, dnsLookup });
      if (!subRobots.allowed) {
        continue;
      }
    }

    await robotsGuard.waitForDomainSlot(finalHomeHost, effectiveDelayMs);

    const subRes = await fetchSafeHttp(subUrl, {
      maxBytes: DEFAULT_MAX_RESPONSE_BYTES,
      timeoutMs: config.requestTimeoutMs,
      maxRedirects: 5,
      allowLocalhost,
      dnsLookup,
      checkRedirectAllowed: config.respectRobotsTxt
        ? async (redirectUrl) => {
            const r = await robotsGuard.checkUrlAllowed(redirectUrl, { allowLocalhost, dnsLookup });
            return {
              allowed: r.allowed,
              reason: r.allowed ? undefined : 'Disallowed by robots.txt',
            };
          }
        : undefined,
    });

    if (subRes.blockedBySsrf || subRes.blockedByRobots || !subRes.ok || isBinaryContentType(subRes.contentType)) {
      continue;
    }

    const subDoc = parseHtmlDocument(subRes.bodyText || '', subRes.finalUrl);
    inspectedPages.push({
      requestedUrl: subUrl,
      finalUrl: subRes.finalUrl,
      redirectChain: subRes.redirectChain,
      doc: subDoc,
    });
    if (!pagesFetched.includes(subRes.finalUrl)) {
      pagesFetched.push(subRes.finalUrl);
    }
  }

  // 7. Charge `url-audited` ONLY now that the site was cleanly fetched and inspected!
  const urlCharge = await billing.chargeEvent(PPE_EVENTS.URL_AUDITED, 1);
  if (!urlCharge.charged) {
    return { item: null, budgetStopped: true };
  }

  // 8. Run all deterministic US Subscription, Click-to-Cancel, ARL & Drip-Fee detectors
  const allDocs = inspectedPages.map((p) => p.doc);
  const domain = finalHomeHost;
  const detectedLanguage = detectSiteLanguage(allDocs);
  const stackInfo = detectSubscriptionAndStack(allDocs);
  const discoveredLinks = discoverSubscriptionLinks(allDocs);

  const clickToCancelCheck = checkClickToCancel(
    inspectedPages,
    stackInfo.hasSubscriptionSignals,
    config.checkClickToCancel,
  );
  const affirmativeConsentCheck = checkAffirmativeConsent(
    inspectedPages,
    stackInfo.hasSubscriptionSignals,
    config.checkAffirmativeConsent,
  );
  const dripFeeCheck = checkDripFees(inspectedPages, config.checkDripFees);

  const { findings, complianceScore, riskTier } = buildFindingsAndScore({
    homeUrl: homeRes.finalUrl,
    businessModel: stackInfo.businessModel,
    hasSubscriptionSignals: stackInfo.hasSubscriptionSignals,
    discoveredLinks,
    clickToCancel: clickToCancelCheck,
    affirmativeConsent: affirmativeConsentCheck,
    dripFee: dripFeeCheck,
  });

  const coldOutreachHook = generateColdOutreachHook({
    domain,
    sitePlatform: stackInfo.sitePlatform,
    subscriptionStack: stackInfo.subscriptionStack,
    hasSubscriptionSignals: stackInfo.hasSubscriptionSignals,
    clickToCancel: clickToCancelCheck,
    affirmativeConsent: affirmativeConsentCheck,
    dripFee: dripFeeCheck,
    findings,
  });

  // 9. Optional Remediation Pack (only generated & charged when enabled AND findings.length > 0)
  let remediationPackGenerated = false;
  let remediationPack: SubscriptionAuditReportItem['remediationPack'] = null;

  if (
    config.includeRemediationPack &&
    findings.length > 0 &&
    billing.canAfford(PPE_EVENTS.REMEDIATION_PACK_GENERATED, 1)
  ) {
    const remCharge = await billing.chargeEvent(PPE_EVENTS.REMEDIATION_PACK_GENERATED, 1);
    if (remCharge.charged) {
      remediationPackGenerated = true;
      remediationPack = generateRemediationPack({
        domain,
        sitePlatform: stackInfo.sitePlatform,
        businessModel: stackInfo.businessModel,
        subscriptionStack: stackInfo.subscriptionStack,
        dripFee: dripFeeCheck,
      });
    }
  }

  const reportItem: SubscriptionAuditReportItem = {
    url: rawUrl,
    normalizedInputUrl,
    finalUrl: homeRes.finalUrl,
    domain,
    auditedAt: new Date().toISOString(),
    status: 'audited',
    httpStatus: homeRes.statusCode,
    pageTitle: homeDoc.title,
    detectedLanguage,
    sitePlatform: stackInfo.sitePlatform,
    businessModel: stackInfo.businessModel,
    subscriptionStack: stackInfo.subscriptionStack,
    hasSubscriptionSignals: stackInfo.hasSubscriptionSignals,
    loadTimeMs: Date.now() - startedMs,
    pagesFetchedCount: pagesFetched.length,
    pagesFetched,
    errorMessage: null,

    complianceScore,
    riskTier,

    cancellationStatus: clickToCancelCheck.cancellationStatus,
    onlineClickToCancelFound: clickToCancelCheck.onlineSelfServeFound,
    callOrEmailObstructionFound: clickToCancelCheck.obstructionFound,
    mandatoryExitSurveyFound: clickToCancelCheck.mandatorySurveyGateFound,
    clickToCancelCheck,

    preCheckedConsentBoxFound: affirmativeConsentCheck.preCheckedConsentBoxFound,
    missingAutoRenewalDisclosure:
      stackInfo.hasSubscriptionSignals &&
      affirmativeConsentCheck.checked &&
      !affirmativeConsentCheck.autoRenewalTermsDisclosed,
    missingTrialConversionDisclosure: affirmativeConsentCheck.missingTrialConversionRisk,
    affirmativeConsentCheck,

    dripFeeViolationFound: dripFeeCheck.dripFeeRisk,
    dripFeeCheck,

    pricingUrl: discoveredLinks.pricingUrl,
    cancelPageUrl:
      discoveredLinks.cancelPageUrl ?? clickToCancelCheck.cancelPortalUrl,
    termsUrl: discoveredLinks.termsUrl,
    billingOrFaqUrl: discoveredLinks.billingOrFaqUrl,
    discoveredLinks,

    findingsCount: findings.length,
    findings,
    coldOutreachHook,

    remediationPackGenerated,
    remediationPack,

    recommendedNextActors: buildRecommendedNextActors(domain),
    disclaimer: LEGAL_DISCLAIMER,
  };

  return { item: reportItem, budgetStopped: billing.isLimitReached() };
}

export async function runBatchAudit(
  rawInput: RawActorInput | null | undefined,
  deps: AuditExecutionDependencies = {},
): Promise<BatchAuditResult> {
  const runtime = deps.runtime ?? new ApifyRuntimeAdapter();
  await runtime.init();

  let extraDatasetUrls: string[] = [];
  if (typeof rawInput?.datasetId === 'string' && rawInput.datasetId.trim().length > 0) {
    extraDatasetUrls = await runtime.loadUrlsFromDataset(
      rawInput.datasetId,
      rawInput.datasetUrlField,
    );
  }

  const config = normalizeAuditInput(rawInput, extraDatasetUrls);
  const billing = deps.billing ?? new BillingManager(runtime, config.maxBudgetUsd);
  const robotsGuard = deps.robotsGuard ?? new RobotsAndRateGuard();
  const pushToDataset = deps.pushToDataset ?? true;
  const chargeActorStart = deps.chargeActorStart ?? true;

  if (chargeActorStart) {
    const startCharge = await billing.chargeEvent(PPE_EVENTS.ACTOR_START, 1);
    if (!startCharge.charged) {
      return {
        items: [],
        billing: billing.getSummary(),
        stoppedDueToBudgetCap: true,
        engineName: 'zero-playwright-pinned-http',
      };
    }
  }

  if (config.urls.length === 0) {
    return {
      items: [],
      billing: billing.getSummary(),
      stoppedDueToBudgetCap: false,
      engineName: 'zero-playwright-pinned-http',
    };
  }

  const orderedItems: Array<SubscriptionAuditReportItem | null> = new Array(config.urls.length).fill(null);
  let cursor = 0;
  let stoppedDueToBudgetCap = false;

  const workerCount = Math.min(config.maxConcurrency, config.urls.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!stoppedDueToBudgetCap) {
      const index = cursor++;
      if (index >= config.urls.length) break;

      if (billing.isLimitReached() || !billing.canAfford(PPE_EVENTS.URL_AUDITED, 1)) {
        stoppedDueToBudgetCap = true;
        break;
      }

      const targetUrl = config.urls[index];
      const { item, budgetStopped } = await auditSingleSite({
        rawUrl: targetUrl,
        config,
        billing,
        robotsGuard,
        allowLocalhost: deps.allowLocalhost,
        dnsLookup: deps.dnsLookup,
      });

      if (item) {
        orderedItems[index] = item;
        if (pushToDataset) {
          await runtime.pushData(item);
        }
      }

      if (budgetStopped) {
        stoppedDueToBudgetCap = true;
        break;
      }
    }
  });

  await Promise.all(workers);

  const items = orderedItems.filter((x): x is SubscriptionAuditReportItem => x !== null);

  return {
    items,
    billing: billing.getSummary(),
    stoppedDueToBudgetCap,
    engineName: 'zero-playwright-pinned-http',
  };
}
