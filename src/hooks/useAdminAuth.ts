import type { User } from '@supabase/supabase-js';
import { getSession } from '../lib/auth';
import { getSupabaseClient, isSupabaseConfigured } from '../lib/supabase';

export type AdminRole = 'user' | 'admin';

export type AdminProfile = {
  id: string;
  email: string | null;
  full_name: string | null;
  role: AdminRole;
  created_at: string;
};

export type AdminAuthResult = {
  loading: boolean;
  isAdmin: boolean;
  profile: AdminProfile | null;
  user: User | null;
  error: string;
  redirectTo: 'login' | 'dashboard' | null;
};

type AdminAuthOptions = {
  redirect?: boolean;
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unable to verify admin access.';
}

function redirectToAppRoot(): void {
  if (typeof window === 'undefined') return;
  window.history.replaceState({}, document.title, '/');
}

export async function useAdminAuth(options: AdminAuthOptions = {}): Promise<AdminAuthResult> {
  const shouldRedirect = Boolean(options.redirect);

  if (!isSupabaseConfigured()) {
    return {
      loading: false,
      isAdmin: false,
      profile: null,
      user: null,
      error: 'Supabase is not configured.',
      redirectTo: 'login',
    };
  }

  try {
    const session = await getSession();
    const user = session?.user || null;

    if (!user?.id) {
      if (shouldRedirect) redirectToAppRoot();
      return {
        loading: false,
        isAdmin: false,
        profile: null,
        user: null,
        error: '',
        redirectTo: 'login',
      };
    }

    const { data, error } = await getSupabaseClient()
      .from('profiles')
      .select('id,email,full_name,role,created_at')
      .eq('id', user.id)
      .maybeSingle();

    if (error) throw error;

    const profile = (data || null) as AdminProfile | null;
    const isAdmin = profile?.role === 'admin';

    if (!isAdmin && shouldRedirect) redirectToAppRoot();

    return {
      loading: false,
      isAdmin,
      profile,
      user,
      error: '',
      redirectTo: isAdmin ? null : 'dashboard',
    };
  } catch (error) {
    if (shouldRedirect) redirectToAppRoot();
    return {
      loading: false,
      isAdmin: false,
      profile: null,
      user: null,
      error: getErrorMessage(error),
      redirectTo: 'dashboard',
    };
  }
}

export async function checkIsCurrentUserAdminRole(): Promise<boolean> {
  const result = await useAdminAuth();
  return result.isAdmin;
}
