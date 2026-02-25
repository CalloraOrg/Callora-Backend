export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Callora Backend API',
    version: '0.0.1',
    description:
      'API gateway, usage metering, and billing services for the Callora API marketplace.',
  },
  servers: [{ url: 'http://localhost:3000' }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
    schemas: {
      HealthResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', example: 'ok' },
          service: { type: 'string', example: 'callora-backend' },
        },
        required: ['status', 'service'],
      },
      ApisResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          apis: {
            type: 'array',
            items: { type: 'string' },
            example: [],
          },
        },
        required: ['apis'],
      },
      UsageResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          calls: { type: 'number', example: 0 },
          period: { type: 'string', example: 'current' },
        },
        required: ['calls', 'period'],
      },
      ErrorResponse: {
        type: 'object',
        additionalProperties: false,
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['error', 'message'],
      },
    },
  },
  paths: {
    '/api/health': {
      get: {
        summary: 'Health check',
        tags: ['System'],
        responses: {
          200: {
            description: 'Service is healthy',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/HealthResponse' },
              },
            },
          },
        },
      },
    },
    '/api/apis': {
      get: {
        summary: 'List APIs (placeholder)',
        tags: ['APIs'],
        responses: {
          200: {
            description: 'Returns available APIs (currently placeholder)',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ApisResponse' },
              },
            },
          },
        },
      },
    },
    '/api/usage': {
      get: {
        summary: 'Get usage (placeholder)',
        tags: ['Usage'],
        responses: {
          200: {
            description: 'Returns usage summary (currently placeholder)',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UsageResponse' },
              },
            },
          },
        },
      },
    },
  },
} as const;

