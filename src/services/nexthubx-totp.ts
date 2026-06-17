/**
 * 客户端 TOTP(RFC 6238)本地计算:用后端随 sync 下发的 secret,在本机算 6 位码,
 * 像手机 authenticator 一样实时回显。用 Web Crypto(crypto.subtle HMAC),无第三方依赖。
 *
 * 兼容性:crypto.subtle 在 Tauri webview / 现代 WKWebView(含 Monterey)均可用;
 * 仅用 ES2017 及更早 API(padStart / ** ),不触碰旧 WebKit 不支持的 ES2023 数组方法。
 */

export interface TotpConfig {
  secret: string
  digits: number
  period: number
  algorithm: string
}

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 Base32 解码:忽略空格/连字符,大小写不敏感,容忍尾部 padding。无效 → 抛错。
 *  返回 ArrayBuffer-backed 的 Uint8Array,满足 WebCrypto 的 BufferSource 类型。 */
export function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const clean = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
  if (clean.length === 0) throw new Error('empty totp secret')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (let i = 0; i < clean.length; i++) {
    const idx = B32_ALPHABET.indexOf(clean.charAt(i))
    if (idx === -1) throw new Error('invalid base32 char')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
      value &= (1 << bits) - 1
    }
  }
  const buf = new Uint8Array(out.length)
  buf.set(out)
  return buf
}

function hashName(algorithm: string): 'SHA-1' | 'SHA-256' | 'SHA-512' {
  const a = (algorithm || 'SHA1').toUpperCase()
  if (a === 'SHA256') return 'SHA-256'
  if (a === 'SHA512') return 'SHA-512'
  return 'SHA-1'
}

/**
 * 在给定 Unix 秒计算 TOTP 码。失败(密钥非法 / 无 crypto.subtle)抛错,调用方兜底显示占位。
 */
export async function generateTotpCode(
  totp: TotpConfig,
  atUnixSeconds: number,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('crypto.subtle unavailable')
  const period = totp.period > 0 ? totp.period : 30
  const digits = totp.digits > 0 ? totp.digits : 6
  const key = base32Decode(totp.secret)

  // 8 字节 big-endian 计数器 = floor(t / period)。
  let counter = Math.floor(atUnixSeconds / period)
  const msg = new Uint8Array(8)
  for (let i = 7; i >= 0; i--) {
    msg[i] = counter & 0xff
    counter = Math.floor(counter / 256)
  }

  const cryptoKey = await subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: hashName(totp.algorithm) },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(await subtle.sign('HMAC', cryptoKey, msg))
  const offset = sig[sig.length - 1]! & 0x0f
  const bin =
    ((sig[offset]! & 0x7f) << 24) |
    ((sig[offset + 1]! & 0xff) << 16) |
    ((sig[offset + 2]! & 0xff) << 8) |
    (sig[offset + 3]! & 0xff)
  return (bin % 10 ** digits).toString().padStart(digits, '0')
}

/** 当前码还剩多少秒过期(倒计时)。 */
export function totpRemaining(atUnixSeconds: number, period: number): number {
  const p = period > 0 ? period : 30
  return p - (Math.floor(atUnixSeconds) % p)
}
