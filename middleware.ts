import { NextResponse, type NextRequest } from 'next/server';

function jsonError(status: number, message: string) {
  return NextResponse.json(
    {
      success: false,
      errorCode: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
      error: message,
    },
    {
      status,
      headers: {
        // Avoid caching auth failures at the edge/CDN.
        'Cache-Control': 'no-store, max-age=0',
      },
    },
  );
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length != b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function requireBearer(req: NextRequest) {
  const expected = (process.env.STUDY_API_BEARER_TOKEN || '').trim();

  // Dev-friendly: if unset, do not enforce.
  if (!expected) return null;

  const auth = (req.headers.get('authorization') || '').trim();
  if (!auth.toLowerCase().startsWith('bearer ')) {
    return jsonError(401, 'Missing bearer token');
  }

  const provided = auth.slice(7).trim();
  if (!provided || !timingSafeEqualString(provided, expected)) {
    return jsonError(403, 'Invalid bearer token');
  }

  return null;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Policy: only expose /api/* publicly. UI/root should not be reachable.
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    const authError = requireBearer(req);
    if (authError) return authError;
    return NextResponse.next();
  }

  // Everything else is a hard 404.
  return new NextResponse('Not Found', {
    status: 404,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|apple-icon.png).*)'],
};
