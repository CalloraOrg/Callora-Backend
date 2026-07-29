## Security headers configuration

This service uses `helmet` as an Express middleware to apply common security headers.

### Enabled headers

- **X-Content-Type-Options**
  - Value: `nosniff`
  - Purpose: prevents MIME type sniffing.
  - Config: provided by Helmet defaults.

- **X-Frame-Options**
  - Value: `DENY`
  - Purpose: Prevents clickjacking attacks by disallowing the page to be displayed in an iframe.
  - Config: Aligned with production security standards defined in `SECURITY_HEADERS_CONFIGURATION.md`.

- **Strict-Transport-Security (HSTS)**
  - Only enabled when `NODE_ENV === 'production'`.
  - Config:
    - `maxAge`: 31536000 seconds (1 year)
    - `includeSubDomains`: `true`
    - `preload`: `true`
  - When not in production, HSTS is disabled to avoid issues during local development or when running over plain HTTP.

- **Other default Helmet headers**
  - The default Helmet protections (e.g. `X-DNS-Prefetch-Control`, `X-Download-Options`, `X-XSS-Protection` / modern equivalents) remain enabled.

### Disabled features

- **X-Powered-By**
  - Hidden in production to avoid disclosing technology stack information.

### Content Security Policy (CSP)

- **CSP** is configured with strict defaults (e.g., `default-src 'self'`) as defined in `SECURITY_HEADERS_CONFIGURATION.md`. While the API primarily serves JSON, this provides defense-in-depth against accidental HTML rendering or cross-site script injection.
