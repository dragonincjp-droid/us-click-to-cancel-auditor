import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const execFileAsync = promisify(execFile);

import { ApifyRuntimeAdapter } from '../dist/apifyRuntime.js';
import { coerceUrlCandidate, normalizeAuditInput, runBatchAudit } from '../dist/auditor.js';
import { DEFAULT_MAX_RESPONSE_BYTES, fetchSafeHttp } from '../dist/httpClient.js';
import { startStandbyServer } from '../dist/server.js';
import { classifyIpAddress, validateUrlAgainstSsrf } from '../dist/ssrf.js';
import { LEGAL_DISCLAIMER } from '../dist/types.js';

const NON_COMPLIANT_DTC_HOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>GlowGreens DTC — Subscribe &amp; Save 20%</title>
  <script src="https://cdn.shopify.com/s/files/1/0099/t/1/assets/theme.js"></script>
  <script src="https://static.rechargecdn.com/assets/static/js/widget.min.js"></script>
</head>
<body>
  <header>
    <nav>
      <a href="/products/daily-greens">Shop Greens</a>
      <a href="/pages/terms">Terms of Service</a>
      <a href="/pages/faq">FAQ</a>
    </nav>
  </header>
  <main class="shopify-section">
    <div class="rc-container" data-recharge="true">
      <h1>GlowGreens Superfood — Start Your 14-Day Free Trial!</h1>
      <p>Subscribe &amp; Save 20% — $39.00/mo auto-deliver monthly.</p>
      <form action="/cart/add" method="post">
        <label for="sub_autorenew">
          <input type="checkbox" id="sub_autorenew" name="subscribe_autorenew" checked />
          Yes, enroll me in recurring monthly auto-delivery!
        </label>
        <button type="submit">Start Free Trial</button>
      </form>
      <p class="fine-print">* Listed price excludes taxes; a mandatory 4.9% processing fee added at checkout.</p>
    </div>
  </main>
  <footer>
    <a href="/pages/terms">Terms of Service</a> |
    <a href="/pages/faq">FAQ</a> |
    <a href="/pages/privacy">Privacy Policy</a>
  </footer>
</body>
</html>`;

const NON_COMPLIANT_DTC_TERMS_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Terms of Service — GlowGreens DTC</title></head>
<body>
  <h1>Subscription Terms of Service</h1>
  <p>Subscriptions cannot be canceled online. Subscribers must call 1-800-555-0199 to cancel at least 5 business days prior to the next billing date.</p>
</body>
</html>`;

const COMPLIANT_SAAS_HOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>PulseMetrics Cloud — B2B SaaS Analytics</title>
  <script src="https://js.stripe.com/v3/"></script>
</head>
<body>
  <header>
    <nav>
      <a href="/pricing">Pricing</a>
      <a href="/cancel-subscription">Click to Cancel Subscription</a>
      <a href="/terms">Terms of Service</a>
    </nav>
  </header>
  <main>
    <h1>Real-Time Product Analytics for Modern SaaS Teams</h1>
    <p>Transparent all-in pricing — no processing fees added at checkout and zero convenience fees.</p>
    <a href="/pricing">View Plans ($49/mo per seat)</a>
  </main>
  <footer>
    <a href="/pricing">Pricing</a> |
    <a href="/cancel-subscription">Cancel Subscription</a> |
    <a href="/terms">Terms</a> |
    <a href="https://billing.stripe.com/p/login/test_123">Manage Subscription Portal</a>
  </footer>
</body>
</html>`;

const COMPLIANT_SAAS_PRICING_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Pricing — PulseMetrics Cloud</title></head>
<body>
  <h1>Simple, Transparent Pricing</h1>
  <p>Start your 14-day free trial, then $49/month after your trial ends unless you cancel before the end of your trial.</p>
  <form id="saas-signup" action="/api/checkout" method="post">
    <label for="arl_consent">
      <input type="checkbox" id="arl_consent" name="express_auto_renew_consent" required />
      I expressly agree that my subscription renews automatically at $49/month after the 14-day trial until I cancel online anytime at /cancel-subscription.
    </label>
    <button type="submit">Start 14-Day Free Trial</button>
  </form>
</body>
</html>`;

