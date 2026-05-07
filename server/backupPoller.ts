// Backup Target Poller - connects to Synology DSM and PBS APIs to fetch real capacity data
import https from "https";
import http from "http";
import type { TLSSocket } from "tls";

export type PollResult = {
  totalBytes: string | null;
  usedBytes: string | null;
  datastoresJson: any[] | null;
  pollStatus: "OK" | "ERROR";
  pollError: string | null;
};

type TargetInput = {
  type: "SYNOLOGY" | "PBS";
  host: string;
  port: number;
  username: string;
  password: string;
  tlsFingerprint?: string | null;
  allowInsecureTls?: boolean | null;
};

// Synology DSM API

async function pollSynology(input: TargetInput): Promise<PollResult> {
  const base = `https://${input.host}:${input.port}/webapi`;

  // Step 1: Authenticate
  const authUrl = `${base}/entry.cgi?` + new URLSearchParams({
    api: "SYNO.API.Auth",
    version: "7",
    method: "login",
    account: input.username,
    passwd: input.password,
    format: "sid",
  });

  const authRes = await fetchTargetApi(authUrl, undefined, input);
  if (!authRes.success) {
    const errCode = authRes.error?.code;
    const errMsg = errCode === 400 ? "Invalid credentials"
      : errCode === 401 ? "Account disabled"
      : errCode === 403 ? "2FA required (not supported)"
      : errCode === 404 ? "Permission denied"
      : `Auth failed (code ${errCode || "unknown"})`;
    return { totalBytes: null, usedBytes: null, datastoresJson: null, pollStatus: "ERROR", pollError: errMsg };
  }

  const sid = authRes.data?.sid;
  if (!sid) {
    return { totalBytes: null, usedBytes: null, datastoresJson: null, pollStatus: "ERROR", pollError: "No session ID returned" };
  }

  try {
    // Step 2: Get volume info via SYNO.Core.System (works for non-admin users)
    // Try multiple APIs in order of accessibility
    let volumes: any[] = [];
    let totalBytes = BigInt(0);
    let usedBytes = BigInt(0);

    // Primary: SYNO.Core.System with type=storage (works for all users)
    const sysInfoUrl = `${base}/entry.cgi?` + new URLSearchParams({
      api: "SYNO.Core.System",
      version: "3",
      method: "info",
      type: "storage",
      _sid: sid,
    });

    const sysInfoRes = await fetchTargetApi(sysInfoUrl, undefined, input);

    if (sysInfoRes.success && sysInfoRes.data?.vol_info) {
      for (const vol of sysInfoRes.data.vol_info) {
        const volTotal = BigInt(vol.total_size || 0);
        const volUsed = BigInt(vol.used_size || 0);
        totalBytes += volTotal;
        usedBytes += volUsed;

        // Format name: "volume_1" -> "Volume 1"
        const displayName = (vol.name || vol.volume || `volume_${volumes.length + 1}`)
          .replace(/^volume_?/i, "Volume ")
          .trim();

        volumes.push({
          name: displayName,
          totalBytes: volTotal.toString(),
          usedBytes: volUsed.toString(),
          status: vol.status || "normal",
        });
      }
    }

    // Fallback: SYNO.Storage.CGI.Volume (requires admin)
    if (volumes.length === 0) {
      const volumeUrl = `${base}/entry.cgi?` + new URLSearchParams({
        api: "SYNO.Storage.CGI.Volume",
        version: "1",
        method: "list",
        _sid: sid,
      });

      const volumeRes = await fetchTargetApi(volumeUrl, undefined, input);

      if (volumeRes.success && volumeRes.data?.volumes) {
        for (const vol of volumeRes.data.volumes) {
          const volTotal = BigInt(vol.size?.total || vol.total || 0);
          const volUsed = BigInt(vol.size?.used || vol.used || 0);
          totalBytes += volTotal;
          usedBytes += volUsed;

          volumes.push({
            name: vol.display_name || vol.vol_path || vol.volume_id || `Volume ${volumes.length + 1}`,
            totalBytes: volTotal.toString(),
            usedBytes: volUsed.toString(),
            status: vol.status || "normal",
          });
        }
      }
    }

    // Step 3: Get share count per volume (optional, best-effort)
    try {
      const shareUrl = `${base}/entry.cgi?` + new URLSearchParams({
        api: "SYNO.Core.Share",
        version: "1",
        method: "list",
        _sid: sid,
      });

      const shareRes = await fetchTargetApi(shareUrl, undefined, input);
      if (shareRes.success && shareRes.data?.shares) {
        // Count shares per volume path
        const shareCounts: Record<string, number> = {};
        for (const share of shareRes.data.shares) {
          const volPath = share.vol_path || "";
          if (volPath) shareCounts[volPath] = (shareCounts[volPath] || 0) + 1;
        }

        // Attach share counts to volumes by matching volume number
        for (const vol of volumes) {
          const volNum = vol.name.match(/(\d+)/);
          if (volNum) {
            const volPath = `/volume${volNum[1]}`;
            if (shareCounts[volPath] !== undefined) {
              vol.shareCount = shareCounts[volPath];
            }
          }
        }

        // If no match worked, assign total to first volume
        const assigned = volumes.reduce((s: number, v: any) => s + (v.shareCount || 0), 0);
        if (assigned === 0 && shareRes.data.shares.length > 0 && volumes.length > 0) {
          volumes[0].shareCount = shareRes.data.shares.length;
        }
      }
    } catch {
      // Share count is optional
    }

    if (volumes.length === 0) {
      return { totalBytes: null, usedBytes: null, datastoresJson: null, pollStatus: "ERROR", pollError: "No volumes found - check user permissions" };
    }

    return {
      totalBytes: totalBytes.toString(),
      usedBytes: usedBytes.toString(),
      datastoresJson: volumes,
      pollStatus: "OK",
      pollError: null,
    };
  } finally {
    // Step 4: Logout (best-effort)
    try {
      const logoutUrl = `${base}/entry.cgi?` + new URLSearchParams({
        api: "SYNO.API.Auth",
        version: "7",
        method: "logout",
        _sid: sid,
      });
      await fetchTargetApi(logoutUrl, undefined, input);
    } catch {}
  }
}

