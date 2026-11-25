import type {
  AffirmativeConsentCheckResult,
  BusinessModel,
  CancellationStatus,
  ClickToCancelCheckResult,
  DiscoveredSubscriptionLinks,
  DripFeeCheckResult,
  ParsedAnchor,
  ParsedHtmlDocument,
  SitePlatform,
  SubscriptionVendor,
} from './types.js';

export interface InspectedPageBundle {
  requestedUrl: string;
  finalUrl: string;
  redirectChain: string[];
  doc: ParsedHtmlDocument;
}

const ASSET_EXTENSION_RE =
  /\.(?:jpg|jpeg|png|gif|webp|avif|svg|ico|css|js|mjs|woff|woff2|ttf|eot|mp4|webm|mp3|zip|tar|gz|rar|xml|json)(?:[?#]|$)/i;

const DTC_SUBSCRIPTION_VENDORS = new Set<SubscriptionVendor>([
  'recharge',
  'skio',
  'loop-subscriptions',
  'bold-subscriptions',
  'ordergroove',
  'stay-ai',
  'seal-subscriptions',
  'appstle',
]);

const SAAS_BILLING_VENDORS = new Set<SubscriptionVendor>([
  'stripe-billing',
  'chargebee',
  'recurly',
  'paddle',
  'zuora',
  'lemon-squeezy',
]);

const SUBSCRIPTION_VENDOR_PATTERNS: Array<{
  vendor: SubscriptionVendor;
  regex: RegExp;
  requiresRecurringText?: boolean;
}> = [
  // DTC Subscription Apps
  {
    vendor: 'recharge',
    regex:
      /\b(?:rechargeapps\.com|rechargepayments\.com|rechargestatic\.com|rechargecdn\.com|rc-container|rc-widget|data-recharge|recharge-subscription)\b/i,
  },
  {
    vendor: 'skio',
    regex: /\b(?:skio\.com|skio-plan-picker|data-skio)\b/i,
  },
  {
    vendor: 'loop-subscriptions',
    regex: /\b(?:loopwork\.co|loop-subscriptions|loop-widget|\/a\/loop_subscriptions)\b/i,
  },
  {
    vendor: 'bold-subscriptions',
    regex: /\b(?:boldapps\.net\/v2_ui\/js\/ro|bold-subscriptions|bsub-widget|bold-ro)\b/i,
  },
  {
    vendor: 'ordergroove',
    regex: /\b(?:ordergroove\.com|og-offer|main\.ordergroove)\b/i,
  },
  {
    vendor: 'stay-ai',
    regex: /\b(?:stay\.ai|stayai|rtxn_subscription)\b/i,
  },
  {
    vendor: 'seal-subscriptions',
    regex: /\b(?:sealsubscriptions\.com|seal-subscription|seal-table)\b/i,
  },
  {
    vendor: 'appstle',
    regex: /\b(?:appstle\.com|appstle_subscription|appstle-stand-alone)\b/i,
  },
  // SaaS Billing Engines
  {
    vendor: 'stripe-billing',
    regex: /\b(?:billing\.stripe\.com|stripe-pricing-table)\b/i,
  },
  {
    vendor: 'stripe-billing',
    regex: /\b(?:js\.stripe\.com|checkout\.stripe\.com)\b/i,
    requiresRecurringText: true,
  },
  {
    vendor: 'chargebee',
    regex: /\b(?:js\.chargebee\.com|chargebee\.com|data-cb-type)\b/i,
  },
  {
    vendor: 'recurly',
    regex: /\b(?:js\.recurly\.com|recurly\.com)\b/i,
  },
  {
    vendor: 'paddle',
    regex: /\b(?:cdn\.paddle\.com|paddle\.js|Paddle\.(?:Setup|Initialize))\b/i,
  },
  {
    vendor: 'zuora',
    regex: /\b(?:zuora\.com|static\.zuora\.com)\b/i,
  },
  {
    vendor: 'lemon-squeezy',
    regex: /\b(?:lemonsqueezy\.com|assets\.lemonsqueezy\.com\/lemon\.js)\b/i,
  },
];

const SUBSCRIPTION_TEXT_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'subscribe & save', regex: /\bsubscribe\s*(?:&|and)\s*save\b/i },
  { label: 'auto-deliver / autoship', regex: /\b(?:auto[- ]?deliver(?:y|ies)?|auto[- ]?ship|replenish\s+every)\b/i },
  { label: 'billed monthly/annually', regex: /\bbilled\s+(?:monthly|annually|yearly|quarterly|weekly)\b/i },
  { label: 'recurring price (/mo or /yr)', regex: /\$\s*\d+(?:[.,]\d{1,2})?\s*(?:\/\s*(?:mo|month|yr|year)\b|per\s+(?:month|year|seat|user)\b)/i },
  { label: 'free trial', regex: /\b(?:free\s+trial|\d{1,2}[- ]day\s+trial|start\s+(?:your\s+)?trial)\b/i },
  { label: 'renews automatically', regex: /\b(?:renews\s+automatically|automatically\s+renews|auto[- ]?renews?|automatic\s+renewal)\b/i },
  { label: 'continuous service', regex: /\bcontinuous\s+service\b/i },
  { label: 'recurring billing/subscription', regex: /\b(?:recurring\s+(?:billing|charges?|payments?|subscription)|subscription\s+plan|monthly\s+subscription|annual\s+subscription)\b/i },
  { label: 'paid membership', regex: /\b(?:monthly\s+membership|annual\s+membership|vip\s+membership|cancel\s+(?:my\s+|your\s+)?membership|membership\s+renews)\b/i },
];