const COMPLIANT_SAAS_CANCEL_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Cancel Subscription Online — PulseMetrics</title></head>
<body>
  <h1>1-Click Online Subscription Cancellation</h1>
  <p>Cancel online anytime with zero phone calls or mandatory surveys.</p>
  <form id="one-click-cancel" action="/api/cancel" method="post">
    <label for="sub_email">Account Email</label>
    <input id="sub_email" name="email" type="email" required />
    <label for="opt_feedback">Optional feedback (not required)</label>
    <select id="opt_feedback" name="feedback">
      <option value="">Skip feedback</option>
    </select>
    <button type="submit" id="confirm-cancel-btn">Cancel Subscription</button>
  </form>
</body>
</html>`;

const SURVEY_GATED_NYC_HOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>MetroFit Club — Monthly Membership</title></head>
<body>
  <main>
    <h1>MetroFit Digital Membership — $29/mo billed monthly</h1>
    <p>Your membership renews automatically at $29/mo until you cancel.</p>
  </main>
  <footer>
    <a href="/cancel">Cancel Membership</a>
    <a href="/terms">Terms</a>
  </footer>
</body>
</html>`;

const SURVEY_GATED_NYC_CANCEL_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Cancel Membership — MetroFit</title></head>
<body>
  <h1>Cancel Your Membership</h1>
  <p>Subscribers must complete our mandatory exit survey before canceling.</p>
  <form id="cancel-membership-form" action="/api/cancel" method="post">
    <input type="email" name="email" placeholder="Email" required />
    <label for="cancel_reason">Why are you canceling? *</label>
    <select id="cancel_reason" name="cancel_reason" required>
      <option value="">Select a required reason</option>
      <option value="price">Too expensive</option>
    </select>
    <textarea name="cancellation_feedback" placeholder="Required feedback" required></textarea>
    <button type="submit">Cancel Membership</button>
  </form>
</body>
</html>`;

const BROCHURE_NON_SUB_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Summit Civil Engineering PLLC</title></head>
<body>
  <main>
    <h1>Structural &amp; Civil Engineering Consulting</h1>
    <p>Serving municipal and commercial infrastructure projects since 1998. Contact our Denver office for an RFP estimate.</p>
  </main>
  <footer><a href="/privacy">Privacy Policy</a></footer>
</body>
</html>`;

function listenLocalServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve({
        server: srv,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

describe('US Click-to-Cancel, Subscription & ARL Compliance Auditor — Full Offline E2E Suite', () => {
  const servers = [];
  let badDtcUrl = '';
  let compliantSaasUrl = '';
  let surveyGatedUrl = '';
  let brochureSiteUrl = '';
  let robotsBlockedUrl = '';
  let tempStorageDir = '';
  let previousStorageEnv;

  before(async () => {
    process.env.ALLOW_LOCALHOST_FOR_TESTS = '1';
    previousStorageEnv = process.env.APIFY_LOCAL_STORAGE_DIR;
    tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-ctc-auditor-e2e-'));
    process.env.APIFY_LOCAL_STORAGE_DIR = tempStorageDir;

    // 1. Non-compliant DTC Shopify + Recharge store (gzip homepage + /pages/terms + /redirect-imds + /brochure.pdf + /oversized)
    const badSrv = await listenLocalServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0];
      if (urlPath === '/robots.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('User-agent: *\nAllow: /\n');
        return;
      }
      if (urlPath === '/') {
        const gz = zlib.gzipSync(Buffer.from(NON_COMPLIANT_DTC_HOME_HTML, 'utf8'));
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Encoding': 'gzip',
        });
        res.end(gz);
        return;
      }
      if (urlPath === '/pages/terms') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(NON_COMPLIANT_DTC_TERMS_HTML);
        return;
      }
      if (urlPath === '/pages/faq' || urlPath === '/pages/privacy') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h1>FAQ</h1><p>Shipping takes 3-5 business days.</p></body></html>');
        return;
      }
      if (urlPath === '/brochure.pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end(Buffer.from('%PDF-1.4 binary mock payload'));
        return;
      }
      if (urlPath === '/redirect-imds') {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
        return;
      }
      if (urlPath === '/oversized') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body>' + 'A'.repeat(3.1 * 1024 * 1024) + '</body></html>');
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });
    servers.push(badSrv);
    badDtcUrl = badSrv.baseUrl;

    // 2. Compliant B2B/B2C SaaS site (brotli homepage + /pricing + /cancel-subscription + /terms)
    const saasSrv = await listenLocalServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0];
      if (urlPath === '/robots.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('User-agent: *\nAllow: /\n');
        return;
      }
      if (urlPath === '/') {
        const br = zlib.brotliCompressSync(Buffer.from(COMPLIANT_SAAS_HOME_HTML, 'utf8'));
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Encoding': 'br',
        });
        res.end(br);
        return;
      }
      if (urlPath === '/pricing') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(COMPLIANT_SAAS_PRICING_HTML);
        return;
      }
      if (urlPath === '/cancel-subscription') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(COMPLIANT_SAAS_CANCEL_HTML);
        return;
      }
      if (urlPath === '/terms') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<html><body><h1>Terms</h1><p>Subscriptions renew automatically monthly until canceled online anytime.</p></body></html>',
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(saasSrv);
    compliantSaasUrl = saasSrv.baseUrl;

    // 3. NYC Mandatory Exit-Survey Gate site
    const nycSrv = await listenLocalServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0];
      if (urlPath === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(SURVEY_GATED_NYC_HOME_HTML);
        return;
      }
      if (urlPath === '/cancel') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(SURVEY_GATED_NYC_CANCEL_HTML);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h1>Terms</h1></body></html>');
    });
    servers.push(nycSrv);
    surveyGatedUrl = nycSrv.baseUrl;

    // 4. Non-subscription corporate brochure site
    const brochureSrv = await listenLocalServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(BROCHURE_NON_SUB_HTML);
    });
    servers.push(brochureSrv);
    brochureSiteUrl = brochureSrv.baseUrl;

    // 5. robots.txt Disallow: / site
    const robotsSrv = await listenLocalServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0];
      if (urlPath === '/robots.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('User-agent: *\nDisallow: /\n');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body>Blocked</body></html>');
    });
    servers.push(robotsSrv);
    robotsBlockedUrl = robotsSrv.baseUrl;
  });

  after(async () => {
    for (const s of servers) {
      await s.close();
    }
    if (previousStorageEnv === undefined) {
      delete process.env.APIFY_LOCAL_STORAGE_DIR;
    } else {
      process.env.APIFY_LOCAL_STORAGE_DIR = previousStorageEnv;
    }
    if (tempStorageDir) {
      fs.rmSync(tempStorageDir, { recursive: true, force: true });
    }
  });

  it('1. Bare domain normalization & SSRF / Anti-DNS-Rebinding guard block IMDS, RFC1918, IPv6 mapped, and enforce 2MB cap', async () => {
    assert.equal(coerceUrlCandidate('app.example.com'), 'https://app.example.com');
    assert.equal(coerceUrlCandidate('https://app.example.com/pricing'), 'https://app.example.com/pricing');
    assert.equal(coerceUrlCandidate('file:///etc/passwd'), 'file:///etc/passwd');

    for (const blockedTarget of [
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/admin',
      'http://192.168.1.1/',
      'http://172.16.5.4/',
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
      'http://[0:0:0:0:0:ffff:169.254.169.254]/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://127.0.0.1:8080/',
      'http://localhost:3000/',
      'http://[::1]:4321/',
      'file:///etc/passwd',
    ]) {
      const check = await validateUrlAgainstSsrf(blockedTarget, { allowLocalhost: false });
      assert.equal(check.allowed, false, `Expected SSRF guard to block ${blockedTarget}`);
    }

    assert.equal(classifyIpAddress('93.184.216.34', false).allowed, true);
    assert.equal(classifyIpAddress('2606:4700:4700::1111', false).allowed, true);

    const rebind = await validateUrlAgainstSsrf('https://evil-rebind.example.com', {
      allowLocalhost: false,
      dnsLookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ],
    });
    assert.equal(rebind.allowed, false);

    const oversized = await fetchSafeHttp(`${badDtcUrl}/oversized`, { allowLocalhost: true });
    assert.equal(oversized.ok, true);
    assert.equal(oversized.truncated, true);
    assert.equal(oversized.byteLength, DEFAULT_MAX_RESPONSE_BYTES);
  });

  it('2. Non-compliant DTC Shopify + Recharge store: flags CRITICAL Click-to-Cancel trap, pre-checked consent, missing trial terms & SB 478 drip fee, generates HTML/JS pack, and bills exact PPE ($0.03)', async () => {
    const runtime = new ApifyRuntimeAdapter();
    const res = await runBatchAudit(
      {
        urls: [badDtcUrl],
        includeRemediationPack: true,
        maxLegalPagesPerDomain: 3,
        domainDelayMs: 0,
      },
      { runtime, allowLocalhost: true },
    );

    assert.equal(res.items.length, 1);
    const item = res.items[0];
    assert.equal(item.status, 'audited');
    assert.equal(item.sitePlatform, 'shopify');
    assert.equal(item.businessModel, 'dtc_ecommerce_subscription');
    assert.ok(item.subscriptionStack.includes('recharge'));
    assert.equal(item.hasSubscriptionSignals, true);
    assert.ok(item.pagesFetchedCount >= 2, 'Should fetch homepage + /pages/terms');

    assert.equal(item.cancellationStatus, 'call_or_email_obstruction');
    assert.equal(item.onlineClickToCancelFound, false);
    assert.equal(item.callOrEmailObstructionFound, true);
    assert.equal(item.preCheckedConsentBoxFound, true);
    assert.equal(item.missingTrialConversionDisclosure, true);
    assert.equal(item.dripFeeViolationFound, true);

    const ruleIds = item.findings.map((f) => f.ruleId);
    assert.ok(ruleIds.includes('US-ARL-CLICK-TO-CANCEL-OBSTRUCTION'));
    assert.ok(ruleIds.includes('US-ROSCA-CA-AB2863-PRECHECKED-CONSENT'));
    assert.ok(ruleIds.includes('US-CA-AB2863-TRIAL-CONVERSION-UNDISCLOSED'));
    assert.ok(ruleIds.includes('US-CA-SB478-DRIP-JUNK-FEE'));

    assert.equal(item.complianceScore, 0);
    assert.equal(item.riskTier, 'CRITICAL');

    // Outreach hook, HTML/JS remediation pack & BOTH sister Actors cross-linked
    assert.match(item.coldOutreachHook, /Shopify \+ Recharge/i);
    assert.equal(item.remediationPackGenerated, true);
    assert.ok(item.remediationPack);
    assert.match(item.remediationPack.affirmativeConsentSnippetHtml, /expressAutoRenewalConsent/);
    assert.doesNotMatch(
      item.remediationPack.affirmativeConsentSnippetHtml,
      /<input[^>]*\bchecked\b/i,
      'Generated affirmative consent snippet must NEVER be pre-checked',
    );
    assert.match(item.remediationPack.oneClickCancelModalHtmlJs, /Cancel Subscription Now/);
    assert.ok(item.remediationPack.allInPricingGuidance);

    const nextSlugs = item.recommendedNextActors.map((a) => a.actorSlug);
    assert.deepEqual(nextSlugs, [
      'healthy_addax/wcag-eaa-ada-auditor',
      'healthy_addax/eu-withdrawal-omnibus-auditor',
    ]);
    assert.equal(item.disclaimer, LEGAL_DISCLAIMER);

    // Exact PPE billing: $0.005 + $0.015 + $0.01 = $0.03
    assert.equal(res.billing.chargedCounts['actor-start'], 1);
    assert.equal(res.billing.chargedCounts['url-audited'], 1);
    assert.equal(res.billing.chargedCounts['remediation-pack-generated'], 1);
    assert.equal(res.billing.estimatedTotalUsd, 0.03);
  });

  it('3. Compliant SaaS site (Stripe Billing, unchecked consent, trial conversion terms, self-serve /cancel-subscription, all-in pricing) -> score 100, LOW risk, $0 remediation charge', async () => {
    const runtime = new ApifyRuntimeAdapter();
    const res = await runBatchAudit(
      {
        urls: [compliantSaasUrl],
        includeRemediationPack: true,
        maxLegalPagesPerDomain: 3,
        domainDelayMs: 0,
      },
      { runtime, allowLocalhost: true },
    );

    assert.equal(res.items.length, 1);
    const saas = res.items[0];
    assert.equal(saas.status, 'audited');
    assert.equal(saas.sitePlatform, 'saas-web');
    assert.equal(saas.businessModel, 'b2b_or_b2c_saas');
    assert.ok(saas.subscriptionStack.includes('stripe-billing'));
    assert.equal(saas.cancellationStatus, 'online_self_serve_found');
    assert.equal(saas.onlineClickToCancelFound, true);
    assert.equal(saas.callOrEmailObstructionFound, false);
    assert.equal(saas.mandatoryExitSurveyFound, false);
    assert.equal(saas.preCheckedConsentBoxFound, false);
    assert.equal(saas.affirmativeConsentCheck.expressUncheckedConsentFound, true);
    assert.equal(saas.missingAutoRenewalDisclosure, false);
    assert.equal(saas.missingTrialConversionDisclosure, false);
    assert.equal(saas.dripFeeViolationFound, false);

    assert.equal(saas.complianceScore, 100);
    assert.equal(saas.riskTier, 'LOW');
    assert.equal(saas.findingsCount, 0);
    assert.equal(saas.remediationPackGenerated, false);
    assert.equal(res.billing.chargedCounts['remediation-pack-generated'], 0);
  });

  it('4. NYC mandatory exit-survey gate (survey_gated) and non-subscription brochure site (no_subscription_detected -> score 100, 0 findings)', async () => {
    const runtime = new ApifyRuntimeAdapter();
    const res = await runBatchAudit(
      {
        urls: [surveyGatedUrl, brochureSiteUrl],
        includeRemediationPack: true,
        maxLegalPagesPerDomain: 3,
        domainDelayMs: 0,
      },
      { runtime, allowLocalhost: true },
    );

    assert.equal(res.items.length, 2);

    const nycItem = res.items[0];
    assert.equal(nycItem.cancellationStatus, 'survey_gated');
    assert.equal(nycItem.mandatoryExitSurveyFound, true);
    assert.equal(nycItem.onlineClickToCancelFound, false);
    assert.ok(nycItem.findings.some((f) => f.ruleId === 'US-NYC-ARL-MANDATORY-SURVEY-GATE'));
    assert.equal(nycItem.riskTier, 'HIGH');
    assert.equal(nycItem.remediationPackGenerated, true);

    const brochureItem = res.items[1];
    assert.equal(brochureItem.hasSubscriptionSignals, false);
    assert.equal(brochureItem.businessModel, 'non_subscription');
    assert.equal(brochureItem.cancellationStatus, 'no_subscription_detected');
    assert.equal(brochureItem.complianceScore, 100);
    assert.equal(brochureItem.riskTier, 'LOW');
    assert.equal(brochureItem.findingsCount, 0);
    assert.equal(brochureItem.remediationPackGenerated, false);

    // Only nycItem (1 of 2 sites) should be billed for remediation-pack-generated
    assert.equal(res.billing.chargedCounts['url-audited'], 2);
    assert.equal(res.billing.chargedCounts['remediation-pack-generated'], 1);
  });

  it('5. robots.txt disallow, binary Content-Type (application/pdf), and SSRF / 302 IMDS redirect -> $0 url-audited charge', async () => {
    const runtime = new ApifyRuntimeAdapter();
    const res = await runBatchAudit(
      {
        urls: [
          robotsBlockedUrl,
          `${badDtcUrl}/brochure.pdf`,
          'http://169.254.169.254/latest/meta-data/',
          `${badDtcUrl}/redirect-imds`,
        ],
        respectRobotsTxt: true,
        domainDelayMs: 0,
      },
      { runtime, allowLocalhost: true },
    );

    assert.equal(res.items.length, 4);
    assert.equal(res.items[0].status, 'blocked_robots');
    assert.equal(res.items[1].status, 'error');
    assert.match(res.items[1].errorMessage || '', /application\/pdf/i);
    assert.equal(res.items[2].status, 'blocked_ssrf');
    assert.equal(res.items[3].status, 'blocked_ssrf');

    // Critical invariant: $0 url-audited and $0 remediation-pack-generated
    assert.equal(res.billing.chargedCounts['url-audited'], 0);
    assert.equal(res.billing.chargedCounts['remediation-pack-generated'], 0);
  });

  it('6. datasetId chaining, path-traversal ("..") rejection, maxBudgetUsd cap, and creator $0 run compatibility', async () => {
    const runtime = new ApifyRuntimeAdapter();

    // 6a. Exact $0.03 budget ($0.005 actor-start + $0.015 url-audited + $0.01 remediation-pack = 1 site max)
    const capped = await runBatchAudit(
      {
        urls: [badDtcUrl, surveyGatedUrl, compliantSaasUrl],
        includeRemediationPack: true,
        maxBudgetUsd: 0.03,
        maxConcurrency: 1,
        domainDelayMs: 0,
      },
      { runtime, allowLocalhost: true },
    );
    assert.equal(capped.items.length, 1);
    assert.equal(capped.stoppedDueToBudgetCap, true);
    assert.ok(capped.billing.estimatedTotalUsd <= 0.03 + 1e-6);

    // 6b. Creator $0 test run ({ eventChargeLimitReached: false, chargedCount: 0 })
    const creatorRuntime = new ApifyRuntimeAdapter();
    creatorRuntime.sdkCharge = async () => ({ eventChargeLimitReached: false, chargedCount: 0 });
    const creatorRun = await runBatchAudit(
      {
        urls: [badDtcUrl, compliantSaasUrl],
        includeRemediationPack: true,
        domainDelayMs: 0,
      },
      { runtime: creatorRuntime, allowLocalhost: true },
    );
    assert.equal(creatorRun.items.length, 2);
    assert.equal(creatorRun.stoppedDueToBudgetCap, false);

    // 6c. datasetId chaining from local storage
    const leadsDir = path.join(tempStorageDir, 'datasets', 'shopify-leads');
    fs.mkdirSync(leadsDir, { recursive: true });
    fs.writeFileSync(
      path.join(leadsDir, '000000001.json'),
      JSON.stringify([
        { storeName: 'PulseMetrics', website: compliantSaasUrl },
        { storeName: 'Duplicate', url: compliantSaasUrl },
      ]),
      'utf8',
    );
    const chainedRun = await runBatchAudit(
      { datasetId: 'shopify-leads', domainDelayMs: 0 },
      { runtime, allowLocalhost: true },
    );
    assert.equal(chainedRun.items.length, 1);
    assert.equal(chainedRun.items[0].complianceScore, 100);

    // 6d. datasetId traversal attempts must be strictly rejected
    assert.deepEqual(await runtime.loadUrlsFromDataset('..'), []);
    assert.deepEqual(await runtime.loadUrlsFromDataset('../default'), []);
    assert.deepEqual(await runtime.loadUrlsFromDataset('bad/slash'), []);
  });

  it('7. Standby /health, ACTOR_STANDBY_PORT priority, /scan, and /mcp JSON-RPC 2.0 (audit_us_subscription_compliance) + CLI entrypoint', async () => {
    // 7a. Verify ACTOR_STANDBY_PORT env priority when options.port is omitted
    const probeSrv = await listenLocalServer((_req, res) => res.end());
    const freePort = Number(new URL(probeSrv.baseUrl).port);
    await probeSrv.close();

    const prevStandbyPort = process.env.ACTOR_STANDBY_PORT;
    process.env.ACTOR_STANDBY_PORT = String(freePort);
    let standby;
    try {
      standby = await startStandbyServer({
        host: '127.0.0.1',
        allowLocalhost: true,
      });
      assert.equal(standby.port, freePort, 'Must bind to ACTOR_STANDBY_PORT when set');
    } finally {
      if (prevStandbyPort === undefined) {
        delete process.env.ACTOR_STANDBY_PORT;
      } else {
        process.env.ACTOR_STANDBY_PORT = prevStandbyPort;
      }
    }

    const standbyBase = `http://127.0.0.1:${standby.port}`;

    try {
      // 7b. GET /health with Apify readiness header
      const healthRes = await fetch(`${standbyBase}/health`, {
        headers: { 'x-apify-container-server-readiness-probe': '1' },
      });
      assert.equal(healthRes.status, 200);
      const healthJson = await healthRes.json();
      assert.equal(healthJson.status, 'ok');
      assert.equal(healthJson.service, 'us-click-to-cancel-auditor');
      assert.equal(healthJson.endpoints.mcp, '/mcp');

      // 7c. MCP initialize + notifications/initialized + tools/list
      const initRes = await fetch(`${standbyBase}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'e2e-mcp-client', version: '1.0.0' },
          },
        }),
      });
      assert.equal(initRes.status, 200);
      const initBody = await initRes.json();
      assert.equal(initBody.result.serverInfo.name, 'us-click-to-cancel-auditor');

      const notifRes = await fetch(`${standbyBase}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      assert.equal(notifRes.status, 202);

      const listRes = await fetch(`${standbyBase}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      });
      const listBody = await listRes.json();
      assert.deepEqual(
        listBody.result.tools.map((t) => t.name),
        ['audit_us_subscription_compliance'],
      );

      // 7d. MCP tools/call rejects datasetId-only calls without url/urls
      const missingUrlRes = await fetch(`${standbyBase}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'audit_us_subscription_compliance',
            arguments: { datasetId: 'shopify-leads' },
          },
        }),
      });
      const missingUrlBody = await missingUrlRes.json();
      assert.equal(missingUrlBody.result.isError, true);

      // 7e. MCP tools/call (audit_us_subscription_compliance) on non-compliant DTC store
      const callRes = await fetch(`${standbyBase}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'audit_us_subscription_compliance',
            arguments: {
              url: badDtcUrl,
              includeRemediationPack: true,
              maxLegalPagesPerDomain: 3,
            },
          },
        }),
      });
      assert.equal(callRes.status, 200);
      const callBody = await callRes.json();
      assert.equal(callBody.result.isError, false);
      const report = JSON.parse(callBody.result.content[0].text);
      assert.equal(report.status, 'audited');
      assert.equal(report.cancellationStatus, 'call_or_email_obstruction');
      assert.equal(report.preCheckedConsentBoxFound, true);
      assert.equal(report.remediationPackGenerated, true);

      // 7f. CLI Entrypoint (node dist/main.js)
      const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-ctc-cli-test-'));
      try {
        const kvsDefault = path.join(cliDir, 'key_value_stores', 'default');
        fs.mkdirSync(kvsDefault, { recursive: true });
        fs.writeFileSync(
          path.join(kvsDefault, 'INPUT.json'),
          JSON.stringify({
            urls: [compliantSaasUrl],
            domainDelayMs: 0,
          }),
          'utf8',
        );

        const { stdout } = await execFileAsync(process.execPath, ['dist/main.js'], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ALLOW_LOCALHOST_FOR_TESTS: '1',
            APIFY_LOCAL_STORAGE_DIR: cliDir,
          },
          timeout: 15_000,
        });

        assert.match(stdout, /Completed batch audit/);
        const dsFiles = fs
          .readdirSync(path.join(cliDir, 'datasets', 'default'))
          .filter((f) => f.endsWith('.json'));
        assert.equal(dsFiles.length, 1);
      } finally {
        fs.rmSync(cliDir, { recursive: true, force: true });
      }
    } finally {
      await standby.close();
    }
  });

  it('8. .actor/* schemas match SubscriptionAuditReportItem 100% and strictly satisfy Apify UI character limits', async () => {
    const actorJson = JSON.parse(fs.readFileSync('.actor/actor.json', 'utf8'));
    const inputSchema = JSON.parse(fs.readFileSync('.actor/input_schema.json', 'utf8'));
    const datasetSchema = JSON.parse(fs.readFileSync('.actor/dataset_schema.json', 'utf8'));
    const ppeJson = JSON.parse(fs.readFileSync('.actor/pay_per_event.json', 'utf8'));

    assert.equal(actorJson.name, 'us-click-to-cancel-auditor');
    assert.equal(
      actorJson.title,
      'US Click-to-Cancel, Subscription & ARL Compliance Auditor',
    );
    assert.ok(
      actorJson.title.length <= 58,
      `actor.json title length (${actorJson.title.length}) must be <= 58`,
    );
    assert.ok(
      actorJson.description.length <= 250 && actorJson.description.length <= 260,
      `actor.json description length (${actorJson.description.length}) must be <= 250`,
    );
    assert.equal(actorJson.minMemoryMbytes, 256);
    assert.equal(actorJson.maxMemoryMbytes, 1024);
    assert.equal(actorJson.usesStandbyMode, true);
    assert.equal(actorJson.webServerMcpPath, '/mcp');

    assert.equal(ppeJson['actor-start'].eventPriceUsd, 0.005);
    assert.ok(ppeJson['actor-start'].eventDescription.length <= 120);
    assert.equal(ppeJson['url-audited'].eventPriceUsd, 0.015);
    assert.ok(ppeJson['url-audited'].eventDescription.length <= 140);
    assert.equal(ppeJson['remediation-pack-generated'].eventPriceUsd, 0.01);
    assert.ok(ppeJson['remediation-pack-generated'].eventDescription.length <= 140);

    for (const [evKey, evDef] of Object.entries(ppeJson)) {
      assert.ok(
        evDef.eventDescription.length <= 160,
        `PPE "${evKey}" eventDescription exceeds 160 chars`,
      );
    }

    const defaults = normalizeAuditInput({});
    for (const [propName, propDef] of Object.entries(inputSchema.properties)) {
      if ('default' in propDef) {
        assert.equal(
          defaults[propName],
          propDef.default,
          `Default mismatch for input property "${propName}"`,
        );
      }
    }

    const runtime = new ApifyRuntimeAdapter();
    const sampleRun = await runBatchAudit(
      { urls: [badDtcUrl], domainDelayMs: 0 },
      { runtime, allowLocalhost: true },
    );
    const liveItem = sampleRun.items[0];
    for (const key of Object.keys(datasetSchema.fields.properties)) {
      assert.equal(
        key in liveItem,
        true,
        `Dataset schema property "${key}" must exist on SubscriptionAuditReportItem`,
      );
    }
    for (const key of Object.keys(liveItem)) {
      assert.equal(
        key in datasetSchema.fields.properties,
        true,
        `SubscriptionAuditReportItem property "${key}" must be documented in .actor/dataset_schema.json`,
      );
    }
  });
});
