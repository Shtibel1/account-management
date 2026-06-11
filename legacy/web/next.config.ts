import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@invoice/shared-types'],
  experimental: {
    serverComponentsExternalPackages: ['sharp'],
  },
};

export default nextConfig;
