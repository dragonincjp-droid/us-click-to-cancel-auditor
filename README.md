# US Click-to-Cancel, Subscription & ARL Compliance Auditor (API + MCP Server)

**Bulk-audit 1,000+ US DTC subscription stores (`Shopify + Recharge/Skio/Loop/Bold`) and B2B/B2C SaaS apps (`Stripe Billing/Chargebee/Recurly/Paddle`) in minutes via ultra-fast, zero-browser HTTP for the highest-impact 2025–2026 US Auto-Renewal Law (ARL), Click-to-Cancel, ROSCA, and Drip-Fee enforcement triggers.**

Outputs a deterministic `complianceScore` (`0–100`), prioritized `findings[]`, billing & subscription tech-stack fingerprint (`subscriptionStack` + `sitePlatform` + `businessModel`), neutral B2B `coldOutreachHook`, and ready-to-paste **CA AB 2863 / CO SB 25-145 Unchecked Express Auto-Renewal Consent Box + 1-Click Online Cancellation Modal HTML/JS snippets**.

Zero OpenAI/LLM keys required. Built for **Shopify Retention & Compliance Agencies**, **SaaS Legal-Ops Consultants**, **Fintech/Billing Vendors**, **Clay**, **n8n**, **Apify Dataset Chaining**, and **AI Agents via MCP (`Claude Desktop`, `Cursor`, `Windsurf`)**.

---

## Late-2026 US Statutory Enforcement Landscape (Why Demand Is Surging)

> **Regulatory Accuracy Note:** While the 2024 federal FTC Negative Option Rule was procedurally vacated by the Eighth Circuit in July 2025 (with renewed FTC rulemaking underway in 2026), **state Attorneys General, city regulators, class-action plaintiffs, and federal ROSCA enforcers have dramatically escalated subscription & drip-fee enforcement under**:

1. **California Automatic Renewal Law (`Cal. Bus. & Prof. Code §§ 17600–17606`, amended by `AB 2863`, effective July 1, 2025)**
   Requires same-medium online **Click-to-Cancel** without obstruction, **separate express affirmative consent** to automatic-renewal terms (with consent records retained for at least 3 years), clear pre-billing & free-trial conversion disclosures, and annual/fee-change renewal notices.
2. **New York ARL (`N.Y. Gen. Bus. Law § 527-a`, Nov 2025) & NYC Click-to-Cancel Rule (effective October 1, 2026)**
   Mandates accessible online cancellation and explicitly prohibits forcing subscribers through **mandatory exit/reason surveys** or retention questionnaires in order to cancel.
3. **Colorado Online Cancellation Act (`SB 25-145`, Aug 2025 + B2B SaaS Extension effective February 16, 2026)**
   Mandates accessible one-step online cancellation and uniquely extends automatic-renewal and online cancellation requirements to **B2B SaaS & commercial contracts**.
4. **Federal ROSCA (`15 U.S.C. § 8403`) & California Honest Pricing / Drip-Fee Law (`SB 478`, `Cal. Civ. Code § 1770(a)(29)`)**
   Prohibits charging online negative-option subscribers without clear material terms, express informed opt-in consent (banning pre-checked boxes), and simple cancellation mechanisms, and prohibits advertising prices that omit mandatory non-governmental service, processing, or convenience drip fees.

### Agency & Outbound Lead-Gen ROI Math

| Metric | Manual Storefront / SaaS Review | Bulk HTTP Audit (`healthy_addax/us-click-to-cancel-auditor`) |
| :--- | :--- | :--- |
| **1,000 DTC / SaaS Sites Audited** | ~150 hours of manual checking | **~3–6 minutes (zero-Playwright HTTP engine)** |
| **Cost for 1,000 Sites** | $5,000+ analyst time | **`$15.005`** (audit + hooks) or **`$25.005`** (with HTML/JS fix packs) |
| **Deliverables Included** | Spreadsheet notes | **Billing stack (`Recharge`/`Skio`/`Stripe`) + broken URLs + outreach hook + HTML/JS consent & 1-click cancel snippets** |
| **Apify Free Tier (`$5.00/mo` credit)** | — | **Audit ~199 to ~333 sites every month for `$0`** |

