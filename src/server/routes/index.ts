import type { FastifyInstance } from 'fastify';
import type { ScanJobService } from '../services/scan-job.service.js';
import { registerConfigRoutes } from './config.js';
import { registerBrowseRoutes } from './browse.js';
import { registerScanRoutes } from './scans.js';

export function registerRoutes(app: FastifyInstance, deps: { scans: ScanJobService }): void {
  registerConfigRoutes(app);
  registerBrowseRoutes(app);
  registerScanRoutes(app, deps.scans);
}
