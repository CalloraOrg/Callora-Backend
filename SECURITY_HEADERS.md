## Security headers configuration

This service uses `helmet` as an Express middleware to apply common security headers.

### Enabled headers

- **X-Content-Type-Options**
  - Value: `nosniff`
  - Purpose: prevents MIME type sniffing.
  - Config: provided by Helmet defaults.

- **X-Frame-Options**
  - **Disabled on purpose** for this API.
  - Reason: the backend may be called from a frontend that is embedded in an iframe (e.g. in other dashboards). Sending `DENY` or `SAMEORIGIN` from the API is unnecessary for JSON responses and can interfere with those use cases.

- **Strict-Transport-Security (HSTS)**
  - Only enabled when `NODE_ENV === 'production'`.
  - Config:
    - `maxAge`: 15552000 seconds (180 days)
    - `includeSubDomains`: `false`
    - `preload`: `false`
  - When not in production, HSTS is disabled to avoid issues during local development or when running over plain HTTP.

- **Other default Helmet headers**
  - The default Helmet protections (e.g. `X-DNS-Prefetch-Control`, `X-Download-Options`, `X-XSS-Protection` / modern equivalents) remain enabled.

### Disabled features

- **Content-Security-Policy (CSP)**
  - Disabled (`contentSecurityPolicy: false`) because this backend is a pure JSON API and does not render HTML. A CSP is typically only useful for mitigating script injection in HTML responses.