> **Fair Pay-Per-Event Billing Guarantee:**
> - Invalid URLs, unreachable sites, non-HTML binary files (`application/pdf`, images), `robots.txt`-disallowed pages, and SSRF-blocked targets are **never billed (`$0`)**.
> - `remediation-pack-generated` (`$0.01`) is **only billed when `includeRemediationPack: true` AND `findings.length > 0`** — compliant sites and non-subscription brochure sites with zero findings are never charged for snippets they don't need!

---

## Core Checks Per Site

For every target URL (accepts both full URLs like `https://shop.example.com` and bare domains like `app.example.com`), the Actor inspects the homepage plus up to `maxLegalPagesPerDomain` (default `3`, max `5`) auto-discovered internal same-origin pages (`/cancel`, `/pricing`, `/plans`, `/subscribe`, `/membership`, `/terms`, `/billing`, `/faq`, `/refund-policy`):

1. **Subscription & Billing Tech-Stack Fingerprinting (`subscriptionStack`, `sitePlatform`, `businessModel`)**
   - Detects DTC subscription apps (`recharge`, `skio`, `loop-subscriptions`, `bold-subscriptions`, `ordergroove`, `stay-ai`, `seal-subscriptions`, `appstle`), SaaS billing engines (`stripe-billing`, `chargebee`, `recurly`, `paddle`, `zuora`, `lemon-squeezy`), and platforms (`shopify`, `woocommerce`, `bigcommerce`, `magento`, `wix`, `squarespace`, `saas-web`, `custom`).
   - Distinguishes `dtc_ecommerce_subscription`, `b2b_or_b2c_saas`, `membership_or_media`, and `non_subscription` sites (`no_subscription_detected` → score `100`, `0` findings).
2. **Online Click-to-Cancel vs. Call / Email / Exit-Survey Obstructions (`clickToCancelCheck`)**
   - Flags **Call-Only / Support-Gate Traps** (`CRITICAL`): `"must call 1-800-... to cancel"`, `"cancellation requests must be made by phone"`, `"email support to request cancellation"`, `"chat with an agent to cancel"`, `"cannot be canceled online"`.
   - Flags **Mandatory Exit-Survey Gates** (`HIGH` — NYC Oct 2026 Rule & CA AB 2863): cancellation forms with `required` survey dropdowns/textareas (`<select name="cancel_reason" required>`) or terms requiring exit questionnaires.
   - Classifies `cancellationStatus`: `online_self_serve_found` | `call_or_email_obstruction` | `survey_gated` | `no_cancel_mechanism_disclosed` | `no_subscription_detected` | `not_checked`.
3. **Affirmative Auto-Renewal Consent & Free-Trial Conversion Check (`affirmativeConsentCheck`)**
   - Flags **Pre-Checked Recurring Checkboxes** (`CRITICAL` under CA AB 2863 & ROSCA): `<input type="checkbox" ... checked>` adjacent to subscription, auto-renewal, trial, or terms text.
   - Verifies explicit continuous auto-renewal wording and post-trial conversion price/deadline disclosures alongside free-trial offers.
4. **Drip Pricing / Hidden Mandatory Junk Fees (`dripFeeCheck` — `CA SB 478`)**
   - Detects mandatory add-on fee disclosures buried in fine print (`"mandatory 4.9% processing fee added at checkout"`, `"plus a mandatory service fee"`, `"convenience fee"`, `"handling surcharge"`, `"excludes mandatory fees"`).

---

## Input Parameters

