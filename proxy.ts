import { NextRequest, NextResponse } from 'next/server'

const RATE_LIMIT_COOKIE_NAME = 'aura_rl_id'

/**
 * Per-request CSP nonce for the App Router's framework and inline bootstrap
 * scripts. Page rendering is dynamic because the nonce must match the header.
 * Inline React style attributes remain allowed explicitly via style-src-attr;
 * style blocks and scripts still require the nonce.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const isDevelopment = process.env.NODE_ENV !== 'production'
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDevelopment ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    "connect-src 'self' https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', csp)

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  })
  response.headers.set('Content-Security-Policy', csp)
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  const isSecureRequest = request.nextUrl.protocol === 'https:' || forwardedProto === 'https'
  if (!request.cookies.get(RATE_LIMIT_COOKIE_NAME)?.value) {
    response.cookies.set({
      name: RATE_LIMIT_COOKIE_NAME,
      value: crypto.randomUUID(),
      httpOnly: true,
      sameSite: 'lax',
      // A production build can still be run locally over HTTP for jury/demo
      // checks. Secure must describe the actual request, not NODE_ENV alone.
      secure: isSecureRequest,
      maxAge: 24 * 60 * 60,
      path: '/',
    })
  }
  return response
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
