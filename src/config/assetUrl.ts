function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

export function assetUrl(path: string): string {
  const normalizedPath = path.replace(/^\/+/, '');
  const configuredBaseUrl =
    import.meta.env.BASE_URL === '/' ? '/reef-rush/' : import.meta.env.BASE_URL;
  const baseUrl = normalizeBaseUrl(configuredBaseUrl);

  return normalizedPath.length > 0 ? `${baseUrl}${normalizedPath}` : baseUrl;
}