| Field | Type | Default | Description |
| :--- | :--- | :---: | :--- |
| `urls` | `string[]` / RequestList | `["https://example.com"]` | Store or SaaS URLs or bare domains (`"shop.example.com"` or `"https://app.example.com"`). |
| `url` | `string` | *Optional* | Single URL/domain shorthand for Clay HTTP columns, webhooks, or MCP calls. |
| `datasetId` | `string` | *Optional* | Upstream Apify Dataset ID (e.g. from **Shopify Store Scraper** or **Google Maps Scraper**) to auto-import URLs and deduplicate with `urls`. |
| `datasetUrlField` | `string` | *Auto-detect* | Optional field override for `datasetId` items (auto-detects `website`, `url`, `domain`, `shopUrl`, `storeUrl`, `appUrl`, `pricingUrl`). |
| `maxLegalPagesPerDomain` | `integer` | `3` | Max discovered internal same-origin subpages fetched per site (`0–5`). |
| `includeRemediationPack` | `boolean` | `true` | Generates CA AB 2863 / CO SB 25-145 Unchecked Consent Box + 1-Click Cancel Modal HTML/JS snippets when findings exist (`+$0.01/site`). |
| `checkClickToCancel` | `boolean` | `true` | Audit online Click-to-Cancel vs. phone/email/chat obstructions & NYC mandatory exit surveys. |
| `checkAffirmativeConsent` | `boolean` | `true` | Audit pre-checked consent checkboxes, auto-renewal disclosures & free-trial conversion terms. |
| `checkDripFees` | `boolean` | `true` | Audit mandatory processing/service/convenience drip fees (`CA SB 478`). |
| `respectRobotsTxt` | `boolean` | `true` | Respect domain `/robots.txt` rules before fetching pages. |
| `maxUrls` | `integer` | `100` | Safety ceiling on total sites audited in one run (`1–5000`). |
| `maxConcurrency` | `integer` | `5` | Parallel HTTP site workers (`1–20`). |
| `domainDelayMs` | `integer` | `300` | Polite delay in milliseconds between requests to the same hostname (`0–30000`). |
| `requestTimeoutMs` | `integer` | `12000` | Strict timeout per HTTP request in milliseconds (`2000–60000`). |

---

## Output Dataset Sample (JSON)

