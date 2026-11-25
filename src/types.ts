export const LEGAL_DISCLAIMER =
  'Automated technical heuristic signals for human review only; does not constitute legal advice or formal regulatory certification.';

export const PPE_EVENTS = {
  ACTOR_START: 'actor-start',
  URL_AUDITED: 'url-audited',
  REMEDIATION_PACK_GENERATED: 'remediation-pack-generated',
} as const;

export type PpeEventName = (typeof PPE_EVENTS)[keyof typeof PPE_EVENTS];

export type RiskTier = 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW';
export type FindingSeverity = 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW';
export type AuditStatus = 'audited' | 'blocked_ssrf' | 'blocked_robots' | 'error';

export type SitePlatform =
  | 'shopify'
  | 'woocommerce'
  | 'bigcommerce'
  | 'magento'
  | 'wix'
  | 'squarespace'
  | 'saas-web'
  | 'custom';

export type SubscriptionVendor =
  | 'recharge'
  | 'skio'
  | 'loop-subscriptions'
  | 'bold-subscriptions'
  | 'ordergroove'
  | 'stay-ai'
  | 'seal-subscriptions'
  | 'appstle'
  | 'stripe-billing'
  | 'chargebee'
  | 'recurly'
  | 'paddle'
  | 'zuora'
  | 'lemon-squeezy';

export type BusinessModel =
  | 'dtc_ecommerce_subscription'
  | 'b2b_or_b2c_saas'
  | 'membership_or_media'
  | 'non_subscription';

export type CancellationStatus =
  | 'online_self_serve_found'
  | 'call_or_email_obstruction'
  | 'survey_gated'
  | 'no_cancel_mechanism_disclosed'
  | 'no_subscription_detected'
  | 'not_checked';

export interface UrlRequestObject {
  url: string;
}

export interface RawActorInput {
  urls?: Array<string | UrlRequestObject>;
  startUrls?: Array<string | UrlRequestObject>;
  url?: string;
  datasetId?: string;
  datasetUrlField?: string;
  maxLegalPagesPerDomain?: number;
  includeRemediationPack?: boolean;
  checkClickToCancel?: boolean;
  checkAffirmativeConsent?: boolean;
  checkDripFees?: boolean;
  respectRobotsTxt?: boolean;
  maxUrls?: number;
  maxConcurrency?: number;
  domainDelayMs?: number;
  requestTimeoutMs?: number;
  maxBudgetUsd?: number;
  maxTotalChargeUsd?: number;
}

export interface NormalizedAuditInput {
  urls: string[];
  datasetId?: string;
  datasetUrlField?: string;
  maxLegalPagesPerDomain: number;
  includeRemediationPack: boolean;
  checkClickToCancel: boolean;
  checkAffirmativeConsent: boolean;
  checkDripFees: boolean;
  respectRobotsTxt: boolean;
  maxUrls: number;
  maxConcurrency: number;
  domainDelayMs: number;
  requestTimeoutMs: number;
  maxBudgetUsd?: number;
}

export interface ParsedAnchor {
  href: string;
  resolvedHref: string;
  text: string;
  ariaLabel: string;
  title: string;
  id: string;
  className: string;
  inFooter: boolean;
  inNav: boolean;
}

export interface ParsedControl {
  tag: 'button' | 'input' | 'role-button';
  type: string;
  text: string;
  ariaLabel: string;
  id: string;
  className: string;
  name: string;
  dataAttributes: string;
}

export interface ParsedCheckbox {
  id: string;
  name: string;
  className: string;
  value: string;
  checked: boolean;
  required: boolean;
  associatedText: string;
}

export interface ParsedForm {
  action: string;
  resolvedAction: string;
  method: string;
  id: string;
  className: string;
  inputNamesAndTypes: string[];
  requiredSurveyFields: string[];
  hasPasswordInput: boolean;
  hasEmailOrOrderInput: boolean;
  buttonTexts: string[];
  textSnippet: string;
}