function extractPhraseContext(text: string, matchIndex: number, matchLength: number): string {
  const start = Math.max(0, matchIndex - 32);
  const end = Math.min(text.length, matchIndex + matchLength + 44);
  let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = `...${snippet}`;
  if (end < text.length) snippet = `${snippet}...`;
  return snippet;
}

export function detectSiteLanguage(pages: ParsedHtmlDocument[]): string {
  for (const p of pages) {
    if (p.htmlLang && /^[a-z]{2,3}$/i.test(p.htmlLang)) {
      return p.htmlLang.toLowerCase();
    }
  }
  return 'en';
}

export interface StackDetectionSummary {
  sitePlatform: SitePlatform;
  subscriptionStack: SubscriptionVendor[];
  hasSubscriptionSignals: boolean;
  matchedSubscriptionSignals: string[];
  businessModel: BusinessModel;
}

export function detectSubscriptionAndStack(pages: ParsedHtmlDocument[]): StackDetectionSummary {
  const combinedAssetsAndHtml = pages
    .map((p) =>
      [
        p.scriptUrls.join(' '),
        p.stylesheetUrls.join(' '),
        p.inlineScripts.join(' ').slice(0, 18_000),
        p.anchors.map((a) => a.resolvedHref).join(' '),
        p.rawHtml.slice(0, 45_000),
      ].join('\n'),
    )
    .join('\n');

  const combinedVisibleText = pages.map((p) => p.visibleText).join('\n');

  const matchedSubscriptionSignals: string[] = [];
  for (const pat of SUBSCRIPTION_TEXT_PATTERNS) {
    const m = pat.regex.exec(combinedVisibleText);
    if (m && m.index !== undefined) {
      matchedSubscriptionSignals.push(
        `${pat.label} ("${extractPhraseContext(combinedVisibleText, m.index, m[0].length)}")`,
      );
    }
  }

  const hasRecurringText = matchedSubscriptionSignals.length > 0;

  const detectedVendors = new Set<SubscriptionVendor>();
  for (const vPat of SUBSCRIPTION_VENDOR_PATTERNS) {
    if (vPat.requiresRecurringText && !hasRecurringText) continue;
    if (vPat.regex.test(combinedAssetsAndHtml)) {
      detectedVendors.add(vPat.vendor);
    }
  }

  const subscriptionStack = Array.from(detectedVendors);
  const hasDtcVendor = subscriptionStack.some((v) => DTC_SUBSCRIPTION_VENDORS.has(v));
  const hasSaasVendor = subscriptionStack.some((v) => SAAS_BILLING_VENDORS.has(v));
  const hasSubscriptionSignals =
    hasRecurringText || hasDtcVendor || /\bbilling\.stripe\.com\/p\//i.test(combinedAssetsAndHtml);

  let sitePlatform: SitePlatform = 'custom';
  if (/\bcdn\.shopify\.com\b|\bShopify\.shop\b|\bshopify-section\b|\bmyshopify\.com\b/i.test(combinedAssetsAndHtml)) {
    sitePlatform = 'shopify';
  } else if (
    /\/wp-content\/plugins\/woocommerce\/|\bwoocommerce-Price-amount\b|\bwc-blocks\b|\bwoocommerce_params\b/i.test(
      combinedAssetsAndHtml,
    )
  ) {
    sitePlatform = 'woocommerce';
  } else if (/\bcdn\d*\.bigcommerce\.com\b|\bstencil-utils\b|\bbigcommerce\b/i.test(combinedAssetsAndHtml)) {
    sitePlatform = 'bigcommerce';
  } else if (/\bmage\/cookies\b|\bMagento_[A-Za-z0-9]+\b|\bx-magento-init\b/i.test(combinedAssetsAndHtml)) {
    sitePlatform = 'magento';
  } else if (/\bstatic\.parastorage\.com\b|\bwix-ecommerce\b|\bwixstatic\.com\b/i.test(combinedAssetsAndHtml)) {
    sitePlatform = 'wix';
  } else if (/\bstatic\d*\.squarespace\.com\b|\bSquarespace\.onInitialize\b/i.test(combinedAssetsAndHtml)) {
    sitePlatform = 'squarespace';
  } else if (
    hasSaasVendor ||
    /\b(per\s+(?:seat|user)|api\s+docs|start\s+free\s+trial|billed\s+annually|saas|developer\s+platform)\b/i.test(
      combinedVisibleText,
    )
  ) {
    sitePlatform = 'saas-web';
  }

  let businessModel: BusinessModel = 'non_subscription';
  if (hasSubscriptionSignals) {
    const isEcommercePlatform =
      sitePlatform === 'shopify' ||
      sitePlatform === 'woocommerce' ||
      sitePlatform === 'bigcommerce' ||
      sitePlatform === 'magento';

    if (
      isEcommercePlatform ||
      hasDtcVendor ||
      /\b(subscribe\s*(?:&|and)\s*save|auto[- ]?deliver|auto[- ]?ship|add\s+to\s+cart)\b/i.test(
        combinedVisibleText,
      )
    ) {
      businessModel = 'dtc_ecommerce_subscription';
    } else if (
      sitePlatform === 'saas-web' ||
      hasSaasVendor ||
      /\b(per\s+(?:seat|user)|billed\s+annually|free\s+trial|pricing\s+plans?|enterprise\s+plan)\b/i.test(
        combinedVisibleText,
      )
    ) {
      businessModel = 'b2b_or_b2c_saas';
    } else {
      businessModel = 'membership_or_media';
    }
  }

  return {
    sitePlatform,
    subscriptionStack,
    hasSubscriptionSignals,
    matchedSubscriptionSignals: matchedSubscriptionSignals.slice(0, 6),
    businessModel,
  };
}

