import type { NextConfig } from 'next';

console.log('--------------------------------------------------');
console.log('Build Environment Diagnostic:');
console.log('NEXT_PUBLIC_SUPABASE_URL:', process.env.NEXT_PUBLIC_SUPABASE_URL ? 'Configured' : 'NOT CONFIGURED');
console.log('NEXT_PUBLIC_SUPABASE_ANON_KEY:', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? 'Configured' : 'NOT CONFIGURED');
console.log('SUPABASE_SERVICE_KEY:', process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY ? 'Configured' : 'NOT CONFIGURED');
console.log('GOOGLE_CLOUD_API_KEY:', process.env.GOOGLE_CLOUD_API_KEY || process.env.GOOGLE_API_KEY ? 'Configured' : 'NOT CONFIGURED');
console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'Configured' : 'NOT CONFIGURED');
console.log('--------------------------------------------------');

const nextConfig: NextConfig = {
  serverExternalPackages: ['sharp'],
};

export default nextConfig;
