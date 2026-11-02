// Server origin (install counter + over-the-air updates), from .env: EXPO_PUBLIC_STATS_URL.
// Over-the-air updates: the app starts on what it has (never waits for the network), fetches a newer
// signed bundle in the background and runs it at the next launch. Bundles must be signed with the key
// matching certs/certificate.pem (scripts/deploy.ts); anything else is refused by the phone.
// The runtime version is a fingerprint of the native code: an update only reaches APKs it can run on.
module.exports = ({ config }) => {
  const origin = process.env.EXPO_PUBLIC_STATS_URL ?? 'https://brancard.vitrixxl.fr';
  const plugins = [...config.plugins];
  // Plain HTTP only for a local test server; production is https and keeps Android's cleartext block.
  if (origin.startsWith('http://')) plugins.push(['expo-build-properties', { android: { usesCleartextTraffic: true } }]);
  return {
    ...config,
    plugins,
    runtimeVersion: { policy: 'fingerprint' },
    updates: {
      url: `${origin}/updates/manifest`,
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 0,
      codeSigningCertificate: './certs/certificate.pem',
      codeSigningMetadata: { keyid: 'main', alg: 'rsa-v1_5-sha256' },
    },
  };
};