function anchorCombinedLabel(a: ParsedAnchor): string {
  return `${a.text} ${a.ariaLabel} ${a.title} ${a.href}`.trim();
}

export function discoverSubscriptionLinks(pages: ParsedHtmlDocument[]): DiscoveredSubscriptionLinks {
  let pricingUrl: string | null = null;
  let cancelPageUrl: string | null = null;
  let termsUrl: string | null = null;
  let billingOrFaqUrl: string | null = null;
  let privacyUrl: string | null = null;

  for (const page of pages) {
    for (const a of page.anchors) {
      if (!a.resolvedHref || !/^https?:/i.test(a.resolvedHref)) continue;
      const label = anchorCombinedLabel(a);

      if (
        !cancelPageUrl &&
        /\b(cancel[-_ ]?subscription|click[-_ ]?to[-_ ]?cancel|manage[-_ ]?subscription|\/cancel\b|cancell?ation|billing\.stripe\.com\/p\/|\/tools\/recurring)\b/i.test(
          label,
        )
      ) {
        cancelPageUrl = a.resolvedHref;
      }

      if (
        !pricingUrl &&
        /\b(pricing|plans|subscribe|subscriptions|membership)\b/i.test(label)
      ) {
        pricingUrl = a.resolvedHref;
      }

      if (
        !termsUrl &&
        /\b(terms[-_ ]?of[-_ ]?(?:service|use|sale)|terms[-_ ]?and[-_ ]?conditions|\bterms\b|\btos\b)\b/i.test(
          label,
        )
      ) {
        termsUrl = a.resolvedHref;
      }

      if (
        !billingOrFaqUrl &&
        /\b(billing|faq|help[-_ ]?center|refund[-_ ]?policy|returns)\b/i.test(label)
      ) {
        billingOrFaqUrl = a.resolvedHref;
      }

      if (!privacyUrl && /\b(privacy[-_ ]?policy|\bprivacy\b)\b/i.test(label)) {
        privacyUrl = a.resolvedHref;
      }
    }
  }

  return {
    pricingUrl,
    cancelPageUrl,
    termsUrl,
    billingOrFaqUrl,
    privacyUrl,
  };
}

/**
 * Selects up to `maxPages` same-origin internal subpages from the homepage to inspect,
 * prioritizing `/cancel`, `/billing`, `/pricing`, `/plans`, `/subscribe`, `/membership`, `/terms`, `/faq`, `/refund-policy`.
 */
