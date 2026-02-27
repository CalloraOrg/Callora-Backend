/**
 * Billing Service
 * 
 * Handles idempotent billing deductions with Soroban integration.
 * Prevents double charges through request_id based idempotency.
 */

import type { Pool } from 'pg';

export interface BillingDeductRequest {
  requestId: string;
  userId: string;
  apiId: string;
  endpointId: string;
  apiKeyId: string;
  amountUsdc: string;
}

export interface BillingDeductResult {
  success: boolean;
  usageEventId: string;
  stellarTxHash?: string;
  alreadyProcessed: boolean;
  error?: string;
}

export interface SorobanClient {
  deductBalance(userId: string, amount: string): Promise<string>;
}

/**
 * Idempotent billing deduction service
 * 
 * Uses request_id as idempotency key to prevent double charges.
 * If usage_events already has a row with the same request_id,
 * returns existing result without calling Soroban again.
 */
export class BillingService {
  constructor(
    private readonly pool: Pool,
    private readonly sorobanClient: SorobanClient
  ) {}

  /**
   * Deducts balance from user account idempotently
   * 
   * @param request - Billing deduction request with unique requestId
   * @returns Result indicating success and whether request was already processed
   * 
   * @example
   * ```typescript
   * const result = await billingService.deduct({
   *   requestId: 'req_abc123',
   *   userId: 'user_xyz',
   *   apiId: 'api_123',
   *   endpointId: 'endpoint_456',
   *   apiKeyId: 'key_789',
   *   amountUsdc: '0.01'
   * });
   * 
   * if (result.alreadyProcessed) {
   *   console.log('Request already processed, no double charge');
   * }
   * ```
   */
  async deduct(request: BillingDeductRequest): Promise<BillingDeductResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Check if request_id already exists (idempotency check)
      const existingEvent = await client.query(
        `SELECT id, stellar_tx_hash 
         FROM usage_events 
         WHERE request_id = $1`,
        [request.requestId]
      );

      if (existingEvent.rows.length > 0) {
        // Request already processed - return existing result
        await client.query('COMMIT');
        return {
          success: true,
          usageEventId: existingEvent.rows[0].id.toString(),
          stellarTxHash: existingEvent.rows[0].stellar_tx_hash,
          alreadyProcessed: true,
        };
      }

      // Insert usage_event first (before calling Soroban)
      // This ensures idempotency even if Soroban call fails
      const insertResult = await client.query(
        `INSERT INTO usage_events 
         (user_id, api_id, endpoint_id, api_key_id, amount_usdc, request_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING id`,
        [
          request.userId,
          request.apiId,
          request.endpointId,
          request.apiKeyId,
          request.amountUsdc,
          request.requestId,
        ]
      );

      const usageEventId = insertResult.rows[0].id.toString();

      // Call Soroban to deduct balance
      let stellarTxHash: string | undefined;
      try {
        stellarTxHash = await this.sorobanClient.deductBalance(
          request.userId,
          request.amountUsdc
        );

        // Update usage_event with Soroban transaction hash
        await client.query(
          `UPDATE usage_events 
           SET stellar_tx_hash = $1 
           WHERE id = $2`,
          [stellarTxHash, usageEventId]
        );
      } catch (sorobanError) {
        // Soroban call failed - rollback transaction
        await client.query('ROLLBACK');
        throw sorobanError;
      }

      await client.query('COMMIT');

      return {
        success: true,
        usageEventId,
        stellarTxHash,
        alreadyProcessed: false,
      };
    } catch (error) {
      await client.query('ROLLBACK');

      // Check if error is due to unique constraint violation
      // This can happen in race conditions
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === '23505' // PostgreSQL unique violation
      ) {
        // Race condition - another request inserted the same request_id
        // Query the existing record and return it
        const existingEvent = await client.query(
          `SELECT id, stellar_tx_hash 
           FROM usage_events 
           WHERE request_id = $1`,
          [request.requestId]
        );

        if (existingEvent.rows.length > 0) {
          return {
            success: true,
            usageEventId: existingEvent.rows[0].id.toString(),
            stellarTxHash: existingEvent.rows[0].stellar_tx_hash,
            alreadyProcessed: true,
          };
        }
      }

      return {
        success: false,
        usageEventId: '',
        alreadyProcessed: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      client.release();
    }
  }

  /**
   * Gets usage event by request ID
   * Useful for checking if a request was already processed
   */
  async getByRequestId(requestId: string): Promise<BillingDeductResult | null> {
    const result = await this.pool.query(
      `SELECT id, stellar_tx_hash 
       FROM usage_events 
       WHERE request_id = $1`,
      [requestId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return {
      success: true,
      usageEventId: result.rows[0].id.toString(),
      stellarTxHash: result.rows[0].stellar_tx_hash,
      alreadyProcessed: true,
    };
  }
}
