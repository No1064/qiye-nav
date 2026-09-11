import dns from "node:dns/promises";
import net from "node:net";
import { HttpError } from "./errors.js";

function ipv4ToNumber(address: string): number {
  return address
    .split(".")
    .reduce((value, octet) => (value * 256 + Number(octet)) >>> 0, 0);
}

function inV4Cidr(address: string, base: string, prefix: number): boolean {
  const bits = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToNumber(address) & bits) === (ipv4ToNumber(base) & bits);
}

const blockedV4Cidrs: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export function isPrivateOrReservedAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) {
    return blockedV4Cidrs.some(([base, prefix]) => inV4Cidr(address, base, prefix));
  }
  if (version !== 6) return true;

  const lower = address.toLowerCase().split("%")[0] ?? "";
  if (lower === "::" || lower === "::1") return true;
  // Conservatively reject all IPv4-mapped IPv6 forms. This also covers compressed
  // hexadecimal spellings such as ::ffff:7f00:1, not just dotted-quad notation.
  if (lower.startsWith("::ffff:")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true;
  }
  if (lower.startsWith("ff") || lower.startsWith("2001:db8:")) return true;

  return false;
}

export type LookupAddresses = (hostname: string) => Promise<ReadonlyArray<{ address: string }>>;

const defaultLookup: LookupAddresses = async (hostname) =>
  dns.lookup(hostname, { all: true, verbatim: true });

export async function assertPublicFetchUrl(
  url: URL,
  lookup: LookupAddresses = defaultLookup,
): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new HttpError(400, "Private network targets cannot be fetched", "ssrf_target_blocked");
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrReservedAddress(hostname)) {
      throw new HttpError(400, "Private or reserved IP targets cannot be fetched", "ssrf_target_blocked");
    }
    return;
  }

  let addresses: ReadonlyArray<{ address: string }>;
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new HttpError(422, "Target hostname could not be resolved", "metadata_dns_failed");
  }
  if (addresses.length === 0) {
    throw new HttpError(422, "Target hostname did not resolve to an address", "metadata_dns_failed");
  }
  if (addresses.some(({ address }) => isPrivateOrReservedAddress(address))) {
    throw new HttpError(400, "Target resolves to a private or reserved IP", "ssrf_target_blocked");
  }
}
