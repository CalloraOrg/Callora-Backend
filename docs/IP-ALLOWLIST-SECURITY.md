# IP Allowlist Security Configuration

This document describes the IP allowlist security implementation for admin and gateway endpoints in the Callora Backend.

## Overview

The IP allowlist middleware provides network-level access control for sensitive endpoints, adding an additional layer of security beyond authentication mechanisms.

### Protected Endpoints

- **Admin endpoints** (`/api/admin/*`): Administrative operations requiring elevated privileges
- **Gateway endpoints** (`/api/gateway/*`): API proxy functionality that processes external requests

## Configuration

### Environment Variables

#### Admin IP Allowlist
```bash
# Comma-separated list of allowed IP ranges in CIDR notation
ADMIN_IP_ALLOWED_RANGES=192.168.1.0/24,10.0.0.1,203.0.113.0/24

# Enable/disable admin IP allowlist (default: true)
ADMIN_IP_ALLOWLIST_ENABLED=true

# Trust proxy headers for IP resolution (default: false)
TRUST_PROXY_HEADERS=true
```

#### Gateway IP Allowlist
```bash
# Comma-separated list of allowed IP ranges in CIDR notation
GATEWAY_IP_ALLOWED_RANGES=203.0.113.0/24,198.51.100.0/24

# Enable/disable gateway IP allowlist (default: true)
GATEWAY_IP_ALLOWLIST_ENABLED=true

# Trust proxy headers for IP resolution (default: false)
TRUST_PROXY_HEADERS=true
```

## Trusted Proxy Headers Configuration

When `TRUST_PROXY_HEADERS=true`, the middleware will extract the client IP from the following headers in order of priority:

### Standard Headers
1. **X-Forwarded-For** - RFC 7239 standard header, most reliable
2. **X-Real-IP** - Commonly used by Nginx
3. **X-Client-IP** - Used by Apache and some proxies
4. **X-Forwarded** - Non-standard but encountered in the wild

### Cloud Provider Headers
5. **X-Cluster-Client-IP** - Load balancer environments
6. **CF-Connecting-IP** - Cloudflare
7. **X-AWS-Client-IP** - AWS Application Load Balancer

### Security Considerations

#### Proxy Header Trust
- **Only enable `TRUST_PROXY_HEADERS=true`** when you control the entire proxy chain
- Ensure your reverse proxy (nginx, Apache, ALB, etc.) properly validates and sanitizes headers
- Configure your proxy to overwrite/set these headers rather than append to prevent spoofing

#### Header Processing Order
- Headers are checked in priority order (most reliable first)
- The first valid IP found is used
- Invalid IP formats are rejected with HTTP 400
- Empty or malformed headers are ignored safely

#### IP Spoofing Prevention
- When `trustProxy=false`, only direct connection IPs are considered
- When `trustProxy=true`, proxy headers are validated before use
- Multiple IPs in `X-Forwarded-For` are handled by using the first (original client) IP
- All IP formats are validated before range checking

## CIDR Range Examples

### IPv4 Examples
```bash
# Single IP
192.168.1.100

# Small network (/24)
192.168.1.0/24  # 192.168.1.1 - 192.168.1.254

# Large network (/16)
10.0.0.0/16     # 10.0.0.1 - 10.0.255.254

# Class A network (/8)
10.0.0.0/8      # 10.0.0.1 - 10.255.255.254
```

### IPv6 Examples
```bash
# Single IPv6
2001:db8::1

# IPv6 subnet
2001:db8::/32    # 2001:db8:: - 2001:db8:ffff:ffff:ffff:ffff:ffff:ffff

# IPv6 loopback
::1/128
```

### Mixed IPv4/IPv6
```bash
ADMIN_IP_ALLOWED_RANGES=192.168.1.0/24,2001:db8::/32,::1
```

## Security Best Practices

### 1. Network Segmentation
- Use specific IP ranges rather than broad networks when possible
- Consider using /32 (single IP) for critical admin access
- Separate admin and gateway allowlists for different security requirements

### 2. Proxy Configuration
```nginx
# Nginx example - proper header handling
location /api/ {
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_pass http://backend;
}
```

### 3. Monitoring and Alerting
- All blocked requests are logged with security context
- Monitor logs for patterns of blocked attempts
- Set up alerts for repeated blocks from the same IP ranges

### 4. Regular Review
- Periodically review and update allowed IP ranges
- Remove outdated or unnecessary ranges
- Consider implementing automated range updates for dynamic environments

## Error Responses

### IP Not Allowed (403)
```json
{
  "error": "Forbidden: IP address not allowed",
  "code": "IP_NOT_ALLOWED"
}
```

### Invalid IP Format (400)
```json
{
  "error": "Bad Request: invalid client IP format",
  "code": "INVALID_IP_FORMAT"
}
```

## Logging

### Configuration Logging
- Middleware configuration is logged on startup for audit trail
- Includes number of ranges, proxy trust settings, and enabled status

### Security Events
- **Blocked requests**: Logged with IP, path, method, user agent, and timestamp
- **Invalid IP formats**: Logged with the malformed IP and request context
- **Successful checks**: Debug-level logging for troubleshooting

### Example Security Log Entry
```json
{
  "level": "warn",
  "message": "IP allowlist blocked request",
  "clientIp": "203.0.113.100",
  "path": "/api/admin/users",
  "method": "GET",
  "userAgent": "Mozilla/5.0...",
  "timestamp": "2024-03-26T15:30:00.000Z"
}
```

## Testing

The implementation includes comprehensive tests covering:

- Basic allow/block functionality
- IPv6 support and boundary testing
- Proxy header handling and spoofing resistance
- CIDR boundary conditions (/8, /16, /24, /32)
- Invalid IP format handling
- Security logging verification
- Environment-based configuration

Run tests with:
```bash
npm test -- --testPathPattern=ipAllowlist.test.ts
```

## Deployment Considerations

### Production Deployment
1. Set specific IP ranges for your environment
2. Enable proxy header trust only behind trusted reverse proxies
3. Configure monitoring for blocked requests
4. Test with your actual proxy infrastructure

### Development Environment
- Consider disabling allowlists or using permissive ranges
- Use localhost ranges: `127.0.0.1,::1`
- Test both proxy and non-proxy scenarios

### Container/Docker Deployments
- Include proxy configuration in container networking setup
- Use Docker network CIDRs when allowing container-to-container traffic
- Consider Kubernetes pod/network policies for additional security

## Integration with Existing Security

This IP allowlist complements existing security measures:

1. **Authentication**: Still required for admin endpoints
2. **Rate Limiting**: Applied after IP allowlist checks
3. **Input Validation**: Unaffected by IP checks
4. **HTTPS**: Still required for webhook validation
5. **CORS**: Unaffected by IP allowlist

The IP allowlist is applied **before** authentication, providing efficient early rejection of unauthorized traffic.
