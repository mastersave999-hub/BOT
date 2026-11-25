/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'cdn.bottcg.com',
        pathname: '/**',
      },
    ],
  },
};

export default nextConfig;
