import { ValidationError } from './errors.js';

/**
 * Rules about *where* a shortcut may point, as opposed to whether the URL is
 * well-formed (that lives in shortcut.ts).
 *
 * Two hazards are covered:
 *
 * - **Loops.** `go/a -> http://go/a` would bounce a browser until it gives up.
 *   Any destination whose host is one of the service's own hostnames is
 *   rejected. The server adds the request's `Host` header at runtime, so the
 *   check works whatever name the service is reached by.
 *
 * - **Private and metadata addresses.** This service never fetches a
 *   destination itself — a redirect is followed by the *user's* browser, so
 *   classic SSRF does not apply. But a shortcut is still a durable, shareable
 *   link, and letting one point at `http://169.254.169.254/` or `localhost`
 *   turns the directory into a convenient pivot for anyone who can get a
 *   teammate to click. Literal loopback, link-local, private-range and
 *   cloud-metadata addresses are refused.
 *
 *   Hostnames are *not* resolved. Internal tools point at internal hostnames
 *   by definition (`pager.internal`), so a DNS-based check would block the
 *   entire use case and would be a time-of-check/time-of-use race anyway.
 */
export interface DestinationPolicy {
  /** Hostnames (optionally with port) that the service itself answers on. */
  readonly selfHosts: ReadonlySet<string>;
  /** Permit literal private/loopback/link-local addresses. Off by default. */
  readonly allowPrivateAddresses: boolean;
}

export const DEFAULT_SELF_HOSTS: ReadonlySet<string> = new Set(['go', 'localhost', '127.0.0.1']);

export const defaultDestinationPolicy = (): DestinationPolicy => ({
  selfHosts: DEFAULT_SELF_HOSTS,
  allowPrivateAddresses: false,
});

const METADATA_HOSTS: ReadonlySet<string> = new Set([
  'metadata.google.internal',
  'metadata',
  'instance-data',
  'metadata.azure.com',
]);

/** Throws `ValidationError` on the `url` field if the destination is not allowed. */
export const assertDestinationAllowed = (url: string, policy: DestinationPolicy): void => {
  const target = new URL(url);
  const hostname = target.hostname.toLowerCase();

  if (policy.selfHosts.has(hostname) || policy.selfHosts.has(target.host.toLowerCase())) {
    reject('A shortcut cannot point back at the Go Links service itself.');
  }

  if (policy.allowPrivateAddresses) return;

  if (METADATA_HOSTS.has(hostname) || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    reject('Destinations on loopback or cloud-metadata hosts are not allowed.');
  }

  if (isPrivateAddress(hostname)) {
    reject('Destinations on private, loopback or link-local IP addresses are not allowed.');
  }
};

/** True for literal IPv4/IPv6 addresses in non-public ranges. Hostnames return false. */
export const isPrivateAddress = (hostname: string): boolean => {
  const ipv4 = parseIpv4(hostname);
  if (ipv4) return isPrivateIpv4(ipv4);

  // WHATWG URL wraps IPv6 literals in brackets.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return isPrivateIpv6(hostname.slice(1, -1));
  }
  return false;
};

const parseIpv4 = (value: string): number[] | null => {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((octet) => Number.isInteger(octet) && octet <= 255) ? octets : null;
};

const isPrivateIpv4 = ([a = 0, b = 0]: number[]): boolean =>
  a === 0 || // "this" network
  a === 10 || // private
  a === 127 || // loopback
  (a === 169 && b === 254) || // link-local, incl. cloud metadata
  (a === 172 && b >= 16 && b <= 31) || // private
  (a === 192 && b === 168) || // private
  (a === 100 && b >= 64 && b <= 127); // carrier-grade NAT

const isPrivateIpv6 = (address: string): boolean => {
  const lower = address.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true; // link-local fe80::/10
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local fc00::/7
  // IPv4-mapped addresses: the WHATWG URL parser normalises `::ffff:10.0.0.1`
  // to the hex form `::ffff:a00:1`, so both spellings are unpacked and the
  // IPv4 rules applied to the tail.
  const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1]) {
    const octets = parseIpv4(dotted[1]);
    return octets ? isPrivateIpv4(octets) : false;
  }
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex?.[1] && hex[2]) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return isPrivateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }
  return false;
};

const reject = (message: string): never => {
  throw new ValidationError('The shortcut could not be saved.', [{ field: 'url', message }]);
};
