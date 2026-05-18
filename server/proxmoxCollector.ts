import { Client } from "ssh2";

export type ProxmoxCheckResult = {
  overall_status: "OK" | "WARN" | "CRIT" | "UNKNOWN";
  storage_type: "ZFS" | "RAID" | "MDADM" | "MIXED" | "NONE" | "UNKNOWN";
  components: {
    zfs?: {
      status: string;
      pools: { name: string; state: string; size?: string; alloc?: string; free?: string; frag?: string; cap?: string }[];
    };
    raid?: {
      status: string;
      controller?: string;
      virtual_disks: { name: string; state: string; size?: string; raid_level?: string }[];
      virtual_disks_degraded?: number;
      predictive_failures?: number;
    };
    mdadm?: {
      status: string;
      arrays: { name: string; state: string; level?: string; devices?: number; active?: number; rebuild_progress?: string }[];
      arrays_degraded?: number;
    };
    smart: {
      status: string;
      disks: {
        name: string;
        model: string;
        serial?: string;
        status: string;
        temperature: number | null;
        reallocated: number;
        pending: number;
        power_on_hours?: number | null;
        size?: string | null;
      }[];
      disks_total: number;
      disks_warning: number;
      disks_failed: number;
    };
    meta: { hostname: string };
  };
  monitoring_error: string | null;
};

type CollectInput = {
  host: string;
  connectHost?: string;
  port: number;
  username: string;
  password: string;
  hostKeyFingerprint?: string | null;
  allowInsecureHostKey?: boolean | null;
  timeoutSeconds?: number | null;
};

const SSH_ERROR_PREFIX = "__SSH_ERROR__:";

function normalizeFingerprint(value: string): string {
  return value.replace(/^sha256:/i, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

// ── SSH helper ──────────────────────────────────────────────────────────

function runSSH(
  input: CollectInput,
  command: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = "";
    let done = false;
    let observedHostKey: string | null = null;
    const expectedHostKey = input.hostKeyFingerprint?.trim();
    const allowInsecureHostKey =
      input.allowInsecureHostKey === true ||
      process.env.ALLOW_INSECURE_SSH_HOST_KEYS === "1";
    const timeoutMs = Math.max(1, input.timeoutSeconds || 20) * 1000;

    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      try { conn.end(); } catch {}
      reject(new Error("SSH_TIMEOUT"));
    }, timeoutMs);

    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timeout);
            done = true;
            conn.end();
            return reject(err);
          }
          stream
            .on("close", () => {
              clearTimeout(timeout);
              if (done) return;
              done = true;
              conn.end();
              resolve(output.trim());
            })
            .on("data", (data: Buffer) => (output += data.toString()))
            .stderr.on("data", () => {}); // ignore stderr noise
        });
      })
      .on("error", (e) => {
        clearTimeout(timeout);
        if (done) return;
        done = true;
        try { conn.end(); } catch {}
        if (observedHostKey) {
          return reject(new Error(`HOST_KEY_UNVERIFIED:${observedHostKey}`));
        }
        reject(e);
      })
      .connect({
        host: input.connectHost || input.host,
        port: input.port,
        username: input.username,
        password: input.password,
        readyTimeout: timeoutMs,
        tryKeyboard: false,
        hostHash: "sha256",
        hostVerifier: (hashedKey) => {
          observedHostKey = hashedKey;
          if (expectedHostKey) {
            return normalizeFingerprint(hashedKey) === normalizeFingerprint(expectedHostKey);
          }
          return allowInsecureHostKey;
        },
      });
  });
}

// Convenience: run a command, return "" on any failure
async function ssh(input: CollectInput, cmd: string): Promise<string> {
  try {
    return await runSSH(input, cmd);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "";
    if (msg.startsWith("HOST_KEY_UNVERIFIED")) {
      return `${SSH_ERROR_PREFIX}${msg}`;
    }
    if (msg.toLowerCase().includes("authentication")) {
      return `${SSH_ERROR_PREFIX}AUTH_FAILED`;
    }
    return "";
  }
}

// ── ZFS ─────────────────────────────────────────────────────────────────

