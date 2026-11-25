import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { ApifyRuntimeAdapter } from './apifyRuntime.js';
import { runBatchAudit } from './auditor.js';
import { BillingManager } from './billing.js';
import { RobotsAndRateGuard } from './robots.js';
import type { DnsLookupFn } from './ssrf.js';
import { LEGAL_DISCLAIMER, type RawActorInput } from './types.js';

const MAX_BODY_BYTES = 256 * 1024;

const MCP_SERVER_INFO = {
  name: 'us-click-to-cancel-auditor',
  version: '1.0.0',
};

const MCP_AUDIT_TOOL_SCHEMA = {
  name: 'audit_us_subscription_compliance',
  description:
    'Audits one or more DTC e-commerce or SaaS subscription websites via fast zero-browser HTTP for US Click-to-Cancel & Automatic Renewal Law compliance (California AB 2863, New York GBL § 527-a & NYC Oct 2026 no-mandatory-survey rule, Colorado SB 25-145 including B2B SaaS, Federal ROSCA 15 U.S.C. § 8403, and California SB 478 drip fees) — returning complianceScore, subscriptionStack, findings, coldOutreachHook, and ready-to-paste HTML/JS consent + 1-click cancel snippets.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description:
          'Single public store or SaaS URL or bare domain to audit (e.g. "https://shop.example.com" or "app.example.com").',
      },
      urls: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional list of public store or SaaS URLs or bare domains to audit (max 20 per MCP call).',
      },
      maxLegalPagesPerDomain: {
        type: 'integer',
        default: 3,
        minimum: 0,
        maximum: 5,
        description:
          'Maximum discovered internal same-origin pages (/cancel, /pricing, /plans, /subscribe, /terms, /billing, /faq) fetched per site.',
      },
      includeRemediationPack: {
        type: 'boolean',
        default: true,
        description:
          'Generate ready-to-paste CA AB 2863 / CO SB 25-145 Express Unchecked Consent Box + 1-Click Online Cancellation Modal HTML/JS snippets when findings exist.',
      },
      checkClickToCancel: {
        type: 'boolean',
        default: true,
        description:
          'Check for online same-medium Click-to-Cancel vs. call-only/email-only support traps and NYC Oct 2026 mandatory exit-survey gates.',
      },
      checkAffirmativeConsent: {
        type: 'boolean',
        default: true,
        description:
          'Check subscription/trial pages for pre-checked recurring consent checkboxes, auto-renewal disclosures, and post-trial conversion terms.',
      },
      checkDripFees: {
        type: 'boolean',
        default: true,
        description:
          'Check pricing/terms copy for mandatory service, processing, or convenience drip fees added outside upfront pricing (CA SB 478).',
      },
      respectRobotsTxt: {
        type: 'boolean',
        default: true,
        description: 'Respect domain /robots.txt rules before scanning.',
      },
    },
  },
};

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(json);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

export interface StandbyServerHandle {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

export interface StandbyServerOptions {
  port?: number;
  host?: string;
  runtime?: ApifyRuntimeAdapter;
  allowLocalhost?: boolean;
  dnsLookup?: DnsLookupFn;
}

export async function startStandbyServer(
  options: StandbyServerOptions = {},
): Promise<StandbyServerHandle> {
  const configuredPort =
    options.port ??
    Number(
      process.env.ACTOR_STANDBY_PORT ||
        process.env.ACTOR_WEB_SERVER_PORT ||
        process.env.APIFY_CONTAINER_PORT ||
        4321,
    );
  const host = options.host ?? '0.0.0.0';

  const runtime = options.runtime ?? new ApifyRuntimeAdapter();
  await runtime.init();

  const robotsGuard = new RobotsAndRateGuard();
  let activeRequests = 0;
  const MAX_ACTIVE_REQUESTS = 16;

  async function handleMcpRpcObject(rpc: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const hasId = rpc.id !== undefined;
    const id = rpc.id ?? null;

    if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request.' },
      };
    }

    if (!hasId) {
      return null;
    }