// Proxmox Backup Server API

async function pollPBS(input: TargetInput): Promise<PollResult> {
  const base = `https://${input.host}:${input.port}/api2/json`;

  // Step 1: Authenticate
  const authRes = await fetchTargetApi(`${base}/access/ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: input.username, password: input.password }),
  }, input);

  if (!authRes.data?.ticket) {
    return {
      totalBytes: null,
      usedBytes: null,
      datastoresJson: null,
      pollStatus: "ERROR",
      pollError: authRes.errors ? JSON.stringify(authRes.errors) : "Authentication failed",
    };
  }

  const ticket = authRes.data.ticket;
  const csrf = authRes.data.CSRFPreventionToken;

  const authHeaders: Record<string, string> = {
    Cookie: `PBSAuthCookie=${ticket}`,
  };
  if (csrf) authHeaders["CSRFPreventionToken"] = csrf;

  // Step 2: Get datastores
  const dsRes = await fetchTargetApi(`${base}/admin/datastore`, {
    headers: authHeaders,
  }, input);

  if (!dsRes.data || !Array.isArray(dsRes.data)) {
    return {
      totalBytes: null,
      usedBytes: null,
      datastoresJson: null,
      pollStatus: "ERROR",
      pollError: "Failed to list datastores",
    };
  }

  // Step 3: Get status for each datastore
  const datastores: any[] = [];
  let totalBytes = BigInt(0);
  let usedBytes = BigInt(0);

  for (const ds of dsRes.data) {
    const name = ds.store || ds.name;
    try {
      const statusRes = await fetchTargetApi(`${base}/admin/datastore/${name}/status`, {
        headers: authHeaders,
      }, input);

      if (statusRes.data) {
        const dsTotal = BigInt(statusRes.data.total || 0);
        const dsUsed = BigInt(statusRes.data.used || 0);
        totalBytes += dsTotal;
        usedBytes += dsUsed;

        // Get snapshot count
        let snapshotCount: number | undefined;
        try {
          const snapRes = await fetchTargetApi(`${base}/admin/datastore/${name}/snapshots`, {
            headers: authHeaders,
          }, input);
          if (snapRes.data && Array.isArray(snapRes.data)) {
            snapshotCount = snapRes.data.length;
          }
        } catch {}

        datastores.push({
          name,
          totalBytes: dsTotal.toString(),
          usedBytes: dsUsed.toString(),
          snapshotCount,
        });
      }
    } catch {
      datastores.push({ name, totalBytes: "0", usedBytes: "0" });
    }
  }

  if (datastores.length === 0) {
    return { totalBytes: null, usedBytes: null, datastoresJson: null, pollStatus: "ERROR", pollError: "No datastores found" };
  }

  return {
    totalBytes: totalBytes.toString(),
    usedBytes: usedBytes.toString(),
    datastoresJson: datastores,
    pollStatus: "OK",
    pollError: null,
  };
}

// Helpers

function normalizeFingerprint(value: string): string {
  return value.replace(/^sha256:/i, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function fetchTargetApi(
  url: string,
  options?: { method?: string; headers?: Record<string, string>; body?: string },
  tlsOptions?: Pick<TargetInput, "tlsFingerprint" | "allowInsecureTls">,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const expectedFingerprint = tlsOptions?.tlsFingerprint?.trim();
    const allowInsecureTls =
      tlsOptions?.allowInsecureTls === true ||
      process.env.ALLOW_INSECURE_TARGET_TLS === "1";
    const rejectUnauthorized = isHttps && !expectedFingerprint && !allowInsecureTls;

    const reqOptions: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options?.method || "GET",
      headers: options?.headers || {},
      rejectUnauthorized,
    };

    if (isHttps) {
      reqOptions.agent = new https.Agent({ rejectUnauthorized });
    }

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("ETIMEDOUT"));
    }, 15000);

    const req = lib.request(reqOptions, (res) => {
      if (isHttps && expectedFingerprint) {
        const cert = (res.socket as TLSSocket).getPeerCertificate();
        const actualFingerprint = cert.fingerprint256 || cert.fingerprint || "";
        if (!actualFingerprint || normalizeFingerprint(actualFingerprint) !== normalizeFingerprint(expectedFingerprint)) {
          clearTimeout(timer);
          res.resume();
          reject(new Error("TLS_FINGERPRINT_MISMATCH"));
          return;
        }
      }

      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve({ success: false, error: { code: res.statusCode, message: body.substring(0, 200) } });
        }
      });
    });

    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });

    if (options?.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// Public API

export async function pollBackupTarget(input: TargetInput): Promise<PollResult> {
  try {
    if (input.type === "SYNOLOGY") {
      return await pollSynology(input);
    } else if (input.type === "PBS") {
      return await pollPBS(input);
    }
    return { totalBytes: null, usedBytes: null, datastoresJson: null, pollStatus: "ERROR", pollError: `Unknown target type: ${input.type}` };
  } catch (e: any) {
    const msg = e?.message || "Unknown error";
    if (msg.includes("ECONNREFUSED")) return { totalBytes: null, usedBytes: null, datastoresJson: null, pollStatus: "ERROR", pollError: "Connection refused: host unreachable" };
    if (msg.includes("ETIMEDOUT") || msg.includes("abort")) return { totalBytes: null, usedBytes: null, datastoresJson: null, pollStatus: "ERROR", pollError: "Connection timed out" };
    if (msg.includes("TLS_FINGERPRINT_MISMATCH")) return { totalBytes: null, usedBytes: null, datastoresJson: null, pollStatus: "ERROR", pollError: "TLS certificate fingerprint mismatch" };
    if (msg.includes("SELF_SIGNED") || msg.includes("UNABLE_TO_VERIFY")) return { totalBytes: null, usedBytes: null, datastoresJson: null, pollStatus: "ERROR", pollError: "TLS certificate error - self-signed cert" };
    return { totalBytes: null, usedBytes: null, datastoresJson: null, pollStatus: "ERROR", pollError: msg };
  }
}