function parseZpoolList(raw: string) {
  const pools: { name: string; state: string; size?: string; alloc?: string; free?: string; frag?: string; cap?: string }[] = [];
  if (!raw) return { pools, status: "UNKNOWN" as string };

  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const parts = line.split(/\t+/);
    if (parts.length < 2) continue;
    const [name, size, alloc, free, frag, cap, health] = parts;
    if (!name || name === "NAME") continue;
    pools.push({
      name,
      state: health || "UNKNOWN",
      size: size || undefined,
      alloc: alloc || undefined,
      free: free || undefined,
      frag: frag || undefined,
      cap: cap || undefined,
    });
  }

  let status = "UNKNOWN";
  if (pools.length > 0) {
    if (pools.some(p => p.state === "FAULTED")) status = "CRIT";
    else if (pools.some(p => p.state === "DEGRADED")) status = "WARN";
    else if (pools.every(p => p.state === "ONLINE")) status = "OK";
    else status = "WARN";
  }
  return { pools, status };
}

// ── MDADM (/proc/mdstat) ───────────────────────────────────────────────

function parseMdstat(raw: string) {
  const arrays: NonNullable<ProxmoxCheckResult["components"]["mdadm"]>["arrays"] = [];
  if (!raw) return { arrays, status: "UNKNOWN" as string, arrays_degraded: 0 };

  // Each array block starts with mdN : active ...
  const blocks = raw.split(/^(md\d+)/m);
  // blocks: ["Personalities...", "md0", " : active raid1 ...", "md1", " : active ...", ...]
  for (let i = 1; i < blocks.length; i += 2) {
    const name = `/dev/${blocks[i]}`;
    const body = blocks[i + 1] || "";
    const firstLine = body.split("\n")[0] || "";

    // Extract level
    const levelMatch = firstLine.match(/\b(raid[0-9]+|linear)\b/i);
    const level = levelMatch ? levelMatch[1].toUpperCase() : undefined;

    // Device counts: e.g. [2/2] [UU] or [2/1] [U_]
    const countMatch = body.match(/\[(\d+)\/(\d+)\]/);
    const devices = countMatch ? parseInt(countMatch[1]) : undefined;
    const active = countMatch ? parseInt(countMatch[2]) : undefined;

    // State markers: [UU] = all up, [U_] = degraded
    const stateMatch = body.match(/\[([U_]+)\]/);
    let state = "OK";
    if (stateMatch) {
      state = stateMatch[1].includes("_") ? "DEGRADED" : "OK";
    }

    // Rebuild progress
    const rebuildMatch = body.match(/recovery\s*=\s*([\d.]+%)/);
    const rebuild_progress = rebuildMatch ? rebuildMatch[1] : undefined;
    if (rebuild_progress) state = "REBUILDING";

    arrays.push({ name, state, level, devices, active, rebuild_progress });
  }

  const arrays_degraded = arrays.filter(a => a.state === "DEGRADED" || a.state === "REBUILDING").length;
  let status = "OK";
  if (arrays.length === 0) status = "UNKNOWN";
  else if (arrays.some(a => a.state === "DEGRADED")) status = "WARN";
  else if (arrays.every(a => a.state === "OK")) status = "OK";

  return { arrays, status, arrays_degraded };
}

// ── Hardware RAID ───────────────────────────────────────────────────────

function detectRaidController(lspciRaw: string): string | null {
  if (!lspciRaw) return null;
  const lines = lspciRaw.toLowerCase();
  if (lines.includes("megaraid") || lines.includes("perc") || lines.includes("lsi")) return "MegaRAID/PERC";
  if (lines.includes("smartarray") || lines.includes("hpsa")) return "HP SmartArray";
  if (lines.includes("adaptec") || lines.includes("aacraid")) return "Adaptec";
  if (lines.includes("areca")) return "Areca";
  if (lines.includes("3ware")) return "3ware";
  // Generic RAID controller mention
  if (lines.includes("raid")) return "Hardware RAID";
  return null;
}

interface LsblkDisk {
  name: string;
  model: string;
  size: string;
  type: string;
  children?: string[];
}