```json
{
  "url": "glowsupplements-dtc.com",
  "normalizedInputUrl": "https://glowsupplements-dtc.com",
  "finalUrl": "https://glowsupplements-dtc.com/",
  "domain": "glowsupplements-dtc.com",
  "auditedAt": "2026-11-25T04:20:00.000Z",
  "status": "audited",
  "httpStatus": 200,
  "pageTitle": "Glow Daily Greens — Subscribe & Save 20%",
  "detectedLanguage": "en",
  "sitePlatform": "shopify",
  "businessModel": "dtc_ecommerce_subscription",
  "subscriptionStack": ["recharge"],
  "hasSubscriptionSignals": true,
  "loadTimeMs": 142,
  "pagesFetchedCount": 3,
  "pagesFetched": [
    "https://glowsupplements-dtc.com/",
    "https://glowsupplements-dtc.com/pages/terms",
    "https://glowsupplements-dtc.com/pages/faq"
  ],
  "errorMessage": null,
  "complianceScore": 0,
  "riskTier": "CRITICAL",
  "cancellationStatus": "call_or_email_obstruction",
  "onlineClickToCancelFound": false,
  "callOrEmailObstructionFound": true,
  "mandatoryExitSurveyFound": false,
  "preCheckedConsentBoxFound": true,
  "missingAutoRenewalDisclosure": true,
  "missingTrialConversionDisclosure": true,
  "dripFeeViolationFound": true,
  "findingsCount": 5,
  "findings": [
    {
      "ruleId": "US-ARL-CLICK-TO-CANCEL-OBSTRUCTION",
      "title": "Phone / Support-Gate Cancellation Trap — Online Click-to-Cancel Obstructed",
      "regulation": "California ARL (Cal. Bus. & Prof. Code § 17602(c)-(d), AB 2863 eff. July 1, 2025), New York GBL § 527-a, Colorado SB 25-145, and Federal ROSCA (15 U.S.C. § 8403(3))",
      "severity": "CRITICAL",
      "pageUrl": "https://glowsupplements-dtc.com/pages/terms",
      "evidence": "Toll-free / phone number required to cancel: \"...Subscribers must call 1-800-555-0199 to cancel at least 5 business days...\" (https://glowsupplements-dtc.com/pages/terms)",
      "recommendation": "Remove phone-only / agent-gated cancellation restrictions immediately and provide a prominent, same-medium online Click-to-Cancel button or self-serve cancellation portal accessible without live-agent friction."
    },
    {
      "ruleId": "US-ROSCA-CA-AB2863-PRECHECKED-CONSENT",
      "title": "Pre-Checked Subscription / Auto-Renewal Consent Checkbox Dark Pattern",
      "regulation": "California AB 2863 (Cal. Bus. & Prof. Code § 17602(a)(4) separate express affirmative consent) & Federal ROSCA (15 U.S.C. § 8403(2))",
      "severity": "CRITICAL",
      "pageUrl": "https://glowsupplements-dtc.com/",
      "evidence": "Pre-checked checkbox (subscribe_autorenew) near \"Yes! Subscribe & Save 20% — auto-deliver every 30 days\" on https://glowsupplements-dtc.com/",
      "recommendation": "Remove the `checked` attribute so the express auto-renewal consent checkbox defaults to unchecked, validate affirmative opt-in prior to billing, and retain timestamped consent records for at least 3 years under CA AB 2863."
    }
  ],
  "coldOutreachHook": "While running a technical US subscription & ARL check on your Shopify + Recharge storefront/app (glowsupplements-dtc.com), we noticed cancellation copy instructs subscribers to call or contact support rather than offering a direct self-serve online Click-to-Cancel flow, and a recurring/auto-renewal consent checkbox renders pre-checked (`checked`) by default (plus 1 additional subscription/pricing signal) — happy to send over the technical audit notes and ready-to-paste CA AB 2863 / CO SB 25-145 HTML/JS consent + 1-click cancel snippets if helpful for your team.",
  "remediationPackGenerated": true,
  "remediationPack": {
    "sitePlatform": "shopify",
    "businessModel": "dtc_ecommerce_subscription",
    "subscriptionStack": ["recharge"],
    "affirmativeConsentSnippetHtml": "<!-- US Auto-Renewal Law (CA AB 2863 § 17602(a)(4)...) Express Unchecked Consent Block -->...",
    "oneClickCancelModalHtmlJs": "<!-- US Same-Medium 1-Click Online Cancellation Modal (CA AB 2863, NYC Oct 2026 Rule...) -->...",
    "allInPricingGuidance": "Roll all mandatory service, processing, convenience, or platform fees directly into the headline displayed product/plan price per California SB 478...",
    "regulatoryCoverageSummary": "While the 2024 federal FTC Negative Option Rule was procedurally vacated in July 2025...",
    "implementationNotes": [
      "Persist timestamped express affirmative auto-renewal consent records (`arlConsentTimestampIso` + subscriber identifier + disclosed terms version) for at least 3 years..."
    ]
  },
  "recommendedNextActors": [
    {
      "actorSlug": "healthy_addax/wcag-eaa-ada-auditor",
      "actorUrl": "https://apify.com/healthy_addax/wcag-eaa-ada-auditor",
      "mcpEndpointUrl": "https://mcp.apify.com/?tools=healthy_addax/wcag-eaa-ada-auditor",
      "reason": "Pair your US Click-to-Cancel & ARL check on glowsupplements-dtc.com with a full headless Chromium ADA Title III / WCAG 2.2 Level AA & Accessibility Overlay (accessiBe/UserWay) audit with red-box visual screenshot proof."
    },
    {
      "actorSlug": "healthy_addax/eu-withdrawal-omnibus-auditor",
      "actorUrl": "https://apify.com/healthy_addax/eu-withdrawal-omnibus-auditor",
      "mcpEndpointUrl": "https://mcp.apify.com/?tools=healthy_addax/eu-withdrawal-omnibus-auditor",
      "reason": "If glowsupplements-dtc.com also sells to UK/EU shoppers, audit it for the mandatory EU 2-Step Electronic Withdrawal Button (Directive 2023/2673 Art. 11a / BGB § 356a), abolished EU ODR link traps, EmpCo green claims, and Omnibus 30-day prior pricing."
    }
  ],
  "disclaimer": "Automated technical heuristic signals for human review only; does not constitute legal advice or formal regulatory certification."
}
```

