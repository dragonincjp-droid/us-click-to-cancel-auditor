import fs from 'node:fs';
import path from 'node:path';
import type { PpeEventName, RawActorInput } from './types.js';

export interface SdkChargeResponse {
  eventChargeLimitReached?: boolean;
  chargedCount?: number;
}

interface ApifyActorSdkLike {
  init: () => Promise<void>;
  exit: (options?: { exitCode?: number }) => Promise<void>;
  getInput: <T = unknown>() => Promise<T | null>;
  pushData: (item: unknown) => Promise<void>;
  charge?: (options: { eventName: string; count?: number }) => Promise<SdkChargeResponse>;
}

const AUTO_DETECT_DATASET_URL_FIELDS = [
  'website',
  'url',
  'domain',
  'shopUrl',
  'storeUrl',
  'appUrl',
  'pricingUrl',
] as const;

function extractUrlFromDatasetRecord(
  record: Record<string, unknown>,
  explicitField?: string,
): string | null {
  const tryKey = (key: string): string | null => {
    const val = record[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
    return null;
  };

  if (explicitField && explicitField.trim()) {
    const direct = tryKey(explicitField.trim());
    if (direct) return direct;
  }

  for (const candidate of AUTO_DETECT_DATASET_URL_FIELDS) {
    const found = tryKey(candidate);
    if (found) return found;
  }

  const lowerTargets = new Set<string>([
    ...(explicitField ? [explicitField.trim().toLowerCase()] : []),
    ...AUTO_DETECT_DATASET_URL_FIELDS.map((f) => f.toLowerCase()),
  ]);

  for (const [k, v] of Object.entries(record)) {
    if (lowerTargets.has(k.toLowerCase()) && typeof v === 'string' && v.trim().length > 0) {
      return v.trim();
    }
  }

  return null;
}

export class ApifyRuntimeAdapter {
  private sdkActor: ApifyActorSdkLike | null = null;
  private initialized = false;
  private localDatasetCounter = 0;

  public getStorageRoot(): string {
    return path.resolve(process.env.APIFY_LOCAL_STORAGE_DIR || path.join(process.cwd(), 'storage'));
  }

  public async init(): Promise<void> {
    if (this.initialized) return;

    if (process.env.APIFY_IS_AT_HOME === '1') {
      const pkgName = 'apify';
      try {
        const mod = (await import(pkgName)) as { Actor?: ApifyActorSdkLike };
        if (mod?.Actor && typeof mod.Actor.init === 'function') {
          this.sdkActor = mod.Actor;
          await this.sdkActor.init();
          this.initialized = true;
          return;
        }
      } catch {
        // Fallback to local file-backed Apify storage layout
      }
    }

    const root = this.getStorageRoot();
    fs.mkdirSync(path.join(root, 'datasets', 'default'), { recursive: true });
    fs.mkdirSync(path.join(root, 'key_value_stores', 'default'), { recursive: true });
    this.initialized = true;
  }

  public async getInput(): Promise<RawActorInput | null> {
    await this.init();
    if (this.sdkActor) {
      return await this.sdkActor.getInput<RawActorInput>();
    }

    if (process.env.APIFY_INPUT_JSON) {
      try {
        return JSON.parse(process.env.APIFY_INPUT_JSON) as RawActorInput;
      } catch {
        return null;
      }
    }

    const inputPath = path.join(this.getStorageRoot(), 'key_value_stores', 'default', 'INPUT.json');
    if (fs.existsSync(inputPath)) {
      try {
        return JSON.parse(fs.readFileSync(inputPath, 'utf8')) as RawActorInput;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Loads target URLs from an upstream Apify Dataset (`datasetId`) for seamless chaining
   * (e.g. Shopify Store Lead Scraper / Google Maps Scraper -> US Click-to-Cancel Auditor).
   * Enforces strict ID path-traversal validation, field projection, and a 5 MB streaming cap.
   */
  public async loadUrlsFromDataset(
    datasetId: string,
    datasetUrlField?: string,
  ): Promise<string[]> {
    const trimmedId = datasetId.trim();
    if (
      !trimmedId ||
      trimmedId.includes('..') ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._~-]{0,127}$/.test(trimmedId)
    ) {
      console.warn(`[datasetId] Rejected invalid datasetId format: "${trimmedId.slice(0, 64)}".`);
      return [];
    }

    let rawItems: unknown[] = [];

    // 1. Check local file-backed dataset first when running offline/locally
    const datasetsRoot = path.resolve(this.getStorageRoot(), 'datasets');
    const localDatasetDir = path.resolve(datasetsRoot, trimmedId);
    const isInsideDatasetsRoot = localDatasetDir.startsWith(`${datasetsRoot}${path.sep}`);

    if (isInsideDatasetsRoot && process.env.APIFY_IS_AT_HOME !== '1' && fs.existsSync(localDatasetDir)) {
      try {
        const files = fs
          .readdirSync(localDatasetDir)
          .filter((f) => f.endsWith('.json'))
          .sort();
        for (const file of files.slice(0, 1000)) {
          const parsed = JSON.parse(fs.readFileSync(path.join(localDatasetDir, file), 'utf8')) as unknown;
          if (Array.isArray(parsed)) {
            rawItems.push(...parsed);
          } else if (parsed && typeof parsed === 'object') {
            rawItems.push(parsed);
          }
        }
      } catch {
        // Ignore malformed local dataset files and try API if available
      }
    }

    // 2. Fetch from Apify Dataset REST API when running at home or with APIFY_TOKEN
    if (
      rawItems.length === 0 &&
      (process.env.APIFY_IS_AT_HOME === '1' || Boolean(process.env.APIFY_TOKEN?.trim()))
    ) {
      const projectionFields = new Set<string>(AUTO_DETECT_DATASET_URL_FIELDS);
      const cleanCustomField = datasetUrlField?.trim();
      if (cleanCustomField && /^[a-zA-Z0-9_.-]{1,64}$/.test(cleanCustomField)) {
        projectionFields.add(cleanCustomField);
      }
      const fieldsParam = Array.from(projectionFields).join(',');
      const apiUrl = `https://api.apify.com/v2/datasets/${encodeURIComponent(trimmedId)}/items?clean=true&limit=1000&fields=${encodeURIComponent(fieldsParam)}`;
      const headers: Record<string, string> = {
        Accept: 'application/json',
      };
      const token = process.env.APIFY_TOKEN?.trim();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      try {
        const res = await fetch(apiUrl, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok && res.body) {
          const MAX_DATASET_JSON_BYTES = 5 * 1024 * 1024; // 5 MB safety cap for 256 MB RAM
          const reader = res.body.getReader();
          const chunks: Uint8Array[] = [];
          let totalBytes = 0;
          let exceededCap = false;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              totalBytes += value.byteLength;
              if (totalBytes > MAX_DATASET_JSON_BYTES) {
                exceededCap = true;
                await reader.cancel();
                break;
              }
              chunks.push(value);
            }
          }

          if (exceededCap) {
            console.warn(`[datasetId] Dataset "${trimmedId}" response exceeded 5 MB cap; skipping.`);
          } else {
            const merged = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
            const payload = JSON.parse(merged) as unknown;
            if (Array.isArray(payload)) {
              rawItems = payload;
            }
          }
        } else if (!res.ok) {
          console.warn(`[datasetId] Apify Dataset API returned HTTP ${res.status} for "${trimmedId}".`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[datasetId] Failed to fetch dataset "${trimmedId}": ${msg}`);
      }
    }

    // 3. Fallback to local storage even if APIFY_IS_AT_HOME was set but API call returned nothing
    if (isInsideDatasetsRoot && rawItems.length === 0 && fs.existsSync(localDatasetDir)) {
      try {
        const files = fs
          .readdirSync(localDatasetDir)
          .filter((f) => f.endsWith('.json'))
          .sort();
        for (const file of files.slice(0, 1000)) {
          const parsed = JSON.parse(fs.readFileSync(path.join(localDatasetDir, file), 'utf8')) as unknown;
          if (Array.isArray(parsed)) {
            rawItems.push(...parsed);
          } else if (parsed && typeof parsed === 'object') {
            rawItems.push(parsed);
          }
        }
      } catch {
        // Ignore fallback errors
      }
    }

    const urls: string[] = [];
    for (const item of rawItems) {
      if (typeof item === 'string' && item.trim()) {
        urls.push(item.trim());
      } else if (item && typeof item === 'object' && !Array.isArray(item)) {
        const extracted = extractUrlFromDatasetRecord(
          item as Record<string, unknown>,
          datasetUrlField,
        );
        if (extracted) {
          urls.push(extracted);
        }
      }
    }

    return urls;
  }

  public async pushData(item: unknown): Promise<void> {
    await this.init();
    if (this.sdkActor) {
      await this.sdkActor.pushData(item);
      return;
    }

    const items = Array.isArray(item) ? item : [item];
    const dsDir = path.join(this.getStorageRoot(), 'datasets', 'default');
    fs.mkdirSync(dsDir, { recursive: true });
    for (const entry of items) {
      this.localDatasetCounter += 1;
      const filename = `${String(this.localDatasetCounter).padStart(9, '0')}.json`;
      fs.writeFileSync(path.join(dsDir, filename), JSON.stringify(entry, null, 2), 'utf8');
    }
  }

  public async sdkCharge(eventName: PpeEventName, count = 1): Promise<SdkChargeResponse | null> {
    await this.init();
    if (this.sdkActor && typeof this.sdkActor.charge === 'function') {
      try {
        return await this.sdkActor.charge({ eventName, count });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[billing] Actor.charge("${eventName}") warning: ${msg}`);
        return null;
      }
    }
    return null;
  }

  public async exit(exitCode = 0): Promise<void> {
    if (this.sdkActor) {
      await this.sdkActor.exit({ exitCode });
      return;
    }
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  }
}
