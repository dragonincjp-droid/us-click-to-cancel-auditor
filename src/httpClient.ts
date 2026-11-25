import type { LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { TextDecoder } from 'node:util';
import zlib from 'node:zlib';
import { validateUrlAgainstSsrf, type DnsLookupFn } from './ssrf.js';

export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB cap
export const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
export const DEFAULT_MAX_REDIRECTS = 5;

export const AUDITOR_USER_AGENT =
  'Mozilla/5.0 (compatible; US-Click-To-Cancel-Auditor/1.0; +https://apify.com/healthy_addax/us-click-to-cancel-auditor)';

export interface RedirectPolicyDecision {
  allowed: boolean;
  reason?: string;
}

export interface SafeHttpFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  allowLocalhost?: boolean;
  dnsLookup?: DnsLookupFn;
  acceptHeader?: string;
  checkRedirectAllowed?: (nextUrl: string, hopIndex: number) => Promise<RedirectPolicyDecision>;
}

export interface SafeHttpResponse {
  ok: boolean;
  blockedBySsrf?: boolean;
  blockedByRobots?: boolean;
  errorMessage?: string;
  statusCode: number | null;
  contentType: string;
  finalUrl: string;
  redirectChain: string[];
  bodyText: string;
  byteLength: number;
  truncated: boolean;
}

type NodeLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * Builds a custom `lookup` function for `http.request` / `https.request` that strictly
 * returns ONLY the pre-validated IP addresses resolved during `validateUrlAgainstSsrf`.
 * This completely eliminates TOCTOU DNS rebinding between validation and TCP connect.
 */
function buildPinnedLookup(pinnedIps: string[]) {
  const entries: LookupAddress[] = pinnedIps.map((ip) => {
    const clean = ip.replace(/^\[|\]$/g, '');
    const family = net.isIP(clean) === 6 ? 6 : 4;
    return { address: clean, family };
  });

  return (
    _hostname: string,
    optionsOrCb:
      | number
      | { family?: number | string; all?: boolean; hints?: number; verbatim?: boolean }
      | NodeLookupCallback,
    maybeCb?: NodeLookupCallback,
  ): void => {
    const cb: NodeLookupCallback | undefined =
      typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
    if (!cb) return;

    if (entries.length === 0) {
      const err = new Error('No validated IP addresses available for pinned lookup.') as NodeJS.ErrnoException;
      err.code = 'ENOTFOUND';
      process.nextTick(() => cb(err, ''));
      return;
    }

    const opts = typeof optionsOrCb === 'object' && optionsOrCb !== null ? optionsOrCb : {};
    const wantAll = Boolean(opts.all);
    const requestedFamily =
      typeof optionsOrCb === 'number'
        ? optionsOrCb
        : opts.family === 4 || opts.family === 'IPv4'
          ? 4
          : opts.family === 6 || opts.family === 'IPv6'
            ? 6
            : 0;

    const filtered =
      requestedFamily === 4 || requestedFamily === 6
        ? entries.filter((e) => e.family === requestedFamily)
        : entries;

    const selectedList = filtered.length > 0 ? filtered : entries;

    process.nextTick(() => {
      if (wantAll) {
        cb(null, selectedList);
      } else {
        cb(null, selectedList[0].address, selectedList[0].family);
      }
    });
  };
}

