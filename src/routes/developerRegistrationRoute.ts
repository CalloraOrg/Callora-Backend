import express from 'express';
import {
  requireAuth,
  type AuthenticatedLocals,
} from "../middleware/requireAuth.js";
import { bodyValidator } from "../middleware/validate.js";
import {
  createApi
} from "../repositories/apiRepository.js";
import {
  findByUserId
} from "../repositories/developerRepository.js";
//import { envelopeValidator } from '../middleware/envelopeValidator.js';
import {
  BadRequestError,
  UnauthorizedError
} from "../errors/index.js";
import {
  getRequestId,
  successEnvelope
} from "../lib/envelope.js";
import { apiRegistrationSchema } from "../validators/apiRegistration.js";
//import * as OpenApiValidator from 'express-openapi-validator';


export function registerDeveloperRegistrationRoute(app: express.Express, lookupDeveloper: typeof findByUserId, persistApi: typeof createApi): void {
  app.post(
    "/api/developers/apis",
    requireAuth,
    bodyValidator(apiRegistrationSchema),
    async (req, res: express.Response<unknown, AuthenticatedLocals>, next) => {
      try {
        const requestId = getRequestId(req);
        const user = res.locals.authenticatedUser;
        if (!user) {
          next(new UnauthorizedError());
          return;
        }

        const payload = apiRegistrationSchema.parse(req.body);

        // Ensure the caller has a developer profile
        const developer = await lookupDeveloper(user.id);
        if (!developer) {
          next(
            new BadRequestError(
              "Developer profile not found. Create a developer profile first.",
              "DEVELOPER_NOT_FOUND",
            ),
          );
          return;
        }

        const api = await persistApi({
          developer_id: developer.id,
          name: payload.name,
          description: payload.description ?? null,
          base_url: payload.base_url,
          category: payload.category,
          status: "active",
          endpoints: payload.endpoints.map((ep) => ({
            path: ep.path,
            method: ep.method,
            price_per_call_usdc: ep.price_per_call_usdc,
            description: ep.description ?? null,
          })),
        });

        res.status(201).json(successEnvelope(api, requestId));
      } catch (err) {
        next(err);
      }
    },
  );

}