    switch (rpc.method) {
      case 'initialize': {
        const clientProto =
          typeof rpc.params?.protocolVersion === 'string'
            ? rpc.params.protocolVersion
            : '2025-03-26';
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: clientProto,
            capabilities: {
              tools: { listChanged: false },
            },
            serverInfo: MCP_SERVER_INFO,
            instructions:
              'Use audit_us_subscription_compliance to inspect DTC e-commerce and SaaS subscription sites for US Click-to-Cancel & Auto-Renewal Law compliance (CA AB 2863, NY ARL & NYC Oct 2026 Rule, CO SB 25-145 B2B SaaS, Federal ROSCA, and CA SB 478 drip fees).',
          },
        };
      }

      case 'ping': {
        return {
          jsonrpc: '2.0',
          id,
          result: {},
        };
      }

      case 'tools/list': {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [MCP_AUDIT_TOOL_SCHEMA],
          },
        };
      }

      case 'tools/call': {
        const toolName = rpc.params?.name;
        if (toolName !== 'audit_us_subscription_compliance') {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32602,
              message: `Unknown MCP tool "${String(toolName)}". Expected "audit_us_subscription_compliance".`,
            },
          };
        }

        const rawArgs =
          rpc.params?.arguments && typeof rpc.params.arguments === 'object'
            ? (rpc.params.arguments as RawActorInput)
            : {};

        const hasAnyUrl =
          (typeof rawArgs.url === 'string' && rawArgs.url.trim().length > 0) ||
          (Array.isArray(rawArgs.urls) && rawArgs.urls.length > 0);

        if (!hasAnyUrl) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      error:
                        'Missing required parameter "url" or "urls" in audit_us_subscription_compliance.',
                      disclaimer: LEGAL_DISCLAIMER,
                    },
                    null,
                    2,
                  ),
                },
              ],
            },
          };
        }

        if (activeRequests >= MAX_ACTIVE_REQUESTS) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32000,
              message: 'Server busy processing maximum concurrent HTTP subscription scans. Please retry shortly.',
            },
          };
        }

        activeRequests += 1;
        try {
          const budgetCap = rawArgs.maxBudgetUsd ?? rawArgs.maxTotalChargeUsd;
          const billing = new BillingManager(runtime, budgetCap);
          const cappedInput: RawActorInput = {
            ...rawArgs,
            datasetId: undefined,
            maxUrls: Math.min(rawArgs.maxUrls ?? 20, 20),
            maxConcurrency: Math.min(rawArgs.maxConcurrency ?? 4, 8),
          };

          const batchResult = await runBatchAudit(cappedInput, {
            runtime,
            robotsGuard,
            billing,
            allowLocalhost: options.allowLocalhost,
            dnsLookup: options.dnsLookup,
            pushToDataset: false,
            chargeActorStart: false,
          });

          const allFailedOrBlocked =
            batchResult.items.length === 0 ||
            batchResult.items.every((item) => item.status !== 'audited');

          const payload =
            batchResult.items.length === 1
              ? batchResult.items[0]
              : {
                  count: batchResult.items.length,
                  items: batchResult.items,
                  disclaimer: LEGAL_DISCLAIMER,
                };

          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: allFailedOrBlocked,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(payload, null, 2),
                },
              ],
              structuredContent: {
                items: batchResult.items,
                billing: batchResult.billing,
                disclaimer: LEGAL_DISCLAIMER,
              },
            },
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: msg, disclaimer: LEGAL_DISCLAIMER }, null, 2),
                },
              ],
            },
          };
        } finally {
          activeRequests -= 1;
        }
      }

      default: {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Method not found: ${rpc.method}`,
          },
        };
      }
    }
  }

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = (req.method || 'GET').toUpperCase();
      const parsedUrl = new URL(req.url || '/', 'http://localhost');
      const pathname = parsedUrl.pathname;

      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        });
        res.end();
        return;
      }

      const isReadinessProbe = Boolean(req.headers['x-apify-container-server-readiness-probe']);
      if (isReadinessProbe || (method === 'GET' && (pathname === '/' || pathname === '/health'))) {
        sendJson(res, 200, {
          status: 'ok',
          service: MCP_SERVER_INFO.name,
          version: MCP_SERVER_INFO.version,
          mode: 'standby',
          endpoints: {
            health: '/health',
            scan: '/scan',
            mcp: '/mcp',
          },
          activeRequests,
          disclaimer: LEGAL_DISCLAIMER,
        });
        return;
      }

      if (pathname === '/scan') {
        if (method !== 'POST') {
          sendJson(res, 405, { error: 'Method Not Allowed. Use POST /scan.' });
          return;
        }
        if (activeRequests >= MAX_ACTIVE_REQUESTS) {
          sendJson(res, 429, {
            error: 'Too many concurrent scan requests. Please retry shortly.',
            disclaimer: LEGAL_DISCLAIMER,
          });
          return;
        }

        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          const code = err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
          sendJson(res, code, {
            error: code === 413 ? 'Request payload exceeds 256KB limit.' : 'Invalid JSON body.',
            disclaimer: LEGAL_DISCLAIMER,
          });
          return;
        }

        const rawInput = (body && typeof body === 'object' ? body : {}) as RawActorInput;
        const hasUrl =
          (typeof rawInput.url === 'string' && rawInput.url.trim().length > 0) ||
          (Array.isArray(rawInput.urls) && rawInput.urls.length > 0) ||
          (Array.isArray(rawInput.startUrls) && rawInput.startUrls.length > 0) ||
          (typeof rawInput.datasetId === 'string' && rawInput.datasetId.trim().length > 0);

        if (!hasUrl) {
          sendJson(res, 400, {
            error: 'Provide "url", "urls", or "datasetId" in JSON request body.',
            disclaimer: LEGAL_DISCLAIMER,
          });
          return;
        }

        activeRequests += 1;
        try {
          const budgetCap = rawInput.maxBudgetUsd ?? rawInput.maxTotalChargeUsd;
          const billing = new BillingManager(runtime, budgetCap);
          const capped: RawActorInput = {
            ...rawInput,
            maxUrls: Math.min(rawInput.maxUrls ?? 50, 50),
            maxConcurrency: Math.min(rawInput.maxConcurrency ?? 5, 10),
          };
          const result = await runBatchAudit(capped, {
            runtime,
            robotsGuard,
            billing,
            allowLocalhost: options.allowLocalhost,
            dnsLookup: options.dnsLookup,
            pushToDataset: false,
            chargeActorStart: false,
          });

          sendJson(res, 200, {
            count: result.items.length,
            items: result.items,
            billing: result.billing,
            disclaimer: LEGAL_DISCLAIMER,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sendJson(res, 500, { error: msg, disclaimer: LEGAL_DISCLAIMER });
        } finally {
          activeRequests -= 1;
        }
        return;
      }

      if (pathname === '/mcp') {
        if (method !== 'POST') {
          res.writeHead(405, {
            Allow: 'POST, OPTIONS',
            'Content-Type': 'application/json; charset=utf-8',
          });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: {
                code: -32600,
                message: 'Use HTTP POST for Streamable HTTP MCP JSON-RPC requests.',
              },
            }),
          );
          return;
        }

        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          const isLarge = err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE';
          sendJson(res, isLarge ? 413 : 400, {
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32700,
              message: isLarge ? 'Payload too large.' : 'Parse error: invalid JSON.',
            },
          });
          return;
        }

        if (Array.isArray(body)) {
          if (body.length === 0) {
            sendJson(res, 400, {
              jsonrpc: '2.0',
              id: null,
              error: { code: -32600, message: 'Empty JSON-RPC batch.' },
            });
            return;
          }
          const responses: JsonRpcResponse[] = [];
          for (const item of body) {
            const out = await handleMcpRpcObject(
              item && typeof item === 'object' ? (item as JsonRpcRequest) : {},
            );
            if (out) responses.push(out);
          }
          if (responses.length === 0) {
            res.writeHead(202);
            res.end();
            return;
          }
          sendJson(res, 200, responses);
          return;
        }

        if (!body || typeof body !== 'object') {
          sendJson(res, 400, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32600, message: 'Invalid JSON-RPC request payload.' },
          });
          return;
        }

        const singleResponse = await handleMcpRpcObject(body as JsonRpcRequest);
        if (!singleResponse) {
          res.writeHead(202);
          res.end();
          return;
        }
        sendJson(res, 200, singleResponse);
        return;
      }

      sendJson(res, 404, {
        error: `Route not found: ${method} ${pathname}`,
        availableEndpoints: ['GET /health', 'POST /scan', 'POST /mcp'],
      });
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(configuredPort, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : configuredPort;

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return { server, port: boundPort, close };
}
