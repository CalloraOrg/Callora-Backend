import request from 'supertest';
import { app } from '../index.js';
import { z } from 'zod';
import { validate, validateWithDetails } from '../middleware/validate.js';
import express from 'express';
import { errorHandler } from '../middleware/errorHandler.js';

describe('Validation Middleware', () => {
  let testApp: express.Application;

  beforeEach(() => {
    testApp = express();
    testApp.use(express.json());
  });

  describe('validate middleware', () => {
    it('should pass validation with valid query parameters', async () => {
      const schema = z.object({
        limit: z.string().transform(Number).pipe(z.number().min(1).max(100)),
        search: z.string().optional()
      });

      testApp.get('/test', validate({ query: schema }), (req, res) => {
        res.json({ success: true, query: req.query });
      });

      const response = await request(testApp)
        .get('/test?limit=10&search=test')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.query.limit).toBe('10'); // Note: strings remain as strings in req.query
    });

    it('should fail validation with invalid query parameters', async () => {
      const schema = z.object({
        limit: z.string().transform(Number).pipe(z.number().min(1).max(100)),
        search: z.string().optional()
      });

      testApp.get('/test', validate({ query: schema }), (req, res) => {
        res.json({ success: true });
      });
      testApp.use(errorHandler);

      const response = await request(testApp)
        .get('/test?limit=0') // Invalid: limit must be >= 1
        .expect(400);

      expect(response.body.error).toBe('Request validation failed');
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(response.body.details).toEqual([
        expect.objectContaining({
          field: 'query.limit',
          code: 'TOO_SMALL',
        }),
      ]);
    });

    it('should pass validation with valid body', async () => {
      const schema = z.object({
        name: z.string().min(2),
        email: z.string().email()
      });

      testApp.post('/test', validate({ body: schema }), (req, res) => {
        res.json({ success: true, body: req.body });
      });

      const response = await request(testApp)
        .post('/test')
        .send({ name: 'John Doe', email: 'john@example.com' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.body.name).toBe('John Doe');
      expect(response.body.body.email).toBe('john@example.com');
    });

    it('should fail validation with invalid body', async () => {
      const schema = z.object({
        name: z.string().min(2),
        email: z.string().email()
      });

      testApp.post('/test', validate({ body: schema }), (req, res) => {
        res.json({ success: true });
      });
      testApp.use(errorHandler);

      const response = await request(testApp)
        .post('/test')
        .send({ name: 'J', email: 'invalid-email' }) // Both fields invalid
        .expect(400);

      expect(response.body.error).toBe('Request validation failed');
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(response.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'body.name' }),
          expect.objectContaining({ field: 'body.email' }),
        ])
      );
    });

    it('should pass validation with valid params', async () => {
      const schema = z.object({
        id: z.string().uuid()
      });

      testApp.get('/test/:id', validate({ params: schema }), (req, res) => {
        res.json({ success: true, params: req.params });
      });

      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      const response = await request(testApp)
        .get(`/test/${uuid}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.params.id).toBe(uuid);
    });

    it('should fail validation with invalid params', async () => {
      const schema = z.object({
        id: z.string().uuid()
      });

      testApp.get('/test/:id', validate({ params: schema }), (req, res) => {
        res.json({ success: true });
      });
      testApp.use(errorHandler);

      const response = await request(testApp)
        .get('/test/invalid-uuid')
        .expect(400);

      expect(response.body.error).toBe('Request validation failed');
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(response.body.details).toEqual([
        expect.objectContaining({ field: 'params.id' }),
      ]);
    });
  });

  describe('validateWithDetails middleware', () => {
    it('should return detailed validation errors', async () => {
      const schema = z.object({
        name: z.string().min(5, 'Name must be at least 5 characters'),
        email: z.string().email('Invalid email format'),
        age: z.number().min(18, 'Must be at least 18 years old')
      });

      testApp.post('/test', validateWithDetails({ body: schema }), (req, res) => {
        res.json({ success: true });
      });

      const response = await request(testApp)
        .post('/test')
        .send({ name: 'John', email: 'invalid-email', age: 16 })
        .expect(400);

      expect(response.body.error).toBe('Request validation failed');
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(response.body.details).toBeDefined();
      expect(Array.isArray(response.body.details)).toBe(true);
      expect(response.body.details.length).toBeGreaterThan(0);

      // Check that details contain field names and messages
      const details = response.body.details;
      expect(details.some((detail: any) => detail.field.includes('body.name'))).toBe(true);
      expect(details.some((detail: any) => detail.field.includes('body.email'))).toBe(true);
      expect(details.some((detail: any) => detail.field.includes('body.age'))).toBe(true);
    });

    it('should format nested array field paths consistently', async () => {
      const schema = z.object({
        endpoints: z.array(
          z.object({
            path: z.string().min(1, 'Path is required'),
          })
        ),
      });

      testApp.post('/test', validateWithDetails({ body: schema }), (_req, res) => {
        res.json({ success: true });
      });

      const response = await request(testApp)
        .post('/test')
        .send({ endpoints: [{}] })
        .expect(400);

      expect(response.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'body.endpoints[0].path',
          }),
        ])
      );
    });
  });

  describe('multiple schema validation', () => {
    it('should validate body, query, and params together', async () => {
      const bodySchema = z.object({
        title: z.string().min(1)
      });

      const querySchema = z.object({
        category: z.string().min(1)
      });

      const paramsSchema = z.object({
        userId: z.string().min(1)
      });

      testApp.post('/users/:userId/posts',
        validate({ body: bodySchema, query: querySchema, params: paramsSchema }),
        (req, res) => {
          res.json({ success: true });
        }
      );
      testApp.use(errorHandler);

      // Should pass with valid data
      await request(testApp)
        .post('/users/user123/posts?category=tech')
        .send({ title: 'My Post' })
        .expect(200);

      // Should fail with invalid body
      const response1 = await request(testApp)
        .post('/users/user123/posts?category=tech')
        .send({ title: '' }) // Empty title
        .expect(400);

      expect(response1.body.error).toBe('Request validation failed');

      // Should fail with invalid query
      const response2 = await request(testApp)
        .post('/users/user123/posts?category=') // Empty category
        .send({ title: 'My Post' })
        .expect(400);

      expect(response2.body.error).toBe('Request validation failed');

      // Should fail with invalid params
      const response3 = await request(testApp)
        .post('/users//posts?category=tech') // Empty userId
        .send({ title: 'My Post' })
        .expect(400);

      expect(response3.body.error).toBe('Request validation failed');
    });
  });
});
