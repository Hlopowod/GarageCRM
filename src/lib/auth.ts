import { invoke } from './platform';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import {
  getAuthRedirectTo,
  getPasswordResetRedirectTo,
  getSupabaseClient,
  isSupabaseConfigured,
} from './supabase';

type CloudAccountStatus = {
  configured: boolean;
  account_email: string;
  user_id: string;
  last_synced_at: string;
};

type StoredSupabaseAuthSession = {
  account_email: string;
  user_id: string;
  access_token: string;
  refresh_token: string;
};

type AuthResult = {
  status: CloudAccountStatus | null;
  session: Session | null;
  signedIn: boolean;
  requiresEmailConfirmation: boolean;
  message: string;
};

type AuthStateCallback = (
  event: AuthChangeEvent,
  session: Session | null
) => void | Promise<void>;

type AuthCallbackResult = 'recovery' | 'authenticated' | null;

let suppressSessionPersistence = false;

function mapAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || 'Authentication failed.');
  const lower = message.toLowerCase();

  if (lower.includes('email not confirmed')) {
    return 'Confirm the email from the letter first, then log in.';
  }
  if (lower.includes('invalid login credentials')) {
    return 'Wrong email or password, or the email is not confirmed yet.';
  }
  if (lower.includes('user already registered') || lower.includes('already registered')) {
    return 'This email already exists. Use Login instead.';
  }
  if (lower.includes('signup is disabled') || lower.includes('signups not allowed')) {
    return 'Account creation is currently disabled.';
  }
  if (lower.includes('email rate limit') || lower.includes('too many requests')) {
    return 'Too many email requests. Wait a little and try again.';
  }
  if (lower.includes('otp') || lower.includes('token')) {
    return 'The verification code is invalid or has expired. Use the newest code from your email.';
  }
  if (lower.includes('password should be at least') || lower.includes('weak password')) {
    return 'Password is too weak. Use at least 8 characters.';
  }
  if (lower.includes('redirect') && lower.includes('not allowed')) {
    return 'Password reset redirect is not allowed yet. Add garagecrm://auth/callback to Supabase Auth Redirect URLs.';
  }

  return message;
}

async function saveBackendSession(session: Session): Promise<CloudAccountStatus> {
  return invoke<CloudAccountStatus>('save_supabase_auth_session', {
    session: {
      accountEmail: session.user.email || '',
      userId: session.user.id,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt: session.expires_at || 0,
      expiresIn: session.expires_in || 0,
    },
  });
}

async function clearBackendSession(): Promise<CloudAccountStatus> {
  return invoke<CloudAccountStatus>('clear_supabase_auth_session');
}

async function restoreBackendSession(): Promise<Session | null> {
  const stored = await invoke<StoredSupabaseAuthSession | null>('get_supabase_auth_session');
  if (!stored?.access_token || !stored.refresh_token) return null;

  const client = getSupabaseClient();
  const { data, error } = await client.auth.setSession({
    access_token: stored.access_token,
    refresh_token: stored.refresh_token,
  });

  if (error) {
    throw new Error(mapAuthError(error));
  }

  if (data.session) {
    await saveBackendSession(data.session);
  }

  return data.session;
}

export function isAuthConfigured(): boolean {
  return isSupabaseConfigured();
}

export async function persistAuthSession(session: Session | null): Promise<CloudAccountStatus | null> {
  if (!session) return clearBackendSession();
  return saveBackendSession(session);
}

export async function signUp(
  email: string,
  password: string,
  garageName?: string
): Promise<AuthResult> {
  const client = getSupabaseClient();
  const redirectTo = getAuthRedirectTo();
  const profileData: Record<string, string> = { app: 'garage-crm' };
  const cleanGarageName = (garageName || '').trim();

  if (cleanGarageName) {
    profileData.garage_name = cleanGarageName;
  }

  const { data, error } = await client.auth.signUp({
    email: email.trim(),
    password,
    options: {
      data: profileData,
      ...(redirectTo ? { emailRedirectTo: redirectTo } : {}),
    },
  });

  if (error) {
    throw new Error(mapAuthError(error));
  }

  if (data.session) {
    await client.auth.signOut();
    await clearBackendSession();
    return {
      status: null,
      session: null,
      signedIn: false,
      requiresEmailConfirmation: true,
      message: 'Check your email to verify your account.',
    };
  }

  await clearBackendSession();
  return {
    status: null,
    session: null,
    signedIn: false,
    requiresEmailConfirmation: true,
    message: 'Check your email to verify your account.',
  };
}

export async function signIn(email: string, password: string): Promise<AuthResult> {
  const client = getSupabaseClient();
  const { data, error } = await client.auth.signInWithPassword({
    email: email.trim(),
    password,
  });

  if (error) {
    throw new Error(mapAuthError(error));
  }
  if (!data.session) {
    throw new Error('Confirm the email from the letter first, then log in.');
  }

  const status = await saveBackendSession(data.session);
  return {
    status,
    session: data.session,
    signedIn: true,
    requiresEmailConfirmation: false,
    message: 'Logged in successfully.',
  };
}

