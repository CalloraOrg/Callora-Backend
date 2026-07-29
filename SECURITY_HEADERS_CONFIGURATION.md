# Security Headers and CORS Configuration

This document outlines the production-safe security headers and CORS configuration implemented for the Callora Backend.

## Overview

The application implements comprehensive security headers and CORS policies that adapt based on the environment (development vs production) to provide both security and developer ergonomics.

## Security Headers (Helmet)

### Content Security Policy (CSP)

**Production:**
```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
connect-src 'self';
font-src 'self';
object-src 'none';
media-src 'self';
frame-src 'none';
```

**Development:**
- Same as production but allows `'unsafe-inline'` for styles to support hot reload
- Includes `ws:` and `wss:` in `connect-src` for WebSocket connections

### HTTP Strict Transport Security (HSTS)

**Production:**
- `max-age=31536000` (1 year)
- `includeSubDomains`
- `preload`

**Development:**
- Disabled (no HSTS header)

### Other Security Headers

- **X-Frame-Options:** `DENY`
- **X-Content-Type-Options:** `nosniff`
- **Referrer-Policy:** `strict-origin-when-cross-origin`
- **Cross-Origin Embedder Policy:** `require-corp` (production only)
- **X-Powered-By:** Hidden in production

## CORS Configuration

### Environment-Based Behavior

**Production:**
- Strict origin validation against `CORS_ALLOWED_ORIGINS`
- Logs blocked attempts for security monitoring
- Preflight cache: 10 minutes (`max-age=600`)
- Warning if no origins configured

**Development:**
- Allows any `localhost:*` origin for ergonomics
- Preflight cache: 24 hours (`max-age=86400`)
- More permissive for local development

### Allowed Headers

```
Content-Type
Authorization
x-admin-api-key
x-user-id
x-request-id
```

### Allowed Methods

```
GET, POST, PATCH, DELETE, OPTIONS
```

### Credentials

- Enabled (`credentials: true`) for authenticated requests

## Environment Variables

### Required for Production

```bash
NODE_ENV=production
CORS_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
```

### Development Defaults

```bash
NODE_ENV=development
CORS_ALLOWED_ORIGINS=http://localhost:5173
```

## Security Considerations

### Production Deployment

1. **HTTPS Required:** HSTS is only enabled in production with HTTPS
2. **Origin Allowlisting:** Only explicitly configured origins are allowed
3. **Monitoring:** Blocked CORS attempts are logged
4. **Cache Duration:** Shorter preflight cache for security
5. **Information Disclosure:** Server information headers are hidden

### Development Ergonomics

1. **Localhost Support:** Any localhost port is allowed
2. **Relaxed CSP:** Allows inline styles for development tools
3. **Longer Cache:** Reduces preflight requests during development
4. **WebSocket Support:** Allows WebSocket connections for hot reload

## Testing

### Unit Tests
- Location: `src/__tests__/security-headers.test.ts`
- Covers header presence and content validation
- Tests environment-specific behavior
- Validates CORS origin handling

### Integration Tests
- Location: `tests/integration/security-headers.integration.test.ts`
- Tests real HTTP requests with security headers
- Validates production vs development behavior
- Performance and reliability testing

## Migration Guide

### For Existing Deployments

1. Set `NODE_ENV=production` in production
2. Configure `CORS_ALLOWED_ORIGINS` with your frontend domains
3. Ensure HTTPS is enabled for HSTS to work
4. Monitor logs for blocked CORS attempts

### For Local Development

1. Set `NODE_ENV=development` (or don't set, defaults to development)
2. No additional configuration needed for localhost
3. Existing `CORS_ALLOWED_ORIGINS` will still work

## Security Headers Summary

| Header | Production | Development | Purpose |
|---------|-------------|--------------|---------|
| Content-Security-Policy | Strict | Relaxed | Prevent XSS, data injection |
| Strict-Transport-Security | Enabled | Disabled | Enforce HTTPS |
| X-Frame-Options | DENY | DENY | Prevent clickjacking |
| X-Content-Type-Options | nosniff | nosniff | Prevent MIME sniffing |
| Referrer-Policy | strict-origin-when-cross-origin | strict-origin-when-cross-origin | Control referrer leakage |
| Cross-Origin-Embedder-Policy | require-corp | disabled | Control cross-origin embedding |
| X-Powered-By | hidden | visible | Prevent information disclosure |

## CORS Headers Summary

| Setting | Production | Development |
|---------|-------------|--------------|
| Origin Validation | Strict (allowlist) | Permissive (localhost + allowlist) |
| Max-Age | 600s (10 min) | 86400s (24 hours) |
| Credentials | Enabled | Enabled |
| Logging | Blocked attempts logged | No logging |

## Recommended Production Configuration

```bash
# Environment variables
NODE_ENV=production
CORS_ALLOWED_ORIGINS=https://yourapp.com,https://admin.yourapp.com

# Nginx/Apache proxy configuration (if applicable)
# Ensure these headers are passed through:
# - X-Forwarded-Proto
# - X-Forwarded-Host
# - X-Forwarded-For
```

## Monitoring and Alerts

### Production Monitoring

1. **CORS Blocks:** Monitor console logs for "CORS blocked origin" messages
2. **HSTS Compliance:** Ensure your domain is in HSTS preload lists if needed
3. **CSP Violations:** Monitor browser console for CSP violations
4. **Security Headers:** Use tools like securityheaders.com to validate configuration

### Alert Thresholds

- Multiple CORS blocks from same origin may indicate attack attempts
- Unexpected origins in logs may require allowlist updates
- Missing security headers may indicate configuration issues

## Troubleshooting

### Common Issues

1. **CORS Errors in Production**
   - Verify `CORS_ALLOWED_ORIGINS` is set correctly
   - Check that origins include protocol (https://)
   - Ensure no trailing slashes in origins

2. **HSTS Not Working**
   - Verify `NODE_ENV=production`
   - Ensure site is served over HTTPS
   - Check that HSTS header is present in responses

3. **CSP Violations**
   - Check browser console for CSP errors
   - Update CSP directives if legitimate resources are blocked
   - Consider nonce-based CSP for dynamic content

4. **Development Issues**
   - Set `NODE_ENV=development` for relaxed policies
   - Ensure localhost origins are used for local development
   - Check that WebSocket connections are allowed

## Security Best Practices

1. **Regular Reviews:** Periodically review and update allowlists
2. **Monitoring:** Set up alerts for security events
3. **Testing:** Test configuration in staging before production
4. **Documentation:** Keep this documentation updated with changes
5. **Compliance:** Ensure compliance with organizational security policies

## Dependencies

- `helmet: ^8.1.0` - Security header middleware
- `cors: ^2.8.6` - CORS middleware
- `express: ^4.18.2` - Web framework

## Version History

- **v1.0.0** - Initial implementation with production-safe defaults
- Environment-based configuration
- Comprehensive CSP and HSTS support
- Enhanced CORS with logging and validation
