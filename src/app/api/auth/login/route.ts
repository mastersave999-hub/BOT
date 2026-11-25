import 'server-only';

import { createServerClient } from '@supabase/ssr';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

const genericCredentialsMessage = 'ชื่อผู้ใช้/อีเมลหรือรหัสผ่านไม่ถูกต้อง';

function jsonResponse(body: { success: boolean; message: string }, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(request: NextRequest) {
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return jsonResponse({ success: false, message: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' }, 400);
  }

  const { identifier: rawIdentifier, password } = body as Record<string, unknown>;
  const identifier = typeof rawIdentifier === 'string' ? rawIdentifier.trim() : '';
  if (!identifier || identifier.length > 254 || typeof password !== 'string' || !password || password.length > 256) {
    return jsonResponse({ success: false, message: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' }, 400);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !publishableKey) {
    return jsonResponse({ success: false, message: 'ระบบบัญชียังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง' }, 503);
  }

  try {
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
    let email = isEmail ? identifier.toLowerCase() : '';
    if (!isEmail) {
      if (!serviceRoleKey) {
        return jsonResponse({ success: false, message: 'ระบบบัญชียังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง' }, 503);
      }
      const admin = createAdminClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      });
      const escapedUsername = identifier.replace(/[\\%_]/g, '\\$&');
      const { data: profile, error: profileError } = await admin
        .from('profiles')
        .select('id')
        .ilike('username', escapedUsername)
        .maybeSingle();

      if (profileError || !profile) {
        return jsonResponse({ success: false, message: genericCredentialsMessage }, 401);
      }

      const { data: authUser, error: authUserError } = await admin.auth.admin.getUserById(profile.id);
      if (authUserError || !authUser.user?.email) {
        return jsonResponse({ success: false, message: genericCredentialsMessage }, 401);
      }
      email = authUser.user.email;
    }

    const cookieStore = await cookies();
    const supabase = createServerClient(supabaseUrl, publishableKey, {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        },
      },
    });

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      if (error.status === 429) {
        return jsonResponse({ success: false, message: 'ลองเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่' }, 429);
      }
      if (error.message.toLowerCase().includes('not confirmed')) {
        return jsonResponse({ success: false, message: 'กรุณายืนยันอีเมลก่อนเข้าสู่ระบบ' }, 401);
      }
      return jsonResponse({ success: false, message: genericCredentialsMessage }, 401);
    }

    return jsonResponse({ success: true, message: 'เข้าสู่ระบบสำเร็จ!' });
  } catch {
    return jsonResponse({ success: false, message: 'ระบบบัญชีขัดข้องชั่วคราว กรุณาลองอีกครั้ง' }, 503);
  }
}
