import type { FastifyInstance } from 'fastify';
import type { ScanJobService } from '../services/scan-job.service.js';
import type { AttributionService } from '../services/attribution.service.js';
import { registerConfigRoutes } from './config.js';
import { registerHealthRoutes } from './health.js';
import { registerBrowseRoutes } from './browse.js';
import { registerScanRoutes } from './scans.js';
import { registerAttributionRoutes } from './attribution.js';

export function registerRoutes(
  app: FastifyInstance,
  deps: { scans: ScanJobService; attribution: AttributionService },
): void {
  registerConfigRoutes(app);
  registerHealthRoutes(app);
  registerBrowseRoutes(app);
  registerScanRoutes(app, deps.scans);
  registerAttributionRoutes(app, deps.attribution);
}
