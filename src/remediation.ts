import type {
  AffirmativeConsentCheckResult,
  BusinessModel,
  ClickToCancelCheckResult,
  ComplianceFinding,
  DiscoveredSubscriptionLinks,
  DripFeeCheckResult,
  RecommendedNextActor,
  RemediationPack,
  RiskTier,
  SitePlatform,
  SubscriptionVendor,
} from './types.js';

export const US_STATUTORY_CONTEXT_SUMMARY =
  'While the 2024 federal FTC Negative Option Rule was procedurally vacated in July 2025 (with renewed FTC rulemaking underway in 2026), active enforcement is surging under California ARL (Cal. Bus. & Prof. Code §§ 17600–17606, amended by AB 2863 eff. July 1, 2025), New York ARL (N.Y. Gen. Bus. Law § 527-a, Nov 2025) & NYC Click-to-Cancel Rule (eff. Oct 1, 2026), Colorado Online Cancellation Act (SB 25-145, extended to B2B SaaS eff. Feb 16, 2026), Federal ROSCA (15 U.S.C. § 8403), and California Honest Pricing / Drip-Fee Law (SB 478, Cal. Civ. Code § 1770(a)(29)).';

export function buildFindingsAndScore(params: {
  homeUrl: string;
  businessModel: BusinessModel;
  hasSubscriptionSignals: boolean;
  discoveredLinks: DiscoveredSubscriptionLinks;
  clickToCancel: ClickToCancelCheckResult;
  affirmativeConsent: AffirmativeConsentCheckResult;
  dripFee: DripFeeCheckResult;
}): {
  findings: ComplianceFinding[];
  complianceScore: number;
  riskTier: RiskTier;
} {
  const {
    homeUrl,
    businessModel,
    hasSubscriptionSignals,
    discoveredLinks,
    clickToCancel,
    affirmativeConsent,
    dripFee,
  } = params;

  const findings: ComplianceFinding[] = [];
  let deductions = 0;

  const b2bSaasNote =
    businessModel === 'b2b_or_b2c_saas'
      ? ' (including B2B SaaS contracts under Colorado SB 25-145 eff. Feb 16, 2026)'
      : '';

  // 1. Click-to-Cancel & Anti-Obstruction Checks
  if (clickToCancel.checked && hasSubscriptionSignals) {
    if (clickToCancel.cancellationStatus === 'call_or_email_obstruction') {
      deductions += 45;
      findings.push({
        ruleId: 'US-ARL-CLICK-TO-CANCEL-OBSTRUCTION',
        title: 'Phone / Support-Gate Cancellation Trap — Online Click-to-Cancel Obstructed',
        regulation: `California ARL (Cal. Bus. & Prof. Code § 17602(c)-(d), AB 2863 eff. July 1, 2025), New York GBL § 527-a, Colorado SB 25-145${b2bSaasNote}, and Federal ROSCA (15 U.S.C. § 8403(3))`,
        severity: 'CRITICAL',
        pageUrl:
          clickToCancel.foundOnPages[0] ||
          discoveredLinks.termsUrl ||
          discoveredLinks.billingOrFaqUrl ||
          homeUrl,
        evidence:
          clickToCancel.obstructionSignals[0] ||
          'Terms or support copy require calling customer service, emailing support, or chatting with an agent to cancel an online subscription.',
        recommendation:
          'Remove phone-only / agent-gated cancellation restrictions immediately and provide a prominent, same-medium online Click-to-Cancel button or self-serve cancellation portal accessible without live-agent friction.',
      });
    } else if (clickToCancel.cancellationStatus === 'survey_gated') {
      deductions += 30;
      findings.push({
        ruleId: 'US-NYC-ARL-MANDATORY-SURVEY-GATE',
        title: 'Mandatory Exit Survey / Questionnaire Blocking Online Subscription Cancellation',
        regulation:
          'NYC Click-to-Cancel Rule (6 RCNY, eff. October 1, 2026), New York GBL § 527-a (Nov 2025), and California AB 2863 anti-obstruction rules',
        severity: 'HIGH',
        pageUrl: clickToCancel.foundOnPages[0] || discoveredLinks.cancelPageUrl || homeUrl,
        evidence:
          clickToCancel.surveySignals[0] ||
          'Cancellation flow contains mandatory `required` exit-survey fields or terms requiring completion of an exit questionnaire before canceling.',
        recommendation:
          'Make all exit-reason dropdowns and feedback fields strictly optional (remove HTML `required` attributes) and allow immediate 1-step online cancellation without forcing subscribers through retention surveys.',
      });
    } else if (clickToCancel.cancellationStatus === 'no_cancel_mechanism_disclosed') {
      deductions += 25;
      findings.push({
        ruleId: 'US-ARL-NO-ONLINE-CANCEL-MECHANISM',
        title: 'No Visible Self-Serve Online Cancellation Link or Mechanism Disclosed',
        regulation: `California AB 2863 (Cal. Bus. & Prof. Code § 17602), Colorado SB 25-145${b2bSaasNote}, and NY GBL § 527-a`,
        severity: 'HIGH',
        pageUrl: discoveredLinks.pricingUrl || discoveredLinks.termsUrl || homeUrl,
        evidence:
          'Recurring subscription or membership signals were detected, but no online Click-to-Cancel portal link, manage-subscription URL, or clear online cancellation instruction was found on inspected pages.',
        recommendation:
          'Publish a direct self-serve online cancellation link (e.g. `/cancel-subscription` or customer billing portal) in account settings, footer, and recurring billing disclosures.',
      });
    }
  }

  // 2. Affirmative Consent, Pre-Checked Checkboxes & Free-Trial Conversion Disclosures
  if (affirmativeConsent.checked && hasSubscriptionSignals) {
    if (affirmativeConsent.preCheckedConsentBoxFound) {
      deductions += 35;
      findings.push({
        ruleId: 'US-ROSCA-CA-AB2863-PRECHECKED-CONSENT',
        title: 'Pre-Checked Subscription / Auto-Renewal Consent Checkbox Dark Pattern',
        regulation:
          'California AB 2863 (Cal. Bus. & Prof. Code § 17602(a)(4) separate express affirmative consent) & Federal ROSCA (15 U.S.C. § 8403(2))',
        severity: 'CRITICAL',
        pageUrl: affirmativeConsent.foundOnPages[0] || discoveredLinks.pricingUrl || homeUrl,
        evidence:
          affirmativeConsent.preCheckedSignals[0] ||
          'Detected `<input type="checkbox" checked>` pre-selecting recurring subscription or auto-renewal terms.',
        recommendation:
          'Remove the `checked` attribute so the express auto-renewal consent checkbox defaults to unchecked, validate affirmative opt-in prior to billing, and retain timestamped consent records for at least 3 years under CA AB 2863.',
      });
    }

    if (affirmativeConsent.missingTrialConversionRisk) {
      deductions += 20;
      findings.push({
        ruleId: 'US-CA-AB2863-TRIAL-CONVERSION-UNDISCLOSED',
        title: 'Free Trial Offer Detected Without Clear Post-Trial Price & Conversion Deadline Disclosure',
        regulation:
          'California ARL (Cal. Bus. & Prof. Code § 17602(a)(1)-(3), AB 2863) & Federal ROSCA (15 U.S.C. § 8403(1))',
        severity: 'HIGH',
        pageUrl: affirmativeConsent.foundOnPages[0] || discoveredLinks.pricingUrl || homeUrl,
        evidence:
          'A free trial offer was detected on inspected pages without clear adjacent disclosure of the post-trial recurring charge amount, billing frequency, and cancellation deadline before conversion.',
        recommendation:
          'Clearly and conspicuously state immediately adjacent to the trial CTA the exact recurring dollar amount, billing cadence, and date/deadline by which the subscriber must cancel to avoid being charged.',
      });
    }

    if (!affirmativeConsent.autoRenewalTermsDisclosed) {
      deductions += 15;
      findings.push({
        ruleId: 'US-ARL-MISSING-AUTORENEW-DISCLOSURE',
        title: 'Missing Clear Continuous Auto-Renewal & Cancellation Disclosure',
        regulation: `California ARL (Cal. Bus. & Prof. Code § 17602(a)(1)), NY GBL § 527-a, and Colorado SB 25-145${b2bSaasNote}`,
        severity: 'MODERATE',
        pageUrl: discoveredLinks.pricingUrl || discoveredLinks.termsUrl || homeUrl,
        evidence:
          'Subscription or recurring pricing signals were detected without explicit automatic-renewal disclosure phrasing (e.g., "renews automatically at $X/mo until you cancel").',
        recommendation:
          'Display clear, conspicuous automatic-renewal terms (recurring amount, billing interval, continuous renewal until canceled, and online cancellation method) in visual proximity to the purchase/consent control.',
      });
    }
  }

  // 3. Drip Pricing / Hidden Mandatory Junk Fees (CA SB 478)
  if (dripFee.checked && dripFee.dripFeeRisk) {
    deductions += 20;
    findings.push({
      ruleId: 'US-CA-SB478-DRIP-JUNK-FEE',
      title: 'Mandatory Service / Processing / Convenience Drip Fee Disclosed Outside Upfront Price',
      regulation:
        'California Honest Pricing Law (SB 478, Cal. Civ. Code § 1770(a)(29)) & State Unfair/Deceptive Pricing Statutes',
      severity: 'HIGH',
      pageUrl: dripFee.foundOnPages[0] || discoveredLinks.pricingUrl || homeUrl,
      evidence: `Detected mandatory add-on fee phrasing (${dripFee.matchedDripFeePhrases.slice(0, 3).join('; ')}) indicating charges added separately at checkout or in fine print.`,
      recommendation:
        'Include all mandatory non-governmental service, processing, handling, or platform fees directly in the upfront advertised price (excluding only government taxes and bona fide shipping charges).',
    });
  }

  const severityOrder: Record<ComplianceFinding['severity'], number> = {
    CRITICAL: 0,
    HIGH: 1,
    MODERATE: 2,
    LOW: 3,
  };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const complianceScore = Math.max(0, Math.min(100, 100 - deductions));

  let riskTier: RiskTier;
  if (findings.some((f) => f.severity === 'CRITICAL') || complianceScore <= 35) {
    riskTier = 'CRITICAL';
  } else if (findings.some((f) => f.severity === 'HIGH') || complianceScore <= 70) {
    riskTier = 'HIGH';
  } else if (findings.length > 0 || complianceScore <= 85) {
    riskTier = 'MODERATE';
  } else {
    riskTier = 'LOW';
  }

  return { findings, complianceScore, riskTier };
}