type LsblkRawDevice = {
  name?: string;
  model?: string;
  size?: string;
  type?: string;
  children?: { name?: string }[];
};

function parseLsblkJson(raw: string): LsblkDisk[] {
  const disks: LsblkDisk[] = [];
  if (!raw) return disks;

  try {
    const parsed = JSON.parse(raw);
    const devices: LsblkRawDevice[] = Array.isArray(parsed.blockdevices) ? parsed.blockdevices : [];
    for (const dev of devices) {
      if (dev.type === "disk") {
        disks.push({
          name: dev.name || "",
          model: (dev.model || "").trim(),
          size: dev.size || "",
          type: dev.type,
          children: (dev.children || [])
            .map((child) => child.name)
            .filter((name): name is string => typeof name === "string"),
        });
      }
    }
  } catch {
    // Fallback: parse line-based format
    const lines = raw.split("\n").filter(Boolean);
    for (const line of lines) {
      const parts = line.split("|").map(s => s.trim());
      if (parts.length >= 4 && parts[3] === "disk") {
        disks.push({ name: parts[0], model: parts[1], size: parts[2], type: "disk" });
      }
    }
  }
  return disks;
}

function inferRaidFromModels(disks: LsblkDisk[]): boolean {
  const raidKeywords = ["perc", "raid", "megaraid", "smartarray", "hpsa", "adaptec", "areca", "3ware", "logical volume"];
  return disks.some(d => {
    const model = d.model.toLowerCase();
    return raidKeywords.some(kw => model.includes(kw));
  });
}

function buildRaidVirtualDisks(
  storcliRaw: string,
  disks: LsblkDisk[],
  controller: string | null
): NonNullable<ProxmoxCheckResult["components"]["raid"]>["virtual_disks"] {
  const vds: NonNullable<ProxmoxCheckResult["components"]["raid"]>["virtual_disks"] = [];

  // Try to parse storcli/megacli JSON output first
  if (storcliRaw) {
    try {
      const parsed = JSON.parse(storcliRaw);
      const controllers = parsed["Controllers"] || [];
      for (const ctrl of controllers) {
        const responseData = ctrl["Response Data"] || ctrl["response"] || {};
        const vdList = responseData["Virtual Drives"] || responseData["VD LIST"] || [];
        for (const vd of vdList) {
          vds.push({
            name: `VD${vd["DG/VD"] || vd["VD"] || vds.length}`,
            state: (vd["State"] || "Unknown").toUpperCase() === "OPTL" ? "ONLINE" :
                   (vd["State"] || "Unknown").toUpperCase() === "DGRD" ? "DEGRADED" :
                   (vd["State"] || "Unknown").toUpperCase(),
            size: vd["Size"] || undefined,
            raid_level: vd["TYPE"] || vd["RAID Level"] ? `RAID-${vd["RAID Level"] || vd["TYPE"]}` : undefined,
          });
        }
      }
    } catch {
      // storcli output wasn't JSON, try line parsing
      const lines = storcliRaw.split("\n");
      for (const line of lines) {
        // Match lines like: 0/0  RAID1  Optl  ...
        const match = line.match(/^(\d+\/\d+)\s+(RAID\d+)\s+(\w+)\s+/i);
        if (match) {
          const state = match[3].toUpperCase();
          vds.push({
            name: `VD${match[1]}`,
            state: state === "OPTL" ? "ONLINE" : state === "DGRD" ? "DEGRADED" : state,
            raid_level: match[2].toUpperCase(),
          });
        }
      }
    }
  }

  // If no storcli data but we detected a RAID controller, infer VDs from lsblk
  if (vds.length === 0 && controller) {
    // On hardware RAID, each "disk" visible to the OS is typically a virtual disk
    for (const disk of disks) {
      const model = disk.model.toLowerCase();
      const isRaidDisk = ["perc", "raid", "megaraid", "logical", "virtual"].some(kw => model.includes(kw))
                         || model === "" // RAID controllers sometimes show empty model
                         || controller !== null;
      if (isRaidDisk) {
        vds.push({
          name: `/dev/${disk.name}`,
          state: "ONLINE",
          size: disk.size || undefined,
          raid_level: undefined, // Can't determine without storcli
        });
      }
    }
  }

  return vds;
}

