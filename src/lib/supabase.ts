import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL || '').trim();
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();

export const supabaseConfig = Object.freeze({
  url: supabaseUrl,
  anonKey: supabaseAnonKey,
  configured: Boolean(supabaseUrl && supabaseAnonKey),
});

export const supabase: SupabaseClient | null = supabaseConfig.configured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
        flowType: 'pkce',
      },
    })
  : null;

export function isSupabaseConfigured(): boolean {
  return supabaseConfig.configured;
}

export function getSupabaseClient(): SupabaseClient {
  if (!supabase) {
    throw new Error('Account login is not available yet. Contact support.');
  }
  return supabase;
}

export function getAuthRedirectTo(): string | undefined {
  if (typeof window === 'undefined') return undefined;

  const configuredRedirect = (import.meta.env.VITE_AUTH_REDIRECT_URL || '').trim();
  if (configuredRedirect) return configuredRedirect;

  // Without an app-specific redirect Supabase confirms the email, then uses the
  // project Site URL from Authentication -> URL Configuration.
  // Password recovery uses its own app deep link below.
  return undefined;
}

export function getPasswordResetRedirectTo(): string | undefined {
  if (typeof window === 'undefined') return undefined;

  const configuredRedirect = (import.meta.env.VITE_PASSWORD_RESET_REDIRECT_URL || '').trim();
  if (configuredRedirect) return configuredRedirect;

  if (!(window as any).__TAURI_INTERNALS__) {
    return `${window.location.origin}${window.location.pathname}`;
  }

  return 'garagecrm://auth/callback';
}