function formatPlatformAndStackLabel(
  platform: SitePlatform,
  stack: SubscriptionVendor[],
  domain: string,
): string {
  const platformNames: Record<SitePlatform, string> = {
    shopify: 'Shopify',
    woocommerce: 'WooCommerce',
    bigcommerce: 'BigCommerce',
    magento: 'Magento',
    wix: 'Wix',
    squarespace: 'Squarespace',
    'saas-web': 'SaaS',
    custom: 'online',
  };
  const stackLabel =
    stack.length > 0
      ? ` + ${stack[0]
          .split('-')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ')}`
      : '';

  if (platform === 'custom' && !stackLabel) {
    return `your site (${domain})`;
  }
  return `your ${platformNames[platform]}${stackLabel} storefront/app (${domain})`;
}

/**
 * Generates a neutral, factual 1-2 sentence B2B outreach observation (NOT legal advice).
 */
export function generateColdOutreachHook(params: {
  domain: string;
  sitePlatform: SitePlatform;
  subscriptionStack: SubscriptionVendor[];
  hasSubscriptionSignals: boolean;
  clickToCancel: ClickToCancelCheckResult;
  affirmativeConsent: AffirmativeConsentCheckResult;
  dripFee: DripFeeCheckResult;
  findings: ComplianceFinding[];
}): string {
  const {
    domain,
    sitePlatform,
    subscriptionStack,
    hasSubscriptionSignals,
    clickToCancel,
    affirmativeConsent,
    dripFee,
    findings,
  } = params;

  const targetDesc = formatPlatformAndStackLabel(sitePlatform, subscriptionStack, domain);

  if (!hasSubscriptionSignals && findings.length === 0) {
    return `An automated technical scan of ${domain} found no recurring subscription dark patterns or mandatory drip-fee disclosures on inspected public pages.`;
  }

  if (findings.length === 0) {
    return `An automated technical review of ${targetDesc} detected a self-serve online cancellation path, affirmative auto-renewal disclosures, and transparent upfront pricing with zero heuristic ARL/ROSCA flags.`;
  }

  const observations: string[] = [];

  if (clickToCancel.cancellationStatus === 'call_or_email_obstruction') {
    observations.push(
      'cancellation copy instructs subscribers to call or contact support rather than offering a direct self-serve online Click-to-Cancel flow',
    );
  } else if (clickToCancel.cancellationStatus === 'survey_gated') {
    observations.push(
      'the online cancellation flow gates submission behind mandatory exit-survey fields',
    );
  } else if (clickToCancel.cancellationStatus === 'no_cancel_mechanism_disclosed') {
    observations.push(
      'recurring subscription offers appear without a visible self-serve online cancellation link or portal reference',
    );
  }

  if (affirmativeConsent.preCheckedConsentBoxFound) {
    observations.push(
      'a recurring/auto-renewal consent checkbox renders pre-checked (`checked`) by default',
    );
  } else if (affirmativeConsent.missingTrialConversionRisk) {
    observations.push(
      'a free-trial offer appears without adjacent post-trial price and conversion-deadline wording',
    );
  } else if (!affirmativeConsent.autoRenewalTermsDisclosed && hasSubscriptionSignals) {
    observations.push(
      'recurring pricing appears without explicit continuous auto-renewal disclosure text nearby',
    );
  }

  if (dripFee.dripFeeRisk) {
    observations.push(
      'mandatory service/processing fee wording appears outside the primary displayed price',
    );
  }

  const topTwo = observations.slice(0, 2).join(', and ');
  const extraCount = Math.max(0, observations.length - 2);
  const suffix =
    extraCount > 0 ? ` (plus ${extraCount} additional subscription/pricing signal${extraCount > 1 ? 's' : ''})` : '';

  return `While running a technical US subscription & ARL check on ${targetDesc}, we noticed ${topTwo}${suffix} — happy to send over the technical audit notes and ready-to-paste CA AB 2863 / CO SB 25-145 HTML/JS consent + 1-click cancel snippets if helpful for your team.`;
}

