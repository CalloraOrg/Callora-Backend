import Joi from 'joi';
import { Request, Response, NextFunction } from 'express';

export const usageQuerySchema = Joi.object({
  from: Joi.string().isoDate().optional().messages({
    'string.isoDate': 'From date must be a valid ISO date string (YYYY-MM-DDTHH:mm:ss.sssZ)'
  }),
  to: Joi.string().isoDate().optional().messages({
    'string.isoDate': 'To date must be a valid ISO date string (YYYY-MM-DDTHH:mm:ss.sssZ)'
  }),
  limit: Joi.number().integer().min(1).max(1000).optional().messages({
    'number.base': 'Limit must be a number',
    'number.integer': 'Limit must be an integer',
    'number.min': 'Limit must be at least 1',
    'number.max': 'Limit cannot exceed 1000'
  })
}).custom((value, helpers) => {
  if (value.from && value.to) {
    const fromDate = new Date(value.from);
    const toDate = new Date(value.to);
    
    if (fromDate >= toDate) {
      return helpers.error('custom.dateRange', { path: ['from'] });
    }
    
    const maxRange = 365 * 24 * 60 * 60 * 1000; // 1 year in milliseconds
    if (toDate.getTime() - fromDate.getTime() > maxRange) {
      return helpers.error('custom.dateRangeTooLarge', { path: ['from'] });
    }
  }
  
  return value;
}).messages({
  'custom.dateRange': 'From date must be before to date',
  'custom.dateRangeTooLarge': 'Date range cannot exceed 1 year'
});

export const validateUsageQuery = (req: Request, res: Response, next: NextFunction) => {
  const { error, value } = usageQuerySchema.validate(req.query);
  
  if (error) {
    const details = error.details.map(detail => {
      let field = detail.path.join('.');
      let message = detail.message;
      
      // Handle custom validation errors
      if (detail.type === 'custom.dateRange' || detail.type === 'custom.dateRangeTooLarge') {
        field = 'from';
        if (detail.type === 'custom.dateRange') {
          message = 'From date must be before to date';
        } else {
          message = 'Date range cannot exceed 1 year';
        }
      }
      
      return { field, message };
    });
    
    return res.status(400).json({
      error: 'Invalid query parameters',
      details
    });
  }
  
  req.query = value;
  next();
};
