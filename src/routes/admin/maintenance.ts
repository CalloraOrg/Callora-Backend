import { Router, Request, Response } from 'express';

export const maintenanceRouter = Router();

// Global runtime state store tracking scheduled maintenance window configuration parameters
export let activeMaintenanceWindow = {
  isEnabled: false,
  startTime: null as string | null,
  endTime: null as string | null,
  reason: '',
};

maintenanceRouter.post('/maintenance', (req: Request, res: Response): void => {
  const { isEnabled, startTime, endTime, reason } = req.body;

  if (typeof isEnabled !== 'boolean') {
    res.status(400).json({ error: 'Property "isEnabled" must be an explicit boolean value.' });
    return;
  }

  if (isEnabled) {
    if (!startTime || !endTime) {
      res.status(400).json({ error: 'startTime and endTime ISO parameters are mandatory when maintenance is active.' });
      return;
    }
    
    // Quick validation check for malformed date formats
    if (isNaN(Date.parse(startTime)) || !isNaN(Number(startTime)) || isNaN(Date.parse(endTime)) || !isNaN(Number(endTime))) {
      res.status(400).json({ error: 'Invalid ISO date strings provided for tracking windows.' });
      return;
    }
  }

  activeMaintenanceWindow = {
    isEnabled,
    startTime: isEnabled ? new Date(startTime).toISOString() : null,
    endTime: isEnabled ? new Date(endTime).toISOString() : null,
    reason: reason || 'Scheduled infrastructure updates.',
  };

  res.status(200).json({ 
    message: 'Maintenance window state configurations updated successfully.', 
    data: activeMaintenanceWindow 
  });
});

maintenanceRouter.get('/maintenance', (req: Request, res: Response) => {
  res.status(200).json(activeMaintenanceWindow);
});