/**
 * Generates ready-to-paste CA AB 2863 / CO SB 25-145 / NY GBL § 527-a / ROSCA compliant:
 * 1) Unchecked Express Auto-Renewal Consent Box (HTML/JS)
 * 2) 1-Click Online Cancellation Modal without mandatory survey gates (HTML/JS)
 */
export function generateRemediationPack(params: {
  domain: string;
  sitePlatform: SitePlatform;
  businessModel: BusinessModel;
  subscriptionStack: SubscriptionVendor[];
  dripFee: DripFeeCheckResult;
}): RemediationPack {
  const { domain, sitePlatform, businessModel, subscriptionStack, dripFee } = params;

  const isShopifyDtc =
    sitePlatform === 'shopify' || businessModel === 'dtc_ecommerce_subscription';

  const pricePlaceholder = isShopifyDtc
    ? '{{ selling_plan_allocation.price | default: product.price | money }}/month'
    : '$49.00/month';

  const affirmativeConsentSnippetHtml = `<!-- US Auto-Renewal Law (CA AB 2863 § 17602(a)(4), CO SB 25-145, NY GBL § 527-a & ROSCA) Express Unchecked Consent Block (${domain}) -->
<div class="us-arl-consent-box" style="border:1px solid #d1d5db;border-radius:8px;padding:14px 16px;margin:14px 0;background:#f9fafb;font-family:system-ui,sans-serif;">
  <label for="us-arl-express-consent" style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:0.9rem;line-height:1.45;color:#111827;">
    <!-- CRITICAL: Must NEVER include the "checked" attribute by default -->
    <input
      id="us-arl-express-consent"
      name="expressAutoRenewalConsent"
      type="checkbox"
      required
      aria-required="true"
      style="margin-top:3px;width:18px;height:18px;flex-shrink:0;"
    />
    <span>
      <strong>Automatic Renewal Terms:</strong> I expressly authorize <strong>${domain}</strong> to charge my payment method
      <strong>${pricePlaceholder}</strong> (inclusive of all mandatory fees, plus applicable tax) on a recurring monthly basis
      after any stated trial period ends, <strong>until I cancel</strong>. I understand I can cancel online anytime in 1 click at
      <a href="/cancel-subscription" style="color:#1d4ed8;text-decoration:underline;">${domain}/cancel-subscription</a>
      or in my account billing settings before the next billing date to avoid future charges.
    </span>
  </label>
</div>
<script>
(function () {
  var cb = document.getElementById('us-arl-express-consent');
  if (!cb || !cb.form) return;
  cb.form.addEventListener('submit', function (ev) {
    if (!cb.checked) {
      ev.preventDefault();
      cb.reportValidity();
      return;
    }
    // Attach timestamped affirmative consent proof (retain >= 3 years per CA AB 2863 § 17602(a)(4))
    var proofInput = cb.form.querySelector('input[name="arlConsentTimestampIso"]');
    if (!proofInput) {
      proofInput = document.createElement('input');
      proofInput.type = 'hidden';
      proofInput.name = 'arlConsentTimestampIso';
      cb.form.appendChild(proofInput);
    }
    proofInput.value = new Date().toISOString();
  });
})();
</script>`;

  const oneClickCancelModalHtmlJs = `<!-- US Same-Medium 1-Click Online Cancellation Modal (CA AB 2863, NYC Oct 2026 No-Mandatory-Survey Rule & CO SB 25-145) -->
<div id="us-click-to-cancel-root" data-domain="${domain}" style="font-family:system-ui,sans-serif;">
  <button type="button" id="us-open-cancel-modal-btn" aria-haspopup="dialog" aria-controls="us-cancel-subscription-dialog"
    style="padding:10px 16px;border:1px solid #1f2937;background:#ffffff;color:#111827;border-radius:6px;font-weight:600;cursor:pointer;">
    Click to Cancel Subscription
  </button>

  <dialog id="us-cancel-subscription-dialog" aria-labelledby="us-cancel-dialog-title"
    style="max-width:460px;width:92%;border:1px solid #d1d5db;border-radius:10px;padding:22px;">
    <h2 id="us-cancel-dialog-title" style="margin:0 0 10px;font-size:1.125rem;">Cancel Your Subscription Online</h2>
    <p style="margin:0 0 14px;font-size:0.875rem;color:#374151;">
      Submit below to immediately stop future recurring charges. An instant email confirmation will be sent for your records.
    </p>
    <form id="us-one-click-cancel-form" method="post" action="/api/subscriptions/cancel-online">
      <label for="us-cancel-email" style="display:block;font-size:0.85rem;font-weight:600;margin-bottom:4px;">Account or Order Email *</label>
      <input id="us-cancel-email" name="subscriberEmail" type="email" required autocomplete="email"
        style="width:100%;padding:8px 10px;margin-bottom:12px;border:1px solid #9ca3af;border-radius:6px;box-sizing:border-box;" />

      <!-- NYC Oct 2026 Rule & CA AB 2863: Exit feedback MUST remain strictly optional and non-blocking -->
      <label for="us-cancel-reason-optional" style="display:block;font-size:0.85rem;color:#4b5563;margin-bottom:4px;">
        Reason for canceling (Optional — not required to cancel)
      </label>
      <select id="us-cancel-reason-optional" name="optionalReason"
        style="width:100%;padding:8px 10px;margin-bottom:16px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box;">
        <option value="">Prefer not to answer (Cancel immediately)</option>
        <option value="paused_need">Taking a break</option>
        <option value="budget">Pricing / budget</option>
        <option value="switched">Switched provider</option>
      </select>

      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button type="button" id="us-close-cancel-modal-btn"
          style="padding:9px 14px;border:1px solid #d1d5db;background:#f9fafb;color:#374151;border-radius:6px;cursor:pointer;">
          Keep Subscription
        </button>
        <button type="submit" id="us-confirm-one-click-cancel-btn"
          style="padding:9px 16px;border:none;background:#b91c1c;color:#ffffff;border-radius:6px;font-weight:600;cursor:pointer;">
          Cancel Subscription Now
        </button>
      </div>
    </form>
    <p id="us-cancel-confirmation-banner" role="status" aria-live="polite" hidden
      style="margin-top:14px;padding:10px;background:#ecfdf5;color:#065f46;border-radius:6px;font-size:0.875rem;">
      Your subscription has been canceled effective immediately for future billing cycles. A confirmation receipt has been emailed to you.
    </p>
  </dialog>
</div>
<script>
(function () {
  var openBtn = document.getElementById('us-open-cancel-modal-btn');
  var closeBtn = document.getElementById('us-close-cancel-modal-btn');
  var dialog = document.getElementById('us-cancel-subscription-dialog');
  var form = document.getElementById('us-one-click-cancel-form');
  var banner = document.getElementById('us-cancel-confirmation-banner');
  if (!openBtn || !dialog || !form) return;
  openBtn.addEventListener('click', function () { dialog.showModal(); });
  closeBtn.addEventListener('click', function () { dialog.close(); });
  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    if (!form.reportValidity()) return;
    await fetch(form.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscriberEmail: form.subscriberEmail.value.trim(),
        optionalReason: form.optionalReason.value || null,
        canceledAtIso: new Date().toISOString()
      })
    });
    form.hidden = true;
    banner.hidden = false;
  });
})();
</script>`;

  const allInPricingGuidance = dripFee.dripFeeRisk
    ? `Roll all mandatory service, processing, convenience, or platform fees (${dripFee.matchedDripFeePhrases.join('; ')}) directly into the headline displayed product/plan price per California SB 478 (Cal. Civ. Code § 1770(a)(29)). Only government-imposed taxes and reasonable physical shipping charges may be added separately at checkout.`
    : null;

  return {
    sitePlatform,
    businessModel,
    subscriptionStack,
    affirmativeConsentSnippetHtml,
    oneClickCancelModalHtmlJs,
    allInPricingGuidance,
    regulatoryCoverageSummary: US_STATUTORY_CONTEXT_SUMMARY,
    implementationNotes: [
      'Persist timestamped express affirmative auto-renewal consent records (`arlConsentTimestampIso` + subscriber identifier + disclosed terms version) for at least 3 years or 1 year post-termination per California AB 2863 (`Cal. Bus. & Prof. Code § 17602(a)(4)`).',
      'Wire `POST /api/subscriptions/cancel-online` directly to your billing engine (`Stripe Billing`, `Recharge`, `Skio`, `Loop`, `Chargebee`, or `Recurly`) so online subscribers never have to call or chat with an agent, and keep any exit feedback strictly optional (NYC Oct 2026 Rule & CO SB 25-145).',
      'Have qualified US legal counsel verify renewal reminder schedules (e.g. annual & free-trial conversion reminder windows under CA, NY, and CO statutes).',
    ],
  };
}

