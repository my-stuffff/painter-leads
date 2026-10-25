import { isIP } from 'node:net';

function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null;
}

function isPublicIPv4(ip: string): boolean {
  const o = ipv4Octets(ip);
  if (!o) return false;
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0) return false; // "this" network, 0.0.0.0
  if (a === 10) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false; // documentation
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // documentation
  if (a === 203 && b === 0 && c === 113) return false; // documentation
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Expands an IPv6 literal to 8 hextets (numbers), or null when malformed. */
function ipv6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  // Embedded IPv4 tail (::ffff:1.2.3.4) becomes two hextets.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const o = ipv4Octets(tail);
    if (!o) return null;
    const hi = ((o[0] as number) << 8) | (o[1] as number);
    const lo = ((o[2] as number) << 8) | (o[3] as number);
    s = `${s.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (!head || !rest) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

function isPublicIPv6(ip: string): boolean {
  const h = ipv6Hextets(ip);
  if (!h) return false;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = h as [number, number, number, number, number, number, number, number];
  const allZeroUpTo = (n: number) => h.slice(0, n).every((x) => x === 0);

  if (allZeroUpTo(7) && (h7 === 0 || h7 === 1)) return false; // :: and ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the embedded IPv4.
  if (allZeroUpTo(5) && (h5 === 0xffff || h5 === 0)) {
    return isPublicIPv4(`${h6 >> 8}.${h6 & 255}.${h7 >> 8}.${h7 & 255}`);
  }
  // NAT64 64:ff9b::/96 embeds an IPv4 address.
  if (h0 === 0x64 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    return isPublicIPv4(`${h6 >> 8}.${h6 & 255}.${h7 >> 8}.${h7 & 255}`);
  }
  if ((h0 & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((h0 & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((h0 & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (h0 === 0x2001 && h1 === 0x0db8) return false; // documentation
  if (h0 === 0x2002) {
    // 6to4 embeds an IPv4 address in the next 32 bits.
    return isPublicIPv4(`${h1 >> 8}.${h1 & 255}.${h2 >> 8}.${h2 & 255}`);
  }
  return true;
}

/**
 * True only for addresses on the public internet. Everything else (loopback, private, link-local
 * incl. 169.254.169.254, CGNAT, multicast, reserved, malformed) is refused (Security V13).
 */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPublicIPv4(ip);
  if (kind === 6) return isPublicIPv6(ip);
  return false;
}