export function selectPriorityInternalSubpages(
  homeDoc: ParsedHtmlDocument,
  homeFinalUrl: string,
  maxPages: number,
): string[] {
  if (maxPages <= 0) return [];

  let homeOrigin: string;
  let homeNormalized: string;
  try {
    const u = new URL(homeFinalUrl);
    homeOrigin = u.origin;
    u.hash = '';
    homeNormalized = u.toString();
  } catch {
    return [];
  }

  const scored = new Map<string, number>();

  for (const a of homeDoc.anchors) {
    if (!a.resolvedHref || !/^https?:/i.test(a.resolvedHref)) continue;

    let parsed: URL;
    try {
      parsed = new URL(a.resolvedHref);
    } catch {
      continue;
    }

    if (parsed.origin !== homeOrigin) continue;
    parsed.hash = '';
    const cleanUrl = parsed.toString();
    if (cleanUrl === homeNormalized) continue;

    if (ASSET_EXTENSION_RE.test(parsed.pathname) || /\.pdf(?:[?#]|$)/i.test(parsed.pathname)) {
      continue;
    }

    const label = `${a.text} ${a.ariaLabel} ${a.title} ${parsed.pathname}`.toLowerCase();
    let score = 0;

    // Priority 1: Direct cancellation / subscription management / billing portals
    if (
      /\b(cancel[-_\s]*subscription|click[-_\s]*to[-_\s]*cancel|manage[-_\s]*subscription|cancell?ation|\bcancel\b|billing|unsubscribe)\b/i.test(
        label,
      )
    ) {
      score = Math.max(score, 100);
    }

    // Priority 2: Pricing, Plans, Subscribe, Membership pages
    if (/\b(pricing|plans|subscribe|subscription|membership)\b/i.test(label)) {
      score = Math.max(score, 92);
    }

    // Priority 3: Terms of Service / Terms & Conditions (contains ARL, call-to-cancel traps & fee fine print)
    if (/\b(terms[-_\s]*of[-_\s]*(?:service|use|sale)|terms[-_\s]*and[-_\s]*conditions|\bterms\b|\btos\b|legal)\b/i.test(label)) {
      score = Math.max(score, 85);
    }

    // Priority 4: FAQ / Refund Policy / Help
    if (/\b(faq|frequently[-_\s]*asked|refund[-_\s]*policy|refunds|returns|help)\b/i.test(label)) {
      score = Math.max(score, 75);
    }

    if (score > 0) {
      if (a.inFooter || a.inNav) score += 5;
      const prev = scored.get(cleanUrl) ?? 0;
      if (score > prev) {
        scored.set(cleanUrl, score);
      }
    }
  }

  return Array.from(scored.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxPages)
    .map(([url]) => url);
}

const CALL_OR_EMAIL_OBSTRUCTION_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  {
    label: 'Phone call required to cancel',
    regex:
      /\b(?:must\s+call|please\s+call|call\s+(?:us|customer\s+(?:service|support|care)|member\s+services|our\s+(?:support|team)))(?:[\s\w()+-.,:]{0,45}?)\bto\s+cancel\b/i,
  },
  {
    label: 'Toll-free / phone number required to cancel',
    regex:
      /\bcall\s+(?:1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})(?:[\s\w,()-]{0,35}?)\bto\s+cancel\b/i,
  },
  {
    label: 'Cancellation requests restricted to phone',
    regex:
      /\bcancell?ation(?:s|\s+requests?)?\s+must\s+be\s+(?:made|requested|submitted|completed)\s+(?:by|via|over\s+the)\s+(?:phone|telephone|calling)\b/i,
  },
  {
    label: 'Cancel by phone only',
    regex: /\bcancel(?:l?ations?)?\s+by\s+(?:phone|telephone)\s+only\b|\bonly\s+by\s+calling\b/i,
  },
  {
    label: 'Email support required to request cancellation',
    regex:
      /\b(?:must\s+email|email\s+(?:us|support|customer\s+(?:service|support)|billing)(?:\s+at\s+[^\s,;]+)?\s+to\s+(?:request\s+)?cancell?(?:ation)?|cancell?ation\s+requests?\s+must\s+be\s+emailed)\b/i,
  },
  {
    label: 'Live chat / retention agent required to cancel',
    regex:
      /\b(?:chat\s+with\s+(?:an?\s+)?(?:agent|representative|support|specialist)|speak\s+(?:with|to)\s+(?:an?\s+)?(?:agent|representative|retention\s+specialist))\s+to\s+cancel\b/i,
  },
  {
    label: 'Online cancellation explicitly disallowed',
    regex:
      /\b(?:cannot|can't|may\s+not)\s+be\s+cancell?ed\s+online\b|\bonline\s+cancell?ation\s+is\s+(?:not\s+available|unavailable|disabled)\b|\bcancell?ations?\s+are\s+not\s+accepted\s+online\b/i,
  },
  {
    label: 'Postal mail required to cancel',
    regex: /\b(?:certified\s+mail|in\s+writing\s+by\s+mail)\s+to\s+cancel\b/i,
  },
];

const MANDATORY_SURVEY_PROSE_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  {
    label: 'Mandatory exit/cancellation survey text',
    regex: /\b(?:mandatory|required)\s+(?:exit|cancell?ation)\s+(?:survey|questionnaire|interview|form)\b/i,
  },
  {
    label: 'Must complete survey prior to cancellation',
    regex:
      /\b(?:must\s+complete|required\s+to\s+complete)\s+(?:an?\s+|our\s+)?(?:exit\s+|cancell?ation\s+|brief\s+)?(?:survey|questionnaire|interview)\s+(?:before|prior\s+to|in\s+order\s+to|to)\s+cancell?(?:ing)?\b/i,
  },
];

