# Authentication Refresh Token Strategy

## Overview

This document outlines the refresh token strategy implemented in the Callora Backend to enhance security and improve user experience by allowing long-lived sessions without compromising security.

## Architecture

### Token Types

1. **Access Token** (JWT)
   - Short-lived (15 minutes default)
   - Contains user ID and optional wallet address
   - Used for API authentication
   - Cannot be revoked (expires naturally)

2. **Refresh Token** (JWT)
   - Long-lived (7 days default)
   - Contains user ID and unique token ID
   - Stored securely in database with hash
   - Can be revoked immediately
   - Used to obtain new access tokens

### Security Features

- **Token Hashing**: Refresh tokens are stored as SHA-256 hashes in the database
- **Token Rotation**: Each refresh generates a new access token
- **Revocation Support**: Refresh tokens can be revoked individually or all at once
- **Rate Limiting**: Token usage is tracked with timestamps
- **Secure Verification**: Multiple layers of token validation

## Implementation Details

### Database Schema

```sql
CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    token_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP WITH TIME ZONE,
    is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
    INDEX idx_refresh_tokens_user_id (user_id),
    INDEX idx_refresh_tokens_expires_at (expires_at),
    INDEX idx_refresh_tokens_hash (token_hash)
);
```

### API Endpoints

#### POST /auth/refresh
Refresh an access token using a valid refresh token.

**Request:**
```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiJ9..."
}
```

**Response:**
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiJ9...",
  "tokenType": "Bearer"
}
```

#### POST /auth/revoke
Revoke a specific refresh token.

**Request:**
```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiJ9..."
}
```

**Response:**
```json
{
  "message": "Token revoked successfully"
}
```

#### POST /auth/revoke-all
Revoke all refresh tokens for the authenticated user.

**Response:**
```json
{
  "message": "All tokens revoked successfully"
}
```

#### GET /auth/tokens
Get information about active tokens for the authenticated user.

**Response:**
```json
{
  "activeRefreshTokens": 2,
  "maxAllowedTokens": 5
}
```

## Security Considerations

### Token Storage
- Refresh tokens must be stored securely on the client (e.g., httpOnly cookies, secure storage)
- Access tokens can be stored in memory or short-term storage
- Never expose refresh tokens in URLs or browser storage

### Token Validation
The system performs multiple validation checks:
1. JWT signature verification
2. Token type validation (access vs refresh)
3. Database record existence
4. Token hash verification
5. Expiration check
6. Revocation status check

### Rate Limiting & Abuse Prevention
- Tokens track last used timestamp
- Automatic cleanup of expired tokens
- Maximum of 5 active refresh tokens per user
- Failed attempts are logged but not exposed to users

### Compromise Response
If a refresh token is compromised:
1. Immediately revoke the specific token: `POST /auth/revoke`
2. Or revoke all tokens: `POST /auth/revoke-all`
3. Monitor token usage logs for suspicious activity

## Migration Strategy

### Current State
- System uses 24-hour JWT tokens with no refresh mechanism
- Tokens must be re-issued daily
- No ability to revoke tokens before expiration

### Migration Steps

1. **Database Migration**
   ```sql
   -- Add refresh_tokens table
   -- See schema section above
   ```

2. **Code Updates**
   - Update auth endpoint to return token pairs
   - Add refresh token service and repository
   - Implement new auth controller methods
   - Add routes for refresh operations

3. **Client Migration**
   - Update clients to handle token pairs
   - Implement automatic token refresh logic
   - Handle token revocation scenarios

4. **Gradual Rollout**
   - Maintain backward compatibility during transition
   - Allow clients to opt-in to refresh token flow
   - Monitor for issues before full rollout

## Configuration

### Environment Variables

```bash
# JWT Configuration
JWT_SECRET=your-super-secret-key

# Token Expiry Times
ACCESS_TOKEN_EXPIRY=15m  # 15 minutes
REFRESH_TOKEN_EXPIRY=7d  # 7 days

# Token Limits
MAX_REFRESH_TOKENS_PER_USER=5
```

### Service Configuration

```typescript
const refreshTokenService = new RefreshTokenService({
  jwtSecret: process.env.JWT_SECRET!,
  accessTokenExpiry: process.env.ACCESS_TOKEN_EXPIRY || '15m',
  refreshTokenExpiry: process.env.REFRESH_TOKEN_EXPIRY || '7d'
});
```

## Testing

### Test Coverage

- ✅ Token creation and validation
- ✅ Refresh token flow
- ✅ Token revocation (individual and all)
- ✅ Security validations (hash verification, expiration)
- ✅ Error handling and edge cases
- ✅ Database operations
- ✅ Rate limiting and cleanup

### Security Tests

- Token substitution attacks
- Token enumeration prevention
- Revoked token rejection
- Expired token handling
- Malformed token rejection

## Monitoring & Logging

### Key Metrics
- Token refresh success/failure rates
- Active token counts per user
- Token revocation events
- Security-related failures

### Log Events
- Successful token refreshes
- Token revocation actions
- Security violations (hash mismatches, revoked tokens)
- Database cleanup operations

## Best Practices

### For Clients
1. Store refresh tokens securely (httpOnly cookies recommended)
2. Implement automatic token refresh before access token expiry
3. Handle token revocation gracefully
4. Limit concurrent refresh attempts
5. Clear tokens on logout

### For Server
1. Always validate tokens through multiple layers
2. Use secure random token generation
3. Implement proper error handling (don't leak token details)
4. Regular cleanup of expired tokens
5. Monitor for unusual token usage patterns

## Troubleshooting

### Common Issues

1. **"Invalid refresh token"**
   - Check token format and signature
   - Verify token hasn't expired
   - Ensure token exists in database

2. **"Token has been revoked"**
   - Token was manually revoked
   - All tokens were revoked for user
   - Security event detected

3. **Database connection errors**
   - Verify database connectivity
   - Check table existence
   - Review permissions

### Debug Information

Enable debug logging to troubleshoot:
```bash
DEBUG=auth:*
```

## Future Enhancements

1. **Token Rotation**: Implement refresh token rotation for enhanced security
2. **Device Management**: Track tokens by device/browser
3. **Anomaly Detection**: AI-powered token usage analysis
4. **Multi-factor Refresh**: Additional verification for sensitive operations
5. **Token Scoping**: Different token types for different permissions

## Compliance

This implementation follows security best practices and is designed to be compliant with:
- OWASP JWT security guidelines
- GDPR data protection requirements
- SOC 2 security controls
- Industry standard authentication patterns
