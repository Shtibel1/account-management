import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { mockClient } from '../utils/supabase/mockClient';

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY || 
            process.env.SUPABASE_SERVICE_ROLE_KEY || 
            process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const isConfigured = url && url !== 'https://placeholder-url.supabase.co' && key && key !== 'placeholder-key';

if (!isConfigured) {
  console.warn('Supabase URL or Key is missing. Database operations will use Local Mock Database.');
}

export const supabase = isConfigured
  ? createClient(url!, key!)
  : (mockClient as unknown as SupabaseClient);