// ── SMART ───────────────────────────────────────────────────────────────

interface SmartDisk {
  name: string;
  model: string;
  serial?: string;
  status: string;
  temperature: number | null;
  reallocated: number;
  pending: number;
  power_on_hours?: number | null;
  size?: string | null;
}

function parseSmartctl(raw: string, diskName: string): SmartDisk | null {
  if (!raw) return null;

  const disk: SmartDisk = {
    name: `/dev/${diskName}`,
    model: "",
    status: "OK",
    temperature: null,
    reallocated: 0,
    pending: 0,
    power_on_hours: null,
    size: null,
  };

  // Model
  const modelMatch = raw.match(/Device Model:\s*(.+)/i) || raw.match(/Product:\s*(.+)/i) || raw.match(/Model Number:\s*(.+)/i);
  if (modelMatch) disk.model = modelMatch[1].trim();

  // Serial
  const serialMatch = raw.match(/Serial Number:\s*(.+)/i) || raw.match(/Serial number:\s*(.+)/i);
  if (serialMatch) disk.serial = serialMatch[1].trim();

  // Capacity
  const sizeMatch = raw.match(/User Capacity:\s*[\d,]+\s*bytes\s*\[(.+?)\]/i) || raw.match(/Total NVM Capacity:\s*[\d,]+\s*bytes\s*\[(.+?)\]/i);
  if (sizeMatch) disk.size = sizeMatch[1].trim();

  // Overall SMART health
  const healthMatch = raw.match(/SMART overall-health self-assessment test result:\s*(\w+)/i) || raw.match(/SMART Health Status:\s*(.+)/i);
  if (healthMatch) {
    const h = healthMatch[1].trim().toUpperCase();
    if (h !== "PASSED" && h !== "OK") disk.status = "CRIT";
  }

  // Temperature (multiple sources)
  const tempMatch = raw.match(/^194\s+Temperature_Celsius\s+\S+\s+(\d+)/m)
    || raw.match(/^190\s+Airflow_Temperature_Cel\s+\S+\s+(\d+)/m)
    || raw.match(/Temperature:\s+(\d+)\s*(?:Celsius|C)/im)
    || raw.match(/Current Temperature:\s+(\d+)/im);
  if (tempMatch) disk.temperature = parseInt(tempMatch[1]);

  // Reallocated sectors (ID 5)
  const reallocMatch = raw.match(/^\s*5\s+Reallocated_Sector_Ct\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+)/m);
  if (reallocMatch) disk.reallocated = parseInt(reallocMatch[1]);

  // Current pending sectors (ID 197)
  const pendingMatch = raw.match(/^\s*197\s+Current_Pending_Sector\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+)/m);
  if (pendingMatch) disk.pending = parseInt(pendingMatch[1]);

  // Power on hours (ID 9)
  const pohMatch = raw.match(/^\s*9\s+Power_On_Hours\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+)/m);
  if (pohMatch) disk.power_on_hours = parseInt(pohMatch[1]);

  // Determine warning vs crit
  if (disk.status !== "CRIT") {
    if (disk.reallocated > 100 || disk.pending > 10) disk.status = "CRIT";
    else if (disk.reallocated > 0 || disk.pending > 0) disk.status = "WARN";
    else if (disk.temperature !== null && disk.temperature > 55) disk.status = "WARN";
  }

  return disk;
}

// ── Main collector ──────────────────────────────────────────────────────