async function decompressBufferUpToLimit(
  rawBuffer: Buffer,
  contentEncoding: string,
  maxOutputBytes: number,
): Promise<{ buffer: Buffer; truncated: boolean }> {
  const encoding = contentEncoding.trim().toLowerCase();
  if (!encoding || encoding === 'identity' || rawBuffer.byteLength === 0) {
    if (rawBuffer.byteLength > maxOutputBytes) {
      return { buffer: rawBuffer.subarray(0, maxOutputBytes), truncated: true };
    }
    return { buffer: rawBuffer, truncated: false };
  }

  const createDecompressor = (
    useRawDeflate = false,
  ): zlib.Gunzip | zlib.BrotliDecompress | zlib.Inflate | zlib.InflateRaw | null => {
    if (encoding.includes('br')) {
      return zlib.createBrotliDecompress();
    }
    if (encoding.includes('gzip') || encoding.includes('x-gzip')) {
      return zlib.createGunzip();
    }
    if (encoding.includes('deflate')) {
      return useRawDeflate ? zlib.createInflateRaw() : zlib.createInflate();
    }
    return null;
  };

  const runStreamDecompress = (
    useRawDeflate: boolean,
  ): Promise<{ buffer: Buffer; truncated: boolean; hadError: boolean }> =>
    new Promise((resolve) => {
      const stream = createDecompressor(useRawDeflate);
      if (!stream) {
        resolve({
          buffer:
            rawBuffer.byteLength > maxOutputBytes
              ? rawBuffer.subarray(0, maxOutputBytes)
              : rawBuffer,
          truncated: rawBuffer.byteLength > maxOutputBytes,
          hadError: false,
        });
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      let truncated = false;
      let settled = false;

      const finish = (hadError: boolean) => {
        if (settled) return;
        settled = true;
        resolve({ buffer: Buffer.concat(chunks), truncated, hadError });
      };

      stream.on('data', (chunk: Buffer) => {
        if (settled) return;
        const remaining = maxOutputBytes - total;
        if (chunk.byteLength >= remaining) {
          if (remaining > 0) {
            chunks.push(chunk.subarray(0, remaining));
            total += remaining;
          }
          truncated = true;
          stream.destroy();
          finish(false);
          return;
        }
        chunks.push(chunk);
        total += chunk.byteLength;
      });

      stream.on('end', () => finish(false));
      stream.on('close', () => finish(false));
      stream.on('error', () => finish(true));

      stream.end(rawBuffer);
    });

  const firstAttempt = await runStreamDecompress(false);
  if (firstAttempt.hadError && firstAttempt.buffer.byteLength === 0 && encoding.includes('deflate')) {
    const rawFallback = await runStreamDecompress(true);
    if (rawFallback.buffer.byteLength > 0) {
      return { buffer: rawFallback.buffer, truncated: rawFallback.truncated };
    }
  }

  if (firstAttempt.hadError && firstAttempt.buffer.byteLength === 0) {
    return {
      buffer:
        rawBuffer.byteLength > maxOutputBytes
          ? rawBuffer.subarray(0, maxOutputBytes)
          : rawBuffer,
      truncated: rawBuffer.byteLength > maxOutputBytes,
    };
  }

  return { buffer: firstAttempt.buffer, truncated: firstAttempt.truncated };
}

interface SingleHopResult {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  rawBuffer: Buffer;
  wireTruncated: boolean;
}

function executePinnedSingleHop(params: {
  parsedUrl: URL;
  pinnedIps: string[];
  maxBytes: number;
  timeoutMs: number;
  acceptHeader: string;
}): Promise<SingleHopResult> {
  const { parsedUrl, pinnedIps, maxBytes, timeoutMs, acceptHeader } = params;
  const isHttps = parsedUrl.protocol === 'https:';
  const transport = isHttps ? https : http;
  const bareHostname = parsedUrl.hostname.replace(/^\[|\]$/g, '');
  const isIpLiteral = net.isIP(bareHostname) !== 0;

  return new Promise<SingleHopResult>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanupTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanupTimer();
      reject(err);
    };

    const reqOptions: https.RequestOptions = {
      protocol: parsedUrl.protocol,
      hostname: bareHostname,
      port: parsedUrl.port ? Number(parsedUrl.port) : isHttps ? 443 : 80,
      path: `${parsedUrl.pathname || '/'}${parsedUrl.search || ''}`,
      method: 'GET',
      agent: false,
      lookup: buildPinnedLookup(pinnedIps) as unknown as https.RequestOptions['lookup'],
      headers: {
        'User-Agent': AUDITOR_USER_AGENT,
        Accept: acceptHeader,
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'close',
        Host: parsedUrl.host,
      },
    };

    if (isHttps && !isIpLiteral) {
      reqOptions.servername = bareHostname;
    }

    const req = transport.request(reqOptions, (res) => {
      const statusCode = res.statusCode ?? 0;
      const headers = res.headers;

      if (statusCode >= 300 && statusCode < 400 && typeof headers.location === 'string') {
        res.resume();
        res.destroy();
        if (!settled) {
          settled = true;
          cleanupTimer();
          resolve({
            statusCode,
            headers,
            rawBuffer: Buffer.alloc(0),
            wireTruncated: false,
          });
        }
        return;
      }

      const chunks: Buffer[] = [];
      let wireTotal = 0;
      let wireTruncated = false;
      let responseDone = false;

      const finishResponse = () => {
        if (responseDone || settled) return;
        responseDone = true;
        settled = true;
        cleanupTimer();
        resolve({
          statusCode,
          headers,
          rawBuffer: Buffer.concat(chunks),
          wireTruncated,
        });
      };

      res.on('data', (chunk: Buffer) => {
        if (responseDone || settled) return;
        const remaining = maxBytes - wireTotal;
        if (chunk.byteLength >= remaining) {
          if (remaining > 0) {
            chunks.push(chunk.subarray(0, remaining));
            wireTotal += remaining;
          }
          wireTruncated = true;
          res.destroy();
          finishResponse();
          return;
        }
        chunks.push(chunk);
        wireTotal += chunk.byteLength;
      });

      res.on('end', finishResponse);
      res.on('close', () => {
        if (wireTruncated || wireTotal > 0) {
          finishResponse();
        } else if (!settled) {
          fail(new Error('HTTP connection closed prematurely before response completed.'));
        }
      });
      res.on('error', (err) => {
        if (wireTruncated) {
          finishResponse();
        } else {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });

    timer = setTimeout(() => {
      req.destroy();
      fail(new Error(`HTTP request timed out after ${timeoutMs}ms (${parsedUrl.toString()}).`));
    }, timeoutMs);

    req.on('error', (err) => {
      fail(err instanceof Error ? err : new Error(String(err)));
    });

    req.end();
  });
}

/**
 * Fetches an HTTP/HTTPS URL with:
 * 1. Full IPv4 + 128-bit IPv6 SSRF validation BEFORE every hop
 * 2. Pinned DNS lookup in `http.request` / `https.request` (zero DNS rebinding window)
 * 3. Manual redirect validation (max 5 hops) + optional `robots.txt` per-hop gate
 * 4. Strict 2 MB wire + decompressed byte cap (gzip, deflate, brotli) & timeout guard
 */
export async function fetchSafeHttp(
  initialUrl: string,
  options: SafeHttpFetchOptions = {},
): Promise<SafeHttpResponse> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const acceptHeader =
    options.acceptHeader ??
    'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5';

  let currentUrl = initialUrl;
  const redirectChain: string[] = [];

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const ssrf = await validateUrlAgainstSsrf(currentUrl, {
      allowLocalhost: options.allowLocalhost,
      dnsLookup: options.dnsLookup,
    });

    if (!ssrf.allowed || !ssrf.normalizedUrl || !ssrf.resolvedIps) {
      return {
        ok: false,
        blockedBySsrf: true,
        errorMessage:
          hop === 0
            ? ssrf.reason || 'Blocked by SSRF security policy.'
            : `SSRF guard blocked HTTP redirect hop #${hop} (${currentUrl}): ${ssrf.reason || 'restricted target'}`,
        statusCode: null,
        contentType: '',
        finalUrl: currentUrl,
        redirectChain,
        bodyText: '',
        byteLength: 0,
        truncated: false,
      };
    }

    if (hop > 0 && options.checkRedirectAllowed) {
      const policy = await options.checkRedirectAllowed(ssrf.normalizedUrl, hop);
      if (!policy.allowed) {
        return {
          ok: false,
          blockedByRobots: true,
          errorMessage:
            policy.reason || `Redirect target disallowed by robots.txt (${ssrf.normalizedUrl}).`,
          statusCode: null,
          contentType: '',
          finalUrl: ssrf.normalizedUrl,
          redirectChain,
          bodyText: '',
          byteLength: 0,
          truncated: false,
        };
      }
    }

    const parsedUrl = new URL(ssrf.normalizedUrl);
    let hopRes: SingleHopResult;
    try {
      hopRes = await executePinnedSingleHop({
        parsedUrl,
        pinnedIps: ssrf.resolvedIps,
        maxBytes,
        timeoutMs,
        acceptHeader,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        errorMessage: msg,
        statusCode: null,
        contentType: '',
        finalUrl: ssrf.normalizedUrl,
        redirectChain,
        bodyText: '',
        byteLength: 0,
        truncated: false,
      };
    }

    if (
      (hopRes.statusCode === 301 ||
        hopRes.statusCode === 302 ||
        hopRes.statusCode === 303 ||
        hopRes.statusCode === 307 ||
        hopRes.statusCode === 308) &&
      typeof hopRes.headers.location === 'string' &&
      hopRes.headers.location.trim().length > 0
    ) {
      if (hop === maxRedirects) {
        return {
          ok: false,
          errorMessage: `Exceeded maximum HTTP redirect limit (${maxRedirects} hops) at ${ssrf.normalizedUrl}.`,
          statusCode: hopRes.statusCode,
          contentType: '',
          finalUrl: ssrf.normalizedUrl,
          redirectChain,
          bodyText: '',
          byteLength: 0,
          truncated: false,
        };
      }

      let nextUrl: string;
      try {
        nextUrl = new URL(hopRes.headers.location.trim(), ssrf.normalizedUrl).toString();
      } catch {
        return {
          ok: false,
          errorMessage: `Invalid HTTP redirect Location header: "${hopRes.headers.location}".`,
          statusCode: hopRes.statusCode,
          contentType: '',
          finalUrl: ssrf.normalizedUrl,
          redirectChain,
          bodyText: '',
          byteLength: 0,
          truncated: false,
        };
      }

      redirectChain.push(nextUrl);
      currentUrl = nextUrl;
      continue;
    }

    const contentEncoding =
      typeof hopRes.headers['content-encoding'] === 'string'
        ? hopRes.headers['content-encoding']
        : '';
    const contentType =
      typeof hopRes.headers['content-type'] === 'string'
        ? hopRes.headers['content-type']
        : '';

    const decompressed = await decompressBufferUpToLimit(
      hopRes.rawBuffer,
      contentEncoding,
      maxBytes,
    );

    const bodyText = new TextDecoder('utf-8', { fatal: false }).decode(decompressed.buffer);

    return {
      ok: hopRes.statusCode >= 200 && hopRes.statusCode < 400,
      statusCode: hopRes.statusCode,
      contentType,
      finalUrl: ssrf.normalizedUrl,
      redirectChain,
      bodyText,
      byteLength: decompressed.buffer.byteLength,
      truncated: hopRes.wireTruncated || decompressed.truncated,
      errorMessage:
        hopRes.statusCode >= 400 ? `HTTP ${hopRes.statusCode} returned by ${ssrf.normalizedUrl}` : undefined,
    };
  }

  return {
    ok: false,
    errorMessage: `Exceeded maximum HTTP redirects (${maxRedirects}).`,
    statusCode: null,
    contentType: '',
    finalUrl: currentUrl,
    redirectChain,
    bodyText: '',
    byteLength: 0,
    truncated: false,
  };
}