export function buildRecommendedNextActors(domain: string): RecommendedNextActor[] {
  return [
    {
      actorSlug: 'healthy_addax/wcag-eaa-ada-auditor',
      actorUrl: 'https://apify.com/healthy_addax/wcag-eaa-ada-auditor',
      mcpEndpointUrl: 'https://mcp.apify.com/?tools=healthy_addax/wcag-eaa-ada-auditor',
      reason: `Pair your US Click-to-Cancel & ARL check on ${domain} with a full headless Chromium ADA Title III / WCAG 2.2 Level AA & Accessibility Overlay (accessiBe/UserWay) audit with red-box visual screenshot proof.`,
    },
    {
      actorSlug: 'healthy_addax/eu-withdrawal-omnibus-auditor',
      actorUrl: 'https://apify.com/healthy_addax/eu-withdrawal-omnibus-auditor',
      mcpEndpointUrl: 'https://mcp.apify.com/?tools=healthy_addax/eu-withdrawal-omnibus-auditor',
      reason: `If ${domain} also sells to UK/EU shoppers, audit it for the mandatory EU 2-Step Electronic Withdrawal Button (Directive 2023/2673 Art. 11a / BGB § 356a), abolished EU ODR link traps, EmpCo green claims, and Omnibus 30-day prior pricing.`,
    },
  ];
}