export async function collectProxmoxHealth(input: CollectInput): Promise<ProxmoxCheckResult> {
  try {
    // Phase 1: Discovery — run all probes in parallel
    const [hostname, zpoolRaw, mdstatRaw, lspciRaw, lsblkRaw, smartScanRaw, storcliPath, megacliPath] =
      await Promise.all([
        ssh(input, "hostname"),
        ssh(input, "command -v zpool >/dev/null 2>&1 && zpool list -H -o name,size,alloc,free,frag,cap,health 2>/dev/null || true"),
        ssh(input, "cat /proc/mdstat 2>/dev/null || true"),
        ssh(input, "lspci 2>/dev/null | grep -iE 'raid|storage|scsi|sas|megaraid|perc|smartarray' || true"),
        ssh(input, "lsblk -J -d -o NAME,MODEL,SIZE,TYPE 2>/dev/null || lsblk -dn -o NAME,MODEL,SIZE,TYPE --pairs 2>/dev/null || true"),
        ssh(input, "command -v smartctl >/dev/null 2>&1 && smartctl --scan 2>/dev/null || true"),
        ssh(input, "command -v storcli64 2>/dev/null || command -v storcli 2>/dev/null || true"),
        ssh(input, "command -v megacli 2>/dev/null || command -v MegaCli64 2>/dev/null || true"),
      ]);

    if (hostname.startsWith(SSH_ERROR_PREFIX)) {
      return {
        overall_status: "UNKNOWN",
        storage_type: "UNKNOWN",
        components: { smart: { status: "UNKNOWN", disks: [], disks_total: 0, disks_warning: 0, disks_failed: 0 }, meta: { hostname: "" } },
        monitoring_error: hostname.slice(SSH_ERROR_PREFIX.length),
      };
    }

    if (!hostname) {
      return {
        overall_status: "UNKNOWN",
        storage_type: "UNKNOWN",
        components: { smart: { status: "UNKNOWN", disks: [], disks_total: 0, disks_warning: 0, disks_failed: 0 }, meta: { hostname: "" } },
        monitoring_error: "SSH_TIMEOUT",
      };
    }

    // Phase 2: Parse discovery results
    const zfs = parseZpoolList(zpoolRaw);
    const mdadm = parseMdstat(mdstatRaw);
    const lsblkDisks = parseLsblkJson(lsblkRaw);
    const raidController = detectRaidController(lspciRaw);
    const hasModelRaid = inferRaidFromModels(lsblkDisks);
    const hasHwRaid = raidController !== null || hasModelRaid;

    // Phase 3: Get storcli/megacli data if available
    let storcliRaw = "";
    const raidCliPath = storcliPath || megacliPath;
    if (raidCliPath) {
      if (storcliPath) {
        storcliRaw = await ssh(input, `${storcliPath} /c0/vall show J 2>/dev/null || ${storcliPath} /c0/vall show 2>/dev/null || true`);
      } else if (megacliPath) {
        storcliRaw = await ssh(input, `${megacliPath} -LDInfo -Lall -aALL 2>/dev/null || true`);
      }
    }

    const raidVDs = hasHwRaid ? buildRaidVirtualDisks(storcliRaw, lsblkDisks, raidController) : [];

    // Phase 4: SMART data — probe each disk
    const smartDisks: SmartDisk[] = [];
    const diskNames: string[] = [];

    if (smartScanRaw) {
      // smartctl --scan output: /dev/sda -d ... # comment
      const scanLines = smartScanRaw.split("\n").filter(Boolean);
      for (const line of scanLines) {
        const match = line.match(/^\/dev\/(\S+)/);
        if (match) {
          const devName = match[1];
          // Filter out non-disk devices (USB bus, etc.)
          if (devName.startsWith("bus/") || devName.startsWith("usb")) continue;
          diskNames.push(devName);
        }
      }
    }

    // Fallback: use lsblk disk list if smartctl --scan didn't find real disks
    if (diskNames.length === 0) {
      for (const d of lsblkDisks) {
        diskNames.push(d.name);
      }
    }

    // Run smartctl on each disk (parallel SSH calls)
    if (diskNames.length > 0) {
      const smartResults = await Promise.all(
        diskNames.map(name =>
          ssh(input, `smartctl -a /dev/${name} 2>/dev/null || true`).then(raw => ({ name, raw }))
        )
      );

      for (const { name, raw } of smartResults) {
        const lsblkInfo = lsblkDisks.find(d => d.name === name || `/dev/${d.name}` === name);

        if (raw) {
          const parsed = parseSmartctl(raw, name);
          if (parsed) {
            // Fill in model/size from lsblk if smartctl couldn't get them (common behind RAID controllers)
            if (!parsed.model && lsblkInfo) parsed.model = lsblkInfo.model;
            if (!parsed.size && lsblkInfo) parsed.size = lsblkInfo.size;
            if (!parsed.model) parsed.model = "Unknown";
            smartDisks.push(parsed);
            continue;
          }
        }
        // Fallback: use lsblk info if smartctl didn't produce useful output
        smartDisks.push({
          name: `/dev/${name}`,
          model: lsblkInfo?.model || "Unknown",
          status: "OK",
          temperature: null,
          reallocated: 0,
          pending: 0,
          size: lsblkInfo?.size || null,
        });
      }
    }

    const disks_warning = smartDisks.filter(d => d.status === "WARN").length;
    const disks_failed = smartDisks.filter(d => d.status === "CRIT").length;
    let smartStatus = "OK";
    if (disks_failed > 0) smartStatus = "CRIT";
    else if (disks_warning > 0) smartStatus = "WARN";
    else if (smartDisks.length === 0) smartStatus = "UNKNOWN";

    // Phase 5: Build components
    const components: ProxmoxCheckResult["components"] = {
      smart: {
        status: smartStatus,
        disks: smartDisks,
        disks_total: smartDisks.length,
        disks_warning,
        disks_failed,
      },
      meta: { hostname },
    };

    // Only include sections that are actually detected
    if (zfs.pools.length > 0) {
      components.zfs = { status: zfs.status, pools: zfs.pools };
    }

    if (mdadm.arrays.length > 0) {
      components.mdadm = {
        status: mdadm.status,
        arrays: mdadm.arrays,
        arrays_degraded: mdadm.arrays_degraded,
      };
    }

    if (hasHwRaid) {
      const raidDegraded = raidVDs.filter(v => v.state === "DEGRADED").length;
      components.raid = {
        status: raidDegraded > 0 ? "WARN" : "OK",
        controller: raidController || "Hardware RAID (detected via disk model)",
        virtual_disks: raidVDs,
        virtual_disks_degraded: raidDegraded,
        predictive_failures: 0,
      };
    }

    // Phase 6: Classify storage type
    const hasZfs = zfs.pools.length > 0;
    const hasMdadm = mdadm.arrays.length > 0;
    const hasRaid = hasHwRaid;

    let storage_type: ProxmoxCheckResult["storage_type"];
    const detected = [hasZfs && "ZFS", hasMdadm && "MDADM", hasRaid && "RAID"].filter(Boolean);
    if (detected.length > 1) storage_type = "MIXED";
    else if (hasZfs) storage_type = "ZFS";
    else if (hasMdadm) storage_type = "MDADM";
    else if (hasRaid) storage_type = "RAID";
    else if (smartDisks.length > 0) storage_type = "NONE";
    else storage_type = "UNKNOWN";

    // Phase 7: Overall status
    let overall_status: ProxmoxCheckResult["overall_status"] = "OK";

    const statuses = [
      zfs.pools.length > 0 ? zfs.status : null,
      mdadm.arrays.length > 0 ? mdadm.status : null,
      hasHwRaid ? components.raid!.status : null,
      smartStatus,
    ].filter(Boolean) as string[];

    if (statuses.includes("CRIT")) overall_status = "CRIT";
    else if (statuses.includes("WARN")) overall_status = "WARN";
    else if (statuses.every(s => s === "OK")) overall_status = "OK";
    else if (statuses.every(s => s === "UNKNOWN")) overall_status = "UNKNOWN";
    else overall_status = "OK";

    return { overall_status, storage_type, components, monitoring_error: null };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "UNKNOWN_ERROR";
    return {
      overall_status: "UNKNOWN",
      storage_type: "UNKNOWN",
      components: {
        smart: { status: "UNKNOWN", disks: [], disks_total: 0, disks_warning: 0, disks_failed: 0 },
        meta: { hostname: "" },
      },
      monitoring_error: message,
    };
  }
}

export const proxmoxCollectorInternals = {
  parseZpoolList,
};