const SELF_SERVE_PROSE_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'Cancel online anytime', regex: /\bcancel\s+(?:your\s+(?:subscription|membership|plan)\s+)?online\s+anytime\b/i },
  { label: 'Cancel anytime online', regex: /\bcancel\s+anytime\s+online\b/i },
  { label: 'One-click online cancellation', regex: /\b(?:one|1)[- ]click\s+(?:online\s+)?cancell?ation\b/i },
  { label: 'Self-serve cancellation portal', regex: /\bself[- ]serv(?:e|ice)\s+(?:online\s+)?cancell?ation(?:\s+portal)?\b/i },
  { label: 'Cancel directly in account settings', regex: /\bcancel\s+directly\s+(?:from|in)\s+your\s+(?:online\s+)?account\b/i },
];

/**
 * Core Check #2: Online Click-to-Cancel vs. Call/Email/Survey Obstruction
 * (CA AB 2863, NY GBL § 527-a & NYC Oct 2026 Rule, CO SB 25-145 B2B SaaS, Federal ROSCA)
 */
export function checkClickToCancel(
  pages: InspectedPageBundle[],
  hasSubscriptionSignals: boolean,
  enabled: boolean,
): ClickToCancelCheckResult {
  if (!enabled) {
    return {
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
    };
  }

  if (!hasSubscriptionSignals) {
    return {
      checked: true,
      cancellationStatus: 'no_subscription_detected',
      onlineSelfServeFound: false,
      cancelPortalUrl: null,
      cancelButtonLabel: null,
      obstructionFound: false,
      obstructionSignals: [],
      mandatorySurveyGateFound: false,
      surveySignals: [],
      selfServeSignals: [],
      foundOnPages: [],
    };
  }

  let onlineSelfServeFound = false;
  let cancelPortalUrl: string | null = null;
  let cancelButtonLabel: string | null = null;
  const selfServeSignals: string[] = [];
  const obstructionSignals: string[] = [];
  const surveySignals: string[] = [];
  const foundOnPages = new Set<string>();

  for (const { doc, finalUrl } of pages) {
    const text = doc.visibleText;

    // 1. Check Call-Only / Email-Only / No-Online-Cancel Obstructions
    for (const pat of CALL_OR_EMAIL_OBSTRUCTION_PATTERNS) {
      const m = pat.regex.exec(text);
      if (m && m.index !== undefined) {
        const quote = extractPhraseContext(text, m.index, m[0].length);
        obstructionSignals.push(`${pat.label}: "${quote}" (${finalUrl})`);
        foundOnPages.add(finalUrl);
      }
    }

    // 2. Check Mandatory Exit Survey / Retention Gate (DOM + Prose)
    const isCancelRelatedPage =
      /\b(cancel|cancell?ation|unsubscribe|manage[-_ ]?subscription)\b/i.test(
        `${finalUrl} ${doc.title ?? ''}`,
      );

    for (const form of doc.forms) {
      const formCancelContext = /\b(cancel|cancell?ation|unsubscribe|terminate[-_ ]?subscription)\b/i.test(
        `${finalUrl} ${form.id} ${form.className} ${form.action} ${form.buttonTexts.join(' ')} ${form.textSnippet}`,
      );
      if (formCancelContext && form.requiredSurveyFields.length > 0) {
        surveySignals.push(
          `Cancellation form requires survey field(s) ${form.requiredSurveyFields.join(', ')} before submitting (${finalUrl})`,
        );
        foundOnPages.add(finalUrl);
      }
    }

    if (isCancelRelatedPage && doc.requiredSurveyControls.length > 0 && surveySignals.length === 0) {
      surveySignals.push(
        `Cancellation page contains required exit-survey control(s) ${doc.requiredSurveyControls.join(', ')} (${finalUrl})`,
      );
      foundOnPages.add(finalUrl);
    }

    for (const sPat of MANDATORY_SURVEY_PROSE_PATTERNS) {
      const sm = sPat.regex.exec(text);
      if (sm && sm.index !== undefined) {
        const quote = extractPhraseContext(text, sm.index, sm[0].length);
        surveySignals.push(`${sPat.label}: "${quote}" (${finalUrl})`);
        foundOnPages.add(finalUrl);
      }
    }

    // 3. Check Interactive Self-Serve Cancellation Portals, Links & Buttons
    for (const a of doc.anchors) {
      const hrefTarget = a.resolvedHref || a.href;
      if (!hrefTarget || /^(?:mailto|tel|javascript):/i.test(hrefTarget) || /\.pdf(?:[?#]|$)/i.test(hrefTarget)) {
        continue;
      }
      const combinedAnchor = `${a.text} ${a.ariaLabel} ${a.title}`;
      const isDirectCancelLink =
        /\b(click[- ]to[- ]cancel|cancel\s+(?:my\s+|your\s+)?(?:subscription|membership|plan|auto[- ]?renewal)|manage\s+(?:my\s+|your\s+)?subscriptions?|self[- ]serve\s+cancell?ation)\b/i.test(
          combinedAnchor,
        ) ||
        /(?:\/cancel(?:-subscription|lation)?|\/account\/subscriptions|\/manage-subscription|\/tools\/recurring\/|billing\.stripe\.com\/p\/|\/a\/loop_subscriptions)(?:[/?#]|$)/i.test(
          hrefTarget,
        );

      if (isDirectCancelLink) {
        onlineSelfServeFound = true;
        cancelPortalUrl = cancelPortalUrl ?? hrefTarget;
        cancelButtonLabel = cancelButtonLabel ?? (a.text || a.ariaLabel || 'Cancel Subscription');
        selfServeSignals.push(
          `Self-serve cancellation link "${cancelButtonLabel}" -> ${hrefTarget}`,
        );
      }
    }

    for (const ctrl of doc.controls) {
      const combinedCtrl = `${ctrl.text} ${ctrl.ariaLabel} ${ctrl.id} ${ctrl.className} ${ctrl.dataAttributes}`;
      if (
        /\b(click[- ]to[- ]cancel|cancel\s+(?:my\s+|your\s+)?(?:subscription|membership|plan|now)|confirm\s+cancell?ation)\b/i.test(
          combinedCtrl,
        )
      ) {
        onlineSelfServeFound = true;
        cancelPortalUrl = cancelPortalUrl ?? finalUrl;
        cancelButtonLabel = cancelButtonLabel ?? (ctrl.text || ctrl.ariaLabel || 'Cancel Subscription');
        selfServeSignals.push(`Interactive <${ctrl.tag}> "${cancelButtonLabel}" on ${finalUrl}`);
      }
    }

    for (const pPat of SELF_SERVE_PROSE_PATTERNS) {
      const pm = pPat.regex.exec(text);
      if (pm && pm.index !== undefined) {
        const preceding = text.slice(Math.max(0, pm.index - 24), pm.index).toLowerCase();
        if (/\b(not|cannot|can't|never|no|unable\s+to)\s+$/.test(preceding)) {
          continue;
        }
        onlineSelfServeFound = true;
        cancelPortalUrl = cancelPortalUrl ?? finalUrl;
        selfServeSignals.push(`${pPat.label} disclosed on ${finalUrl}`);
      }
    }
  }

  const obstructionFound = obstructionSignals.length > 0;
  const mandatorySurveyGateFound = surveySignals.length > 0;

  let cancellationStatus: CancellationStatus;
  if (obstructionFound) {
    cancellationStatus = 'call_or_email_obstruction';
  } else if (mandatorySurveyGateFound) {
    cancellationStatus = 'survey_gated';
  } else if (onlineSelfServeFound) {
    cancellationStatus = 'online_self_serve_found';
  } else {
    cancellationStatus = 'no_cancel_mechanism_disclosed';
  }

  return {
    checked: true,
    cancellationStatus,
    onlineSelfServeFound: onlineSelfServeFound && !obstructionFound && !mandatorySurveyGateFound,
    cancelPortalUrl,
    cancelButtonLabel,
    obstructionFound,
    obstructionSignals: Array.from(new Set(obstructionSignals)).slice(0, 6),
    mandatorySurveyGateFound,
    surveySignals: Array.from(new Set(surveySignals)).slice(0, 6),
    selfServeSignals: Array.from(new Set(selfServeSignals)).slice(0, 6),
    foundOnPages: Array.from(foundOnPages),
  };
}

const CONSENT_CHECKBOX_TOPIC_RE =
  /\b(subscribe|subscription|auto[-_ ]?renew(?:al)?|recurring|membership|billing|free\s+trial|continuous\s+service|deliver\s+every|agree|terms)\b/i;

const AUTO_RENEWAL_DISCLOSURE_RE =
  /\b(renews\s+automatically|automatically\s+renews|auto[- ]?renews?\s+(?:monthly|annually|yearly|every|at|until)|billed\s+(?:monthly|annually|yearly|automatically)\s+until\s+(?:you\s+)?cancel|recurring\s+(?:monthly|annual|periodic)\s+charges?\s+until\s+(?:you\s+)?cancel|continuous\s+service\s+until\s+cancell?ed)\b/i;

const FREE_TRIAL_OFFER_RE =
  /\b(\d{1,2}[- ]day\s+(?:free\s+)?trial|free\s+trial|try\s+(?:it\s+)?free\s+for\s+\d+\s+days|start\s+your\s+free\s+trial)\b/i;

const TRIAL_CONVERSION_TERMS_RE =
  /\b(after\s+(?:your\s+|the\s+)?(?:free\s+)?trial(?:\s+ends|\s+period)?|when\s+(?:your\s+|the\s+)?trial\s+ends|trial\s+converts\s+to|then\s+\$\s*\d+|unless\s+you\s+cancel\s+before\s+(?:the\s+)?(?:end\s+of\s+)?(?:your\s+|the\s+)?trial|charged\s+\$\s*\d+[^.]{0,45}after)\b/i;

/**
 * Core Check #3: Affirmative Auto-Renewal Consent, Pre-Checked Dark-Patterns & Trial Conversion Terms
 * (CA AB 2863 Cal. Bus. & Prof. Code § 17602, Federal ROSCA 15 U.S.C. § 8403, CO SB 25-145)
 */
export function checkAffirmativeConsent(
  pages: InspectedPageBundle[],
  hasSubscriptionSignals: boolean,
  enabled: boolean,
): AffirmativeConsentCheckResult {
  if (!enabled || !hasSubscriptionSignals) {
    return {
      checked: enabled,
      preCheckedConsentBoxFound: false,
      preCheckedSignals: [],
      expressUncheckedConsentFound: false,
      autoRenewalTermsDisclosed: !hasSubscriptionSignals,
      freeTrialDetected: false,
      trialConversionTermsDisclosed: false,
      missingTrialConversionRisk: false,
      matchedConsentSignals: [],
      foundOnPages: [],
    };
  }

  const preCheckedSignals: string[] = [];
  const matchedConsentSignals: string[] = [];
  const foundOnPages = new Set<string>();
  let expressUncheckedConsentFound = false;
  let autoRenewalTermsDisclosed = false;
  let freeTrialDetected = false;
  let trialConversionTermsDisclosed = false;

  for (const { doc, finalUrl } of pages) {
    const text = doc.visibleText;

    for (const cb of doc.checkboxes) {
      const cbSignalText = `${cb.name} ${cb.id} ${cb.className} ${cb.associatedText}`;
      if (!CONSENT_CHECKBOX_TOPIC_RE.test(cbSignalText)) {
        continue;
      }
      const snippet = cb.associatedText.slice(0, 140) || cb.name || cb.id || 'checkbox';
      if (cb.checked) {
        preCheckedSignals.push(
          `Pre-checked checkbox (${cb.name || cb.id || 'input[type=checkbox]'}) near "${snippet}" on ${finalUrl}`,
        );
        foundOnPages.add(finalUrl);
      } else {
        expressUncheckedConsentFound = true;
        matchedConsentSignals.push(
          `Unchecked affirmative consent checkbox (${cb.name || cb.id || 'checkbox'}) on ${finalUrl}`,
        );
      }
    }

    const arMatch = AUTO_RENEWAL_DISCLOSURE_RE.exec(text);
    if (arMatch && arMatch.index !== undefined) {
      autoRenewalTermsDisclosed = true;
      matchedConsentSignals.push(
        `Auto-renewal disclosure "${extractPhraseContext(text, arMatch.index, arMatch[0].length)}" on ${finalUrl}`,
      );
    }

    if (FREE_TRIAL_OFFER_RE.test(text)) {
      freeTrialDetected = true;
      foundOnPages.add(finalUrl);
    }

    const tcMatch = TRIAL_CONVERSION_TERMS_RE.exec(text);
    if (tcMatch && tcMatch.index !== undefined) {
      trialConversionTermsDisclosed = true;
      matchedConsentSignals.push(
        `Trial conversion disclosure "${extractPhraseContext(text, tcMatch.index, tcMatch[0].length)}" on ${finalUrl}`,
      );
    }
  }

  const preCheckedConsentBoxFound = preCheckedSignals.length > 0;
  const missingTrialConversionRisk = freeTrialDetected && !trialConversionTermsDisclosed;

  return {
    checked: true,
    preCheckedConsentBoxFound,
    preCheckedSignals: Array.from(new Set(preCheckedSignals)).slice(0, 5),
    expressUncheckedConsentFound,
    autoRenewalTermsDisclosed,
    freeTrialDetected,
    trialConversionTermsDisclosed,
    missingTrialConversionRisk,
    matchedConsentSignals: Array.from(new Set(matchedConsentSignals)).slice(0, 6),
    foundOnPages: Array.from(foundOnPages),
  };
}

const DRIP_FEE_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  {
    label: 'Mandatory processing/service fee',
    regex:
      /\bmandatory\s+(?:\d+(?:\.\d+)?%\s+|\$\d+(?:\.\d{1,2})?\s+)?(?:service|processing|handling|platform|admin(?:istrative)?|fulfillment)\s+(?:fee|surcharge)(?:\s+(?:added|applies|charged)\s+at\s+checkout)?\b/i,
  },
  {
    label: 'Fee added/applied at checkout',
    regex:
      /\b(?:service|processing|platform|convenience|handling|fulfillment)\s+(?:fee|surcharge)\s+(?:is\s+)?(?:added|applies|applied|calculated)\s+at\s+checkout\b/i,
  },
  {
    label: 'Plus mandatory/service/convenience fee',
    regex:
      /\bplus\s+a\s+(?:mandatory\s+)?(?:\$\d+(?:\.\d{1,2})?\s+|\d+(?:\.\d+)?%\s+)?(?:service|processing|convenience|handling|platform)\s+(?:fee|surcharge)\b/i,
  },
  {
    label: 'Convenience / handling surcharge',
    regex: /\b(?:convenience\s+fee|handling\s+surcharge|regulatory\s+recovery\s+fee)\b/i,
  },
  {
    label: 'Price excludes mandatory fees',
    regex: /\bexcludes\s+mandatory\s+(?:service\s+|processing\s+|platform\s+)?(?:fees|charges|surcharges)\b/i,
  },
];

/**
 * Core Check #4: Drip Pricing / Hidden Mandatory Junk Fee Signals
 * (California Honest Pricing Law SB 478 / Cal. Civ. Code § 1770(a)(29) & FTC Junk Fees Rule)
 */
export function checkDripFees(
  pages: InspectedPageBundle[],
  enabled: boolean,
): DripFeeCheckResult {
  if (!enabled) {
    return {
      checked: false,
      dripFeeSignalsFound: false,
      dripFeeRisk: false,
      matchedDripFeePhrases: [],
      foundOnPages: [],
    };
  }

  const matchedDripFeePhrases: string[] = [];
  const seenLabels = new Set<string>();
  const foundOnPages = new Set<string>();

  for (const { doc, finalUrl } of pages) {
    const text = doc.visibleText;

    for (const pat of DRIP_FEE_PATTERNS) {
      const m = pat.regex.exec(text);
      if (m && m.index !== undefined) {
        // Guard against explicit negations like "no convenience fee" or "zero processing fees added at checkout"
        const preceding = text.slice(Math.max(0, m.index - 32), m.index).toLowerCase();
        if (/\b(no|zero|without|never|free\s+of|0%|0\.00)\s+(?:any\s+|hidden\s+|added\s+)?$/.test(preceding)) {
          continue;
        }

        foundOnPages.add(finalUrl);
        if (!seenLabels.has(pat.label) && matchedDripFeePhrases.length < 5) {
          seenLabels.add(pat.label);
          const quote = extractPhraseContext(text, m.index, m[0].length);
          matchedDripFeePhrases.push(`${pat.label}: "${quote}"`);
        }
      }
    }
  }

  const dripFeeSignalsFound = matchedDripFeePhrases.length > 0;

  return {
    checked: true,
    dripFeeSignalsFound,
    dripFeeRisk: dripFeeSignalsFound,
    matchedDripFeePhrases,
    foundOnPages: Array.from(foundOnPages),
  };
}