export async function verifyEmailCode(email: string, code: string): Promise<AuthResult> {
  const client = getSupabaseClient();
  suppressSessionPersistence = true;
  try {
    const { data, error } = await client.auth.verifyOtp({
      email: email.trim(),
      token: code.trim(),
      type: 'email',
    });

    if (error) {
      throw new Error(mapAuthError(error));
    }

    if (data.session) {
      await client.auth.signOut();
    }
    await clearBackendSession();
    await new Promise(resolve => setTimeout(resolve, 100));

    return {
      status: null,
      session: null,
      signedIn: false,
      requiresEmailConfirmation: false,
      message: 'Email verified. You can now log in with your email and password.',
    };
  } finally {
    suppressSessionPersistence = false;
  }
}

export async function resendSignUpCode(email: string): Promise<void> {
  const redirectTo = getAuthRedirectTo();
  const { error } = await getSupabaseClient().auth.resend({
    type: 'signup',
    email: email.trim(),
    options: {
      ...(redirectTo ? { emailRedirectTo: redirectTo } : {}),
    },
  });

  if (error) {
    throw new Error(mapAuthError(error));
  }
}

export async function signOut(): Promise<void> {
  if (isSupabaseConfigured()) {
    const { error } = await getSupabaseClient().auth.signOut();
    if (error) {
      throw new Error(mapAuthError(error));
    }
  }

  await clearBackendSession();
}

export async function getSession(): Promise<Session | null> {
  if (!isSupabaseConfigured()) return null;

  const client = getSupabaseClient();
  const { data, error } = await client.auth.getSession();
  if (error) {
    throw new Error(mapAuthError(error));
  }
  if (data.session) {
    await saveBackendSession(data.session);
    return data.session;
  }

  return restoreBackendSession();
}

export function onAuthStateChange(callback?: AuthStateCallback): { unsubscribe: () => void } {
  if (!isSupabaseConfigured()) {
    return { unsubscribe() {} };
  }

  const { data } = getSupabaseClient().auth.onAuthStateChange((event, session) => {
    void (async () => {
      try {
        if (session && !suppressSessionPersistence) {
          await saveBackendSession(session);
        } else if (event === 'SIGNED_OUT') {
          await clearBackendSession();
        }
      } catch (error) {
        console.warn('Unable to sync Supabase auth session with Tauri backend', error);
      }

      try {
        await callback?.(event, session);
      } catch (error) {
        console.warn('Supabase auth state callback failed', error);
      }
    })();
  });

  return data.subscription;
}

export async function resetPassword(email: string): Promise<void> {
  const redirectTo = getPasswordResetRedirectTo();
  const { error } = await getSupabaseClient().auth.resetPasswordForEmail(email.trim(), {
    ...(redirectTo ? { redirectTo } : {}),
  });

  if (error) {
    throw new Error(mapAuthError(error));
  }
}

function getCallbackParams(callbackUrl: string): URLSearchParams {
  const url = new URL(callbackUrl);
  const params = new URLSearchParams(url.search);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));

  hash.forEach((value, key) => {
    if (!params.has(key)) {
      params.set(key, value);
    }
  });

  return params;
}

export async function handleAuthCallbackUrl(callbackUrl: string): Promise<AuthCallbackResult> {
  if (!callbackUrl || !isSupabaseConfigured()) return null;

  let params: URLSearchParams;
  try {
    params = getCallbackParams(callbackUrl);
  } catch {
    return null;
  }

  const callbackType = (params.get('type') || '').toLowerCase();
  const callbackError = params.get('error_description') || params.get('error') || '';
  const isRecoveryUrl =
    callbackType === 'recovery' ||
    callbackUrl.toLowerCase().startsWith('garagecrm://auth/callback');

  if (callbackError) {
    throw new Error(mapAuthError(callbackError));
  }

  const accessToken = params.get('access_token') || '';
  const refreshToken = params.get('refresh_token') || '';
  const code = params.get('code') || '';
  const client = getSupabaseClient();
  suppressSessionPersistence = true;
  try {
    if (accessToken && refreshToken) {
      const { error } = await client.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      if (error) {
        throw new Error(mapAuthError(error));
      }
      return isRecoveryUrl ? 'recovery' : 'authenticated';
    }

    if (code) {
      const { error } = await client.auth.exchangeCodeForSession(code);
      if (error) {
        throw new Error(mapAuthError(error));
      }
      return isRecoveryUrl ? 'recovery' : 'authenticated';
    }
  } finally {
    suppressSessionPersistence = false;
  }

  return null;
}

export async function completePasswordReset(newPassword: string): Promise<void> {
  const client = getSupabaseClient();
  suppressSessionPersistence = true;
  try {
    const { error } = await client.auth.updateUser({ password: newPassword });
    if (error) {
      throw new Error(mapAuthError(error));
    }

    await client.auth.signOut();
    await clearBackendSession();
  } finally {
    suppressSessionPersistence = false;
  }
}

export function isAuthCallbackRoute(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.pathname.replace(/\/+$/, '') === '/auth/callback';
}

export function getAuthCallbackError(): string {
  if (typeof window === 'undefined') return '';

  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const errorCode = query.get('error_code') || hash.get('error_code') || '';
  const description = query.get('error_description') || hash.get('error_description') || '';

  if (errorCode === 'otp_expired') {
    return 'Email verification link is invalid or has expired. Register again or request a fresh email, then click the newest link.';
  }
  if (description) return description;

  return query.get('error') || hash.get('error') || '';
}

export function clearAuthCallbackUrl(): void {
  if (!isAuthCallbackRoute()) return;
  window.history.replaceState({}, document.title, '/');
}