export interface ParsedHtmlDocument {
  url: string;
  title: string | null;
  htmlLang: string | null;
  rawHtml: string;
  visibleText: string;
  scriptUrls: string[];
  inlineScripts: string[];
  stylesheetUrls: string[];
  jsonLdBlocks: unknown[];
  anchors: ParsedAnchor[];
  controls: ParsedControl[];
  checkboxes: ParsedCheckbox[];
  requiredSurveyControls: string[];
  forms: ParsedForm[];
}

export interface ClickToCancelCheckResult {
  checked: boolean;
  cancellationStatus: CancellationStatus;
  onlineSelfServeFound: boolean;
  cancelPortalUrl: string | null;
  cancelButtonLabel: string | null;
  obstructionFound: boolean;
  obstructionSignals: string[];
  mandatorySurveyGateFound: boolean;
  surveySignals: string[];
  selfServeSignals: string[];
  foundOnPages: string[];
}

export interface AffirmativeConsentCheckResult {
  checked: boolean;
  preCheckedConsentBoxFound: boolean;
  preCheckedSignals: string[];
  expressUncheckedConsentFound: boolean;
  autoRenewalTermsDisclosed: boolean;
  freeTrialDetected: boolean;
  trialConversionTermsDisclosed: boolean;
  missingTrialConversionRisk: boolean;
  matchedConsentSignals: string[];
  foundOnPages: string[];
}

export interface DripFeeCheckResult {
  checked: boolean;
  dripFeeSignalsFound: boolean;
  dripFeeRisk: boolean;
  matchedDripFeePhrases: string[];
  foundOnPages: string[];
}

export interface DiscoveredSubscriptionLinks {
  pricingUrl: string | null;
  cancelPageUrl: string | null;
  termsUrl: string | null;
  billingOrFaqUrl: string | null;
  privacyUrl: string | null;
}

export interface ComplianceFinding {
  ruleId: string;
  title: string;
  regulation: string;
  severity: FindingSeverity;
  pageUrl: string;
  evidence: string;
  recommendation: string;
}

export interface RemediationPack {
  sitePlatform: SitePlatform;
  businessModel: BusinessModel;
  subscriptionStack: SubscriptionVendor[];
  affirmativeConsentSnippetHtml: string;
  oneClickCancelModalHtmlJs: string;
  allInPricingGuidance: string | null;
  regulatoryCoverageSummary: string;
  implementationNotes: string[];
}

export interface RecommendedNextActor {
  actorSlug: string;
  actorUrl: string;
  mcpEndpointUrl: string;
  reason: string;
}

export interface SubscriptionAuditReportItem {
  url: string;
  normalizedInputUrl: string;
  finalUrl: string | null;
  domain: string;
  auditedAt: string;
  status: AuditStatus;
  httpStatus: number | null;
  pageTitle: string | null;
  detectedLanguage: string | null;
  sitePlatform: SitePlatform;
  businessModel: BusinessModel;
  subscriptionStack: SubscriptionVendor[];
  hasSubscriptionSignals: boolean;
  loadTimeMs: number;
  pagesFetchedCount: number;
  pagesFetched: string[];
  errorMessage: string | null;

  complianceScore: number;
  riskTier: RiskTier;

  cancellationStatus: CancellationStatus;
  onlineClickToCancelFound: boolean;
  callOrEmailObstructionFound: boolean;
  mandatoryExitSurveyFound: boolean;
  clickToCancelCheck: ClickToCancelCheckResult;

  preCheckedConsentBoxFound: boolean;
  missingAutoRenewalDisclosure: boolean;
  missingTrialConversionDisclosure: boolean;
  affirmativeConsentCheck: AffirmativeConsentCheckResult;

  dripFeeViolationFound: boolean;
  dripFeeCheck: DripFeeCheckResult;

  pricingUrl: string | null;
  cancelPageUrl: string | null;
  termsUrl: string | null;
  billingOrFaqUrl: string | null;
  discoveredLinks: DiscoveredSubscriptionLinks;

  findingsCount: number;
  findings: ComplianceFinding[];
  coldOutreachHook: string;

  remediationPackGenerated: boolean;
  remediationPack: RemediationPack | null;

  recommendedNextActors: RecommendedNextActor[];
  disclaimer: string;
}
