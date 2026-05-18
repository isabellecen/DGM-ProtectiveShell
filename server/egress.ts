import dns from "node:dns/promises";
import net from "node:net";
import ipaddr from "ipaddr.js";

type ParsedCidr = {
  addr: ipaddr.IPv4 | ipaddr.IPv6;
  bits: number;
};

const blockedHostnames = new Set(["metadata.google.internal"]);
const blockedCidrs = [
  parseCidr("0.0.0.0/8"),
  parseCidr("127.0.0.0/8"),
  parseCidr("169.254.0.0/16"),
  parseCidr("224.0.0.0/4"),
  parseCidr("255.255.255.255/32"),
  parseCidr("::/128"),
  parseCidr("::1/128"),
  parseCidr("fe80::/10"),
  parseCidr("ff00::/8"),
];

function parseCidr(value: string): ParsedCidr {
  const [rawAddress, rawBits] = value.trim().split("/");
  const addr = ipaddr.parse(rawAddress);
  const bits = Number(rawBits);
  if (!Number.isInteger(bits)) {
    throw new Error(`Invalid CIDR: ${value}`);
  }
  return { addr, bits };
}

function cleanHost(host: string): string {
  return host.trim().replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

function configuredAllowCidrs(): ParsedCidr[] {
  const raw = process.env.MONITORED_TARGET_ALLOW_CIDRS;
  if (!raw?.trim()) {
    return [];
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseCidr);
}

function comparableAddress(address: string): ipaddr.IPv4 | ipaddr.IPv6 {
  const parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6") {
    const ipv6 = parsed as ipaddr.IPv6;
    if (ipv6.isIPv4MappedAddress()) {
      return ipv6.toIPv4Address();
    }
  }
  return parsed;
}

function matchesCidr(address: string, cidr: ParsedCidr): boolean {
  const parsed = comparableAddress(address);
  if (parsed.kind() !== cidr.addr.kind()) {
    return false;
  }
  return parsed.match(cidr.addr, cidr.bits);
}

export function isBlockedTargetAddress(address: string): boolean {
  return blockedCidrs.some((cidr) => matchesCidr(address, cidr));
}

export function isAllowedByConfiguredCidrs(address: string): boolean {
  const allowCidrs = configuredAllowCidrs();
  return allowCidrs.length === 0 || allowCidrs.some((cidr) => matchesCidr(address, cidr));
}

export async function resolveTargetAddresses(host: string): Promise<string[]> {
  const normalized = cleanHost(host);
  if (!normalized) {
    throw new Error("Target host is required");
  }

  if (blockedHostnames.has(normalized)) {
    return [normalized];
  }

  if (net.isIP(normalized)) {
    return [normalized];
  }

  const results = await dns.lookup(normalized, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

export async function assertMonitoredTargetAllowed(host: string): Promise<string[]> {
  const normalized = cleanHost(host);
  if (blockedHostnames.has(normalized)) {
    throw new Error(`Target host ${host} is blocked`);
  }

  const addresses = await resolveTargetAddresses(host);
  if (addresses.length === 0) {
    throw new Error(`Target host ${host} did not resolve`);
  }

  for (const address of addresses) {
    if (blockedHostnames.has(address) || isBlockedTargetAddress(address)) {
      throw new Error(`Target host ${host} resolves to blocked address ${address}`);
    }
    if (!isAllowedByConfiguredCidrs(address)) {
      throw new Error(`Target host ${host} resolves outside MONITORED_TARGET_ALLOW_CIDRS`);
    }
  }

  return addresses;
}

export const egressInternals = {
  cleanHost,
  parseCidr,
  matchesCidr,
  comparableAddress,
};