---

## Connect as an AI Agent MCP Tool (`Claude Desktop`, `Cursor`, `Windsurf`)

This Actor natively runs an **Apify Standby Streamable HTTP MCP Server** (`/mcp`) exposing `audit_us_subscription_compliance`:

- **Hosted Apify MCP URL**: `https://mcp.apify.com/?tools=healthy_addax/us-click-to-cancel-auditor`

### `claude_desktop_config.json` / `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "us-click-to-cancel-auditor": {
      "url": "https://mcp.apify.com/?tools=healthy_addax/us-click-to-cancel-auditor",
      "headers": {
        "Authorization": "Bearer <YOUR_APIFY_TOKEN>"
      }
    }
  }
}
```

Example prompt in Claude / Cursor:
> *"Use `audit_us_subscription_compliance` to inspect `shop.example.com` for CA AB 2863 Click-to-Cancel, NYC exit-survey rules, ROSCA pre-checked boxes, and CA SB 478 drip fees, then integrate the returned HTML/JS consent + 1-click cancellation snippets into our Shopify theme."*

---

## Complete US + EU + ADA Digital Compliance Suite (Sister Actors)

| Compliance Layer | Actor | Engine & Speed |
| :--- | :--- | :--- |
| **US Click-to-Cancel, Auto-Renewal Laws (`CA AB 2863`, `NY/NYC ARL`, `CO SB 25-145 B2B SaaS`), `ROSCA` & `CA SB 478` Drip Fees** | **`healthy_addax/us-click-to-cancel-auditor`** *(This Actor)* | **Zero-Playwright Pinned HTTP** (~150–400ms/site, `$0.015`/site) |
| **ADA Title III / WCAG 2.2 Level AA, European Accessibility Act (`EAA`) & Overlay Widgets (`accessiBe`/`UserWay`)** | **[`healthy_addax/wcag-eaa-ada-auditor`](https://apify.com/healthy_addax/wcag-eaa-ada-auditor)** | **Headless Chromium + `axe-core`** (Red-box PNG visual proof + HTML diffs) |
| **EU Withdrawal Button (`Directive 2023/2673 Art. 11a`), Dead EU ODR Links, `EmpCo` Green Claims & `Omnibus` 30-Day Pricing** | **[`healthy_addax/eu-withdrawal-omnibus-auditor`](https://apify.com/healthy_addax/eu-withdrawal-omnibus-auditor)** | **Zero-Playwright Pinned HTTP** (~150–400ms/store, `$0.015`/store) |

---

## Security & Operational Guarantees

- **Zero-Browser Attack Surface & Low Memory**: Runs on `apify/actor-node:22` (`256 MB` min RAM) with zero headless browser overhead and deterministic parsing.
- **Anti-DNS-Rebinding & 128-Bit IPv6 SSRF Protection**: Every hostname is validated against private IPv4/IPv6 ranges and cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`, IPv4-mapped/NAT64/6to4 IPv6), with resolved safe IPs **pinned directly at the Node TCP socket `lookup` layer** and validated across every HTTP redirect hop (max 5 hops).
- **Bounded Memory & Polite Crawling**: Responses are capped at `2 MB` (both wire and decompressed gzip/deflate/brotli) with `12s` strict timeouts, `robots.txt` compliance, and per-domain rate limiting.

---

## Legal Disclaimer

> **Automated technical heuristic signals for human review only; does not constitute legal advice or formal regulatory certification.**
>
> Static/HTTP HTML inspection identifies publicly visible markup, checkboxes, links, forms, and text patterns on inspected pages. Authenticated post-login billing dashboards, client-rendered SPAs, or state-specific statutory exemptions require human verification and review by qualified US legal counsel.